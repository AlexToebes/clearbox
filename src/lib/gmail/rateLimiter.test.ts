import { describe, expect, it } from "vitest";
import {
  createRateLimiter,
  DEFAULT_GMAIL_UNITS_PER_SECOND,
  GMAIL_QUOTA_UNITS,
} from "./rateLimiter";

/** A fake clock + sleep where `sleep(ms)` advances the clock by exactly
 * `ms` before resolving, so time-based assertions are exact and tests run
 * instantly. Records every requested delay. */
function createFakeTime(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  delays: number[];
} {
  let current = 0;
  const delays: number[] = [];
  return {
    now: () => current,
    sleep: (ms: number) => {
      delays.push(ms);
      current += ms;
      return Promise.resolve();
    },
    delays,
  };
}

describe("GMAIL_QUOTA_UNITS / DEFAULT_GMAIL_UNITS_PER_SECOND", () => {
  it("matches Google's published per-call quota costs", () => {
    expect(GMAIL_QUOTA_UNITS).toEqual({
      getProfile: 1,
      messagesList: 5,
      messagesGet: 5,
      historyList: 2,
      messagesBatchModify: 50,
    });
  });

  it("keeps headroom under Google's 250 units/s per-user limit", () => {
    expect(DEFAULT_GMAIL_UNITS_PER_SECOND).toBe(200);
    expect(DEFAULT_GMAIL_UNITS_PER_SECOND).toBeLessThan(250);
  });
});

describe("createRateLimiter", () => {
  it("acquires immediately when enough tokens are available", async () => {
    const { now, sleep, delays } = createFakeTime();
    const limiter = createRateLimiter({ unitsPerSecond: 10, now, sleep });

    await limiter.acquire(5);
    await limiter.acquire(5);

    expect(delays).toEqual([]);
  });

  it("sleeps exactly the time needed for tokens to refill, then re-checks", async () => {
    const { now, sleep, delays } = createFakeTime();
    // burst = 10, so the bucket starts full and the first acquire is free.
    const limiter = createRateLimiter({ unitsPerSecond: 10, now, sleep });

    await limiter.acquire(10); // drains the bucket to 0
    await limiter.acquire(5); // needs 5 more units at 10/s -> 500ms

    expect(delays).toEqual([500]);
    expect(now()).toBe(500);
  });

  it("defaults burst to unitsPerSecond", async () => {
    const { now, sleep, delays } = createFakeTime();
    const limiter = createRateLimiter({ unitsPerSecond: 20, now, sleep });

    await limiter.acquire(20); // exactly burst capacity: fine, no sleep
    expect(delays).toEqual([]);
  });

  it("rejects a request for more units than the burst capacity", async () => {
    const { now, sleep } = createFakeTime();
    const limiter = createRateLimiter({
      unitsPerSecond: 10,
      burst: 20,
      now,
      sleep,
    });

    await expect(limiter.acquire(21)).rejects.toThrow(/burst capacity/);
  });

  it("sustains throughput at approximately unitsPerSecond over many acquires", async () => {
    const { now, sleep } = createFakeTime();
    const limiter = createRateLimiter({
      unitsPerSecond: 10,
      burst: 10,
      now,
      sleep,
    });

    const totalUnits = 500;
    const perCall = 5;
    const burst = 10;
    for (let i = 0; i < totalUnits / perCall; i++) {
      await limiter.acquire(perCall);
    }

    // The first `burst` units are free (already in the bucket); the rest
    // are paced at exactly unitsPerSecond, regardless of how the total was
    // chunked into individual acquire() calls.
    expect(now()).toBe(((totalUnits - burst) / 10) * 1000);
  });

  it("serves concurrent callers FIFO, so a big request isn't starved by smaller ones", async () => {
    const { now, sleep } = createFakeTime();
    const limiter = createRateLimiter({
      unitsPerSecond: 10,
      burst: 10,
      now,
      sleep,
    });

    const order: string[] = [];
    await limiter.acquire(10); // drain the bucket up front

    // Three callers race to acquire at (roughly) the same time: a big one
    // first, then two small ones. FIFO means the big one is served first
    // even though the small ones could otherwise squeeze in immediately
    // once *some* tokens refill.
    const big = limiter.acquire(10).then(() => order.push("big"));
    const small1 = limiter.acquire(1).then(() => order.push("small1"));
    const small2 = limiter.acquire(1).then(() => order.push("small2"));

    await Promise.all([big, small1, small2]);
    expect(order).toEqual(["big", "small1", "small2"]);
  });

  it("aborting a queued (not-yet-in-turn) caller rejects it without disturbing others", async () => {
    const { now, sleep } = createFakeTime();
    const limiter = createRateLimiter({
      unitsPerSecond: 10,
      burst: 10,
      now,
      sleep,
    });

    await limiter.acquire(10); // drain the bucket

    const controller = new AbortController();
    const order: string[] = [];

    // `first` occupies the turn (it'll be sleeping for tokens); `aborted`
    // queues behind it and gets cancelled before its turn comes; `last`
    // queues behind `aborted` and should still complete once `first` is
    // done, unaffected by `aborted`'s cancellation.
    const first = limiter.acquire(10).then(() => order.push("first"));
    const aborted = limiter
      .acquire(1, controller.signal)
      .catch((err: unknown) => {
        order.push("aborted");
        return err;
      });
    const last = limiter.acquire(1).then(() => order.push("last"));

    controller.abort();
    const abortResult: unknown = await aborted;
    expect(abortResult).toBeInstanceOf(DOMException);
    expect((abortResult as DOMException).name).toBe("AbortError");

    await Promise.all([first, last]);
    expect(order).toEqual(["aborted", "first", "last"]);
  });

  it("aborting while sleeping for tokens rejects promptly with the abort reason", async () => {
    const { now } = createFakeTime();
    const hangingSleep = () => new Promise<void>(() => {}); // never resolves on its own
    const limiter = createRateLimiter({
      unitsPerSecond: 10,
      burst: 10,
      now,
      sleep: hangingSleep,
    });

    await limiter.acquire(10); // drain the bucket (immediate: tokens == burst)

    const controller = new AbortController();
    const pending = limiter.acquire(5, controller.signal);

    // Let acquire() run forward to (and register) its abort-aware sleep
    // before aborting.
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(DOMException);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const { now, sleep, delays } = createFakeTime();
    const limiter = createRateLimiter({ unitsPerSecond: 10, now, sleep });
    const controller = new AbortController();
    controller.abort();

    await expect(limiter.acquire(1, controller.signal)).rejects.toBeInstanceOf(
      DOMException,
    );
    expect(delays).toEqual([]);
  });
});
