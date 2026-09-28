/**
 * External store (for React's `useSyncExternalStore`) that drives a full
 * mailbox scan (`runFullScan` in `lib/sync/scan.ts`): starts/cancels a run,
 * tracks its progress, and reloads `ScanStatus` once it settles. See
 * "Sync" in `docs/ARCHITECTURE.md`.
 *
 * Kept free of any platform/UI dependency — `runScan` and `loadStatus` are
 * injected — so it's unit-testable without Tauri or React (see
 * `lib/auth/session.ts` for the same subscribe/status pattern).
 */

import type { ScanProgress, ScanResult, ScanStatus } from "./scan";

/** How often, at most, a page completing during a run bumps
 * `dataVersion` — frequent enough that the dashboard feels live, rare
 * enough that a fast scan doesn't re-query the DB on every page. */
const DATA_VERSION_THROTTLE_MS = 2000;

/** The progress shown for the moment a run starts, before its first
 * `onProgress` callback arrives. */
const INITIAL_PROGRESS: ScanProgress = {
  phase: "starting",
  total: 0,
  listed: 0,
  alreadyCached: 0,
  fetched: 0,
  skippedDeleted: 0,
};

export type ScanRunState =
  | { kind: "idle" }
  | { kind: "running"; progress: ScanProgress; startedAt: number }
  | { kind: "error"; error: unknown }
  | { kind: "cancelled" };

export interface ScanControllerState {
  /** `null` until `refreshStatus()`/a completed run has loaded one. */
  status: ScanStatus | null;
  run: ScanRunState;
  /** Bumped whenever locally cached mail data may have changed — a run
   * completing/erroring/being cancelled, or (throttled) a page finishing
   * mid-run — so consumers know to re-query the DB. */
  dataVersion: number;
}

export interface ScanControllerDeps {
  runScan: (opts: {
    signal: AbortSignal;
    onProgress: (progress: ScanProgress) => void;
  }) => Promise<ScanResult>;
  loadStatus: () => Promise<ScanStatus>;
  now: () => number;
}

export interface ScanController {
  /** Returns the current snapshot. Referentially identical to the
   * previous call's result when nothing has changed, as
   * `useSyncExternalStore` requires. */
  getState(): ScanControllerState;
  /** Registers `listener` to be called whenever the snapshot changes.
   * Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Reloads `status` from `loadStatus()` without starting a run. */
  refreshStatus(): Promise<void>;
  /** Starts a scan. A no-op while one is already actively running.
   * Called while a previous run is still settling after `cancel()` (i.e.
   * before that run's promise has resolved), it's queued instead — the
   * new run begins only once the old one has fully stopped, and `run`
   * reads as `"running"` continuously in the meantime rather than
   * flickering through `"cancelled"`. */
  start(): void;
  /** Aborts the in-progress run, if any, and resolves once that attempt
   * has fully settled — including any write it was in the middle of —
   * and the resulting state update has been applied. Resolves
   * immediately if nothing is running. Safe to call without awaiting
   * when that's not needed. */
  cancel(): Promise<void>;
  /** Cancels any run and stops notifying listeners. Safe to call more
   * than once. */
  dispose(): void;
}

