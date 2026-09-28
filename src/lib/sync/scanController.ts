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
  /** Starts a scan. A no-op if one is already running. */
  start(): void;
  /** Aborts the in-progress run, if any. The run settles into
   * `{ kind: "cancelled" }` once its promise actually rejects — this call
   * itself doesn't change `getState()` synchronously. */
  cancel(): void;
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

  function start(): void {
    if (disposed || state.run.kind === "running") {
      return;
    }

    const controller = new AbortController();
    activeController = controller;
    const startedAt = deps.now();
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

    setState({
      ...state,
      run: { kind: "running", progress: INITIAL_PROGRESS, startedAt },
    });

    void deps
      .runScan({ signal: controller.signal, onProgress })
      .then(async () => {
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
      })
      .catch((err: unknown) => {
        if (isStale()) {
          return;
        }
        // We're the only ones who ever abort `controller`, so if it's
        // aborted this rejection is the cancellation we asked for, not a
        // genuine failure — regardless of what `err` actually is.
        const run: ScanRunState = controller.signal.aborted
          ? { kind: "cancelled" }
          : { kind: "error", error: err };
        setState({ ...state, run, dataVersion: state.dataVersion + 1 });
      })
      .finally(() => {
        if (activeController === controller) {
          activeController = null;
        }
      });
  }

  function cancel(): void {
    activeController?.abort();
  }

  function dispose(): void {
    cancel();
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
