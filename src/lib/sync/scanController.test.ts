import { describe, expect, it, vi } from "vitest";
import { createScanController } from "./scanController";
import type { ScanProgress, ScanResult, ScanStatus } from "./scan";

/** A fake clock: `now()` reads a counter that only moves when the test
 * calls `advance()`. Mirrors the fake clock pattern in
 * `lib/gmail/rateLimiter.test.ts`. */
function createFakeClock(): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = 0;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function makeProgress(overrides: Partial<ScanProgress>): ScanProgress {
  return {
    phase: "scanning",
    total: 0,
    listed: 0,
    alreadyCached: 0,
    fetched: 0,
    skippedDeleted: 0,
    ...overrides,
  };
}

const SCAN_RESULT: ScanResult = {
  accountEmail: "alex@example.com",
  fetched: 10,
  alreadyCached: 0,
  skippedDeleted: 0,
  historyId: "h1",
};

const STATUS_AFTER_SCAN: ScanStatus = {
  accountEmail: "alex@example.com",
  lastFullScanAt: 12345,
  inProgress: false,
};

/**
 * A fake `runScan` that hands back a promise the test settles by hand
 * (`resolveLatest`/`rejectLatest`), and captures each call's `onProgress`
 * so the test can emit progress events manually. Also wires the real
 * abort-rejects-the-promise behavior `runFullScan` has, so `cancel()` can
 * be exercised the same way it would against the real thing.
 */
function createFakeRunScan(): {
  runScan: (opts: {
    signal: AbortSignal;
    onProgress: (p: ScanProgress) => void;
  }) => Promise<ScanResult>;
  calls: { signal: AbortSignal; onProgress: (p: ScanProgress) => void }[];
  emitProgress: (p: ScanProgress) => void;
  resolveLatest: (result?: ScanResult) => void;
  rejectLatest: (err: unknown) => void;
} {
  const calls: {
    signal: AbortSignal;
    onProgress: (p: ScanProgress) => void;
  }[] = [];
  let resolveCurrent: ((result: ScanResult) => void) | null = null;
  let rejectCurrent: ((err: unknown) => void) | null = null;

  const runScan = vi.fn(
    (opts: { signal: AbortSignal; onProgress: (p: ScanProgress) => void }) => {
      calls.push(opts);
      return new Promise<ScanResult>((resolve, reject) => {
        resolveCurrent = resolve;
        rejectCurrent = reject;
        opts.signal.addEventListener(
          "abort",
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- mirroring runFullScan's own abort behavior (see scan.test.ts).
          () => reject(opts.signal.reason),
          { once: true },
        );
      });
    },
  );

  return {
    runScan,
    calls,
    emitProgress: (p) => calls[calls.length - 1]!.onProgress(p),
    resolveLatest: (result = SCAN_RESULT) => resolveCurrent?.(result),
    rejectLatest: (err) => rejectCurrent?.(err),
  };
}