/** Creates a `ScanController` backed by `deps`. */
export function createScanController(deps: ScanControllerDeps): ScanController {
  let state: ScanControllerState = {
    status: null,
    run: { kind: "idle" },
    dataVersion: 0,
  };
  const listeners = new Set<() => void>();
  let activeController: AbortController | null = null;
  /** The currently in-flight attempt's settle promise, captured by
   * `cancel()` so it can hand back exactly that attempt's completion —
   * not whatever attempt happens to be running by the time it resolves. */
  let activeRunSettled: Promise<void> | null = null;
  /** Set when `start()` is called while the previous attempt is still
   * settling after being aborted — consumed once that attempt finishes,
   * to begin a fresh one right away instead of overlapping it. */
  let pendingStart = false;
  let disposed = false;

  function setState(next: ScanControllerState): void {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  }

  async function refreshStatus(): Promise<void> {
    const status = await deps.loadStatus();
    if (disposed) {
      return;
    }
    setState({ ...state, status });
  }

  /** Runs one scan attempt end to end: emits progress, and on settling
   * either applies the resulting state (idle/error/cancelled) or, if a
   * `start()` came in while this attempt was being cancelled, chains
   * straight into a new attempt without ever reporting anything other
   * than `"running"`. */
  async function runAttempt(
    controller: AbortController,
    startedAt: number,
  ): Promise<void> {
    let lastEmittedListed = 0;
    // -Infinity so the very first page that completes always bumps
    // `dataVersion`, regardless of how soon it lands.
    let lastBumpAt = -Infinity;

    function isStale(): boolean {
      return disposed || activeController !== controller;
    }

    function onProgress(progress: ScanProgress): void {
      if (isStale()) {
        return;
      }

      let dataVersion = state.dataVersion;
      if (progress.listed > lastEmittedListed) {
        lastEmittedListed = progress.listed;
        const t = deps.now();
        if (t - lastBumpAt >= DATA_VERSION_THROTTLE_MS) {
          lastBumpAt = t;
          dataVersion += 1;
        }
      }

      setState({
        ...state,
        run: { kind: "running", progress, startedAt },
        dataVersion,
      });
    }

    try {
      await deps.runScan({ signal: controller.signal, onProgress });
      if (isStale()) {
        return;
      }
      const status = await deps.loadStatus();
      if (isStale()) {
        return;
      }
      setState({
        status,
        run: { kind: "idle" },
        dataVersion: state.dataVersion + 1,
      });
    } catch (err) {
      if (disposed) {
        return;
      }
      // We're the only ones who ever abort `controller`, so if it's
      // aborted this rejection is the cancellation we asked for, not a
      // genuine failure — regardless of what `err` actually is.
      const wasAborted = controller.signal.aborted;
      if (pendingStart) {
        if (!wasAborted) {
          // A genuine failure, not our own cancellation — surface it
          // even though a start() also came in around the same time
          // (pendingStart is otherwise only ever set alongside an abort
          // we ourselves requested, so this is a defensive fallback).
          setState({
            ...state,
            run: { kind: "error", error: err },
            dataVersion: state.dataVersion + 1,
          });
          pendingStart = false;
        }
        // Else: leave `run` exactly as it was ("running") — the chained
        // attempt below picks it back up without ever reporting
        // "cancelled" in between.
      } else {
        const run: ScanRunState = wasAborted
          ? { kind: "cancelled" }
          : { kind: "error", error: err };
        setState({ ...state, run, dataVersion: state.dataVersion + 1 });
      }
    } finally {
      if (activeController === controller) {
        activeController = null;
      }
    }

    if (!disposed && pendingStart) {
      pendingStart = false;
      beginRun();
    }
  }

  function beginRun(): void {
    const controller = new AbortController();
    activeController = controller;
    const startedAt = deps.now();

    setState({
      ...state,
      run: { kind: "running", progress: INITIAL_PROGRESS, startedAt },
    });

    activeRunSettled = runAttempt(controller, startedAt);
  }

  function start(): void {
    if (disposed) {
      return;
    }
    if (state.run.kind === "running") {
      if (activeController?.signal.aborted) {
        pendingStart = true;
      }
      // Otherwise a genuine run is already active: ignore, same as a
      // plain double `start()`.
      return;
    }
    beginRun();
  }

  function cancel(): Promise<void> {
    const settled = activeRunSettled ?? Promise.resolve();
    activeController?.abort();
    return settled;
  }

  function dispose(): void {
    void cancel();
    disposed = true;
    listeners.clear();
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refreshStatus,
    start,
    cancel,
    dispose,
  };
}
