/**
 * Wires the real platform implementations (`lib/platform/*`) into the
 * `lib/auth` and `lib/gmail` layers. This is the only UI-side module
 * allowed to do that wiring — everything under `src/features/` and
 * `src/app/` should go through `getServices()` rather than constructing an
 * `AuthSession`/`GmailClient` itself.
 */

import { createAuthSession, type AuthSession } from "@/lib/auth/session";
import { getGoogleConfig } from "@/lib/config";
import type { Db } from "@/lib/db/db";
import { clearCache } from "@/lib/db/queries";
import { createGmailClient, type GmailClient } from "@/lib/gmail/client";
import { httpFetch } from "@/lib/platform/http";
import { keychainSecretStore } from "@/lib/platform/keychain";
import { startLoopbackListener } from "@/lib/platform/oauth";
import { openExternalUrl } from "@/lib/platform/opener";
import { openDatabase } from "@/lib/platform/sql";
import { getScanStatus, runFullScan } from "@/lib/sync/scan";
import {
  createScanController,
  type ScanController,
} from "@/lib/sync/scanController";

export interface Services {
  auth: AuthSession;
  gmail: GmailClient;
  /** Opens (once) and returns the app's local SQLite database. */
  getDb: () => Promise<Db>;
  scan: ScanController;
  /** Cancels any in-progress scan, wipes the local mail cache
   * (`clearCache`), then signs out. Use this instead of `auth.signOut()`
   * directly so a switch of Google account never leaves the previous
   * account's messages sitting in the local database. */
  signOutAndClear: () => Promise<void>;
}

let services: Services | null = null;

/** Builds the scan controller, wiring `runFullScan`/`getScanStatus` up to
 * `getDb`/`gmail` (see "Sync" in `docs/ARCHITECTURE.md`). */
function createScan(
  gmail: GmailClient,
  getDb: () => Promise<Db>,
): ScanController {
  return createScanController({
    runScan: async ({ signal, onProgress }) => {
      const db = await getDb();
      return runFullScan({ gmail, db, now: Date.now, signal, onProgress });
    },
    loadStatus: async () => getScanStatus(await getDb()),
    now: Date.now,
  });
}

/**
 * Builds (once) and returns the app's `AuthSession`/`GmailClient`/database/
 * scan-controller bundle, or `null` if the Google OAuth client isn't
 * configured (`getGoogleConfig()`).
 */
export function getServices(): Services | null {
  if (services) {
    return services;
  }

  const config = getGoogleConfig();
  if (!config) {
    return null;
  }

  const auth = createAuthSession({
    fetch: httpFetch,
    secrets: keychainSecretStore,
    now: Date.now,
    openUrl: openExternalUrl,
    startLoopbackListener,
    config,
  });

  const gmail = createGmailClient({
    fetch: httpFetch,
    getAccessToken: () => auth.getAccessToken(),
    invalidateAccessToken: () => auth.invalidateAccessToken(),
  });

  let dbPromise: Promise<Db> | null = null;
  function getDb(): Promise<Db> {
    if (!dbPromise) {
      dbPromise = openDatabase();
    }
    return dbPromise;
  }

  const scan = createScan(gmail, getDb);

  // A signed-out session has nothing to scan, and no valid access token to
  // scan with — cancel any run in flight rather than let it fail on its
  // next Gmail call.
  auth.subscribe(() => {
    if (auth.status() === "signed_out") {
      void scan.cancel();
    }
  });

  async function signOutAndClear(): Promise<void> {
    // Wait for the in-progress attempt (if any) to fully stop — including
    // any write it was in the middle of — before wiping the cache, so
    // that write can never land after `clearCache` and leave a trace of
    // the previous account behind.
    await scan.cancel();
    const db = await getDb();
    await clearCache(db);
    await auth.signOut();
  }

  services = { auth, gmail, getDb, scan, signOutAndClear };
  return services;
}