/** Waits for currently-pending microtasks to flush. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createScanController", () => {
  it("starts idle with no status", () => {
    const { now } = createFakeClock();
    const controller = createScanController({
      runScan: createFakeRunScan().runScan,
      loadStatus: () => Promise.resolve(STATUS_AFTER_SCAN),
      now,
    });

    expect(controller.getState()).toEqual({
      status: null,
      run: { kind: "idle" },
      dataVersion: 0,
    });
  });

  it("getState is referentially stable when nothing has changed", () => {
    const { now } = createFakeClock();
    const controller = createScanController({
      runScan: createFakeRunScan().runScan,
      loadStatus: () => Promise.resolve(STATUS_AFTER_SCAN),
      now,
    });

    expect(controller.getState()).toBe(controller.getState());
  });

  it("start() transitions idle -> running -> idle, reloading status", async () => {
    const { now } = createFakeClock();
    const fake = createFakeRunScan();
    const loadStatus = vi
      .fn<() => Promise<ScanStatus>>()
      .mockResolvedValue(STATUS_AFTER_SCAN);
    const controller = createScanController({
      runScan: fake.runScan,
      loadStatus,
      now,
    });

    controller.start();
    expect(controller.getState().run.kind).toBe("running");
    expect(fake.runScan).toHaveBeenCalledTimes(1);

    fake.resolveLatest();
    await flush();

    expect(controller.getState()).toEqual({
      status: STATUS_AFTER_SCAN,
      run: { kind: "idle" },
      dataVersion: 1,
    });
    // Only reloaded once the run actually completed.
    expect(loadStatus).toHaveBeenCalledTimes(1);
  });

  it("ignores a second start() while one is already running", () => {
    const { now } = createFakeClock();
    const fake = createFakeRunScan();
    const controller = createScanController({
      runScan: fake.runScan,
      loadStatus: () => Promise.resolve(STATUS_AFTER_SCAN),
      now,
    });

    controller.start();
    controller.start();
    controller.start();

    expect(fake.runScan).toHaveBeenCalledTimes(1);
  });

  it("cancel() aborts the run and settles into cancelled, not error", async () => {
    const { now } = createFakeClock();
    const fake = createFakeRunScan();
    const controller = createScanController({
      runScan: fake.runScan,
      loadStatus: () => Promise.resolve(STATUS_AFTER_SCAN),
      now,
    });

    controller.start();
    expect(fake.calls[0]!.signal.aborted).toBe(false);

    controller.cancel();
    expect(fake.calls[0]!.signal.aborted).toBe(true);
    await flush();

    expect(controller.getState().run).toEqual({ kind: "cancelled" });
    // Cancelling doesn't reload status.
    expect(controller.getState().status).toBeNull();
  });

  it("a genuine failure surfaces as run: { kind: 'error' }", async () => {
    const { now } = createFakeClock();
    const fake = createFakeRunScan();
    const controller = createScanController({
      runScan: fake.runScan,
      loadStatus: () => Promise.resolve(STATUS_AFTER_SCAN),
      now,
    });

    controller.start();
    const boom = new Error("boom");
    fake.rejectLatest(boom);
    await flush();

    expect(controller.getState().run).toEqual({ kind: "error", error: boom });
  });

  it("throttles dataVersion bumps to once per 2s while pages land, and always bumps on completion", async () => {
    const clock = createFakeClock();
    const fake = createFakeRunScan();
    const controller = createScanController({
      runScan: fake.runScan,
      loadStatus: () => Promise.resolve(STATUS_AFTER_SCAN),
      now: clock.now,
    });

    controller.start();
    expect(controller.getState().dataVersion).toBe(0);

    // First page lands: always bumps, however soon.
    fake.emitProgress(makeProgress({ listed: 500 }));
    expect(controller.getState().dataVersion).toBe(1);

    // Same page's mid-page progress emits (listed unchanged): no bump.
    fake.emitProgress(makeProgress({ listed: 500, fetched: 50 }));
    expect(controller.getState().dataVersion).toBe(1);

    // Next page lands too soon after the last bump (throttled).
    clock.advance(500);
    fake.emitProgress(makeProgress({ listed: 1000 }));
    expect(controller.getState().dataVersion).toBe(1);

    // Enough time has passed since the last bump: this page's landing
    // bumps again.
    clock.advance(2000);
    fake.emitProgress(makeProgress({ listed: 1500 }));
    expect(controller.getState().dataVersion).toBe(2);

    // Completion always bumps, regardless of throttling.
    fake.resolveLatest();
    await flush();
    expect(controller.getState().dataVersion).toBe(3);
  });

  it("bumps dataVersion on cancellation and on error too", async () => {
    const { now } = createFakeClock();

    const cancelledFake = createFakeRunScan();
    const cancelledController = createScanController({
      runScan: cancelledFake.runScan,
      loadStatus: () => Promise.resolve(STATUS_AFTER_SCAN),
      now,
    });
    cancelledController.start();
    cancelledController.cancel();
    await flush();
    expect(cancelledController.getState().dataVersion).toBe(1);

    const erroredFake = createFakeRunScan();
    const erroredController = createScanController({
      runScan: erroredFake.runScan,
      loadStatus: () => Promise.resolve(STATUS_AFTER_SCAN),
      now,
    });
    erroredController.start();
    erroredFake.rejectLatest(new Error("boom"));
    await flush();
    expect(erroredController.getState().dataVersion).toBe(1);
  });

  it("refreshStatus() loads status without touching run state", async () => {
    const { now } = createFakeClock();
    const loadStatus = vi
      .fn<() => Promise<ScanStatus>>()
      .mockResolvedValue(STATUS_AFTER_SCAN);
    const controller = createScanController({
      runScan: createFakeRunScan().runScan,
      loadStatus,
      now,
    });

    await controller.refreshStatus();

    expect(controller.getState()).toEqual({
      status: STATUS_AFTER_SCAN,
      run: { kind: "idle" },
      dataVersion: 0,
    });
  });

  it("notifies subscribers on every state change, and stops after unsubscribing", async () => {
    const { now } = createFakeClock();
    const fake = createFakeRunScan();
    const controller = createScanController({
      runScan: fake.runScan,
      loadStatus: () => Promise.resolve(STATUS_AFTER_SCAN),
      now,
    });

    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);

    controller.start();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    fake.resolveLatest();
    await flush();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("dispose() cancels the run and ignores anything that settles afterward", async () => {
    const { now } = createFakeClock();
    const fake = createFakeRunScan();
    const controller = createScanController({
      runScan: fake.runScan,
      loadStatus: () => Promise.resolve(STATUS_AFTER_SCAN),
      now,
    });

    const listener = vi.fn();
    controller.subscribe(listener);
    controller.start();
    listener.mockClear();

    controller.dispose();
    expect(fake.calls[0]!.signal.aborted).toBe(true);

    fake.emitProgress(makeProgress({ listed: 500 }));
    fake.resolveLatest();
    await flush();

    expect(listener).not.toHaveBeenCalled();
    // A disposed controller no longer starts new runs either.
    controller.start();
    expect(fake.runScan).toHaveBeenCalledTimes(1);
  });
});
