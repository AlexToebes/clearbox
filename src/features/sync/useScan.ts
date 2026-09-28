/**
 * React binding for the app's `ScanController` (see
 * `lib/sync/scanController.ts`): subscribes via `useSyncExternalStore` and
 * kicks off a `refreshStatus()` on mount so the panel doesn't sit on
 * `status: null` until something else happens to trigger a load.
 */

import { useEffect, useSyncExternalStore } from "react";
import { getServices } from "@/app/services";
import type { ScanControllerState } from "@/lib/sync/scanController";

const IDLE_STATE: ScanControllerState = {
  status: null,
  run: { kind: "idle" },
  dataVersion: 0,
};

export interface UseScanResult extends ScanControllerState {
  /** No-op if a scan is already running, or if the app has no configured
   * Google OAuth client. */
  start: () => void;
  /** Resolves once the in-progress run (if any) has fully stopped. A
   * no-op that resolves immediately if nothing is running. */
  cancel: () => Promise<void>;
}

export function useScan(): UseScanResult {
  const scan = getServices()?.scan;

  const state = useSyncExternalStore(
    (onStoreChange) => scan?.subscribe(onStoreChange) ?? (() => {}),
    () => scan?.getState() ?? IDLE_STATE,
  );

  useEffect(() => {
    void scan?.refreshStatus();
  }, [scan]);

  return {
    ...state,
    start: () => scan?.start(),
    cancel: () => scan?.cancel() ?? Promise.resolve(),
  };
}
