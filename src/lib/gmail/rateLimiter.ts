/**
 * Token-bucket rate limiter used to stay under the Gmail API's per-user
 * quota (250 units/second; see "Sync" in `docs/ARCHITECTURE.md`). Tokens
 * refill continuously (not in discrete per-second ticks), so sustained
 * throughput tracks `unitsPerSecond` smoothly rather than bursting once a
 * second and idling the rest of it.
 */

/** Gmail API quota cost per call, in "units":
 * https://developers.google.com/gmail/api/reference/quota */
export const GMAIL_QUOTA_UNITS = {
  getProfile: 1,
  messagesList: 5,
  messagesGet: 5,
  historyList: 2,
  messagesBatchModify: 50,
} as const;

/** Google's per-user limit is 250 units/second; we keep some headroom so a
 * handful of concurrent requests never tips over it. */
export const DEFAULT_GMAIL_UNITS_PER_SECOND = 200;

export interface RateLimiterDeps {
  /** Steady-state refill rate, in quota units per second. */
  unitsPerSecond: number;
  /** Maximum tokens the bucket can hold, and so the largest single
   * `acquire()` it can ever satisfy. Defaults to `unitsPerSecond` (i.e. up
   * to one second's worth of quota can be spent in a single burst). */
  burst?: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface RateLimiter {
  /**
   * Resolves once `units` tokens have been deducted from the bucket,
   * sleeping as needed for them to refill. Concurrent callers are served
   * FIFO — a caller is queued behind every `acquire()` that started before
   * it, so a request for many units can't be starved by a steady stream of
   * smaller ones cutting in line while it waits.
   *
   * Rejects synchronously (before joining the queue) if `units` exceeds
   * the bucket's burst capacity, since no amount of waiting could ever
   * satisfy it. Rejects with `signal`'s abort reason if `signal` aborts
   * while this call is queued or sleeping; the waiter is removed from the
   * queue so it doesn't run later.
   */
  acquire(units: number, signal?: AbortSignal): Promise<void>;
}

/** Resolves after `ms` (via `sleep`), or rejects with `signal.reason` if
 * `signal` aborts first. Never leaves a dangling abort listener once
 * settled either way. Shared with `gmail/client.ts`, whose retry backoff
 * needs the same abort-while-sleeping behavior. */
export function sleepAbortable(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    return sleep(ms);
  }
  if (signal.aborted) {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- `reason` is whatever the caller's AbortController was given (typically a DOMException, but not statically an Error).
    return Promise.reject(signal.reason);
  }

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      settled = true;
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see above.
      reject(signal.reason);
    };
    let settled = false;
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms).then(
      () => {
        if (!settled) {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }
      },
      (err: unknown) => {
        if (!settled) {
          signal.removeEventListener("abort", onAbort);
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- passing through whatever `sleep()` itself rejected with.
          reject(err);
        }
      },
    );
  });
}

/** Creates a token-bucket `RateLimiter` backed by `deps`. */
export function createRateLimiter(deps: RateLimiterDeps): RateLimiter {
  const { unitsPerSecond, now, sleep } = deps;
  const burst = deps.burst ?? unitsPerSecond;

  let tokens = burst;
  let lastRefillMs = now();

  // FIFO queue of callers waiting for their turn to look at `tokens`. Only
  // the caller "in turn" (either running immediately, or the one at the
  // front of `queue` once woken) may read/consume the bucket; everyone
  // else just waits here. That serialization is what gives fairness: a
  // caller stuck sleeping for a big request isn't skipped over by later,
  // smaller requests that arrive while it waits.
  const queue: (() => void)[] = [];
  let inTurn = false;

  function refill(): void {
    const nowMs = now();
    const elapsedMs = Math.max(0, nowMs - lastRefillMs);
    tokens = Math.min(burst, tokens + (elapsedMs / 1000) * unitsPerSecond);
    lastRefillMs = nowMs;
  }

  function finishTurn(): void {
    const next = queue.shift();
    if (next) {
      next();
    } else {
      inTurn = false;
    }
  }

  /** Resolves once it's this caller's turn (having claimed `inTurn`). If
   * `signal` aborts before then, rejects and removes this caller from the
   * queue so `finishTurn()` never calls it. */
  function waitForTurn(signal: AbortSignal | undefined): Promise<void> {
    if (!inTurn) {
      inTurn = true;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const entry = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      queue.push(entry);

      const onAbort = () => {
        const index = queue.indexOf(entry);
        if (index !== -1) {
          // Still waiting: drop out of line.
          queue.splice(index, 1);
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see sleepAbortable above.
          reject(signal!.reason);
        }
        // Otherwise `entry` already ran and this caller now owns the
        // turn — its own token-wait loop below will observe the abort.
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function acquire(units: number, signal?: AbortSignal): Promise<void> {
    if (units > burst) {
      throw new Error(
        `createRateLimiter.acquire: requested ${units} units exceeds burst capacity ${burst}`,
      );
    }
    if (signal?.aborted) {
      throw signal.reason;
    }

    await waitForTurn(signal);
    try {
      for (;;) {
        refill();
        if (tokens >= units) {
          tokens -= units;
          return;
        }
        const waitMs = ((units - tokens) / unitsPerSecond) * 1000;
        await sleepAbortable(sleep, waitMs, signal);
      }
    } finally {
      finishTurn();
    }
  }

  return { acquire };
}
