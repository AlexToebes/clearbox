/**
 * Full mailbox scan (issue #4): enumerates every message in the mailbox via
 * `messages.list`, skips ids already cached, and fetches metadata for the
 * rest with a bounded worker pool. See "Sync" in `docs/ARCHITECTURE.md`.
 *
 * The scan is resumable: each page's rows are committed with a single
 * `upsertMessages` call, so an interruption (abort, crash, closed app)
 * loses at most one page of work, and a re-run of `runFullScan` picks up
 * where it left off by skipping ids that are already cached.
 */

import type { Db } from "@/lib/db/db";
import {
  clearCache,
  deleteSyncState,
  getKnownIds,
  getSyncState,
  setSyncState,
  SYNC_KEYS,
  upsertMessages,
} from "@/lib/db/queries";
import type { MessageRow } from "@/lib/db/types";
import type { GmailClient } from "@/lib/gmail/client";
import { toMessageRow } from "@/lib/gmail/parse";

/** Ids fetched per `messages.list` page (Gmail's own per-page maximum). */
const PAGE_SIZE = 500;
/** How often (in messages fetched) to emit progress mid-page, so a large
 * page doesn't go silent for the whole worker pool run. */
const PROGRESS_FETCH_INTERVAL = 50;
/** Default number of concurrent `getMessageMetadata` calls. */
const DEFAULT_CONCURRENCY = 10;

export interface ScanProgress {
  phase: "starting" | "scanning" | "done";
  /** `profile.messagesTotal` — Gmail's own estimate of the mailbox size. */
  total: number;
  /** Ids seen so far via `messages.list`, across all pages. */
  listed: number;
  /** Of `listed`, how many were already cached (and so skipped). */
  alreadyCached: number;
  /** Metadata fetched and stored so far this run. */
  fetched: number;
  /** Listed ids whose `getMessageMetadata` came back 404 (deleted since
   * being listed). */
  skippedDeleted: number;
}

export interface ScanOptions {
  gmail: Pick<
    GmailClient,
    "getProfile" | "listMessageIds" | "getMessageMetadata"
  >;
  db: Db;
  now: () => number;
  signal?: AbortSignal;
  /** Concurrent `getMessageMetadata` calls. Defaults to 10. */
  concurrency?: number;
  onProgress?: (progress: ScanProgress) => void;
}

export interface ScanResult {
  accountEmail: string;
  fetched: number;
  alreadyCached: number;
  skippedDeleted: number;
  /** The Gmail `historyId` incremental sync (issue #5) should resume from:
   * the id the scan started at, not the (later) one the mailbox is at by
   * the time the scan finishes — messages already cached by this run could
   * have changed in between, and incremental sync needs to replay from
   * before any of that could have happened. */
  historyId: string;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason;
  }
}

/**
 * Runs (or resumes) a full mailbox scan. See the module doc comment and
 * "Sync" in `docs/ARCHITECTURE.md` for the algorithm; in short:
 *
 * 1. `getProfile`; if the cached mailbox belongs to a different account,
 *    wipe it first (`clearCache`).
 * 2. Pin `scan_start_history_id` to the *first* attempt's `historyId` (a
 *    resumed scan keeps the original value).
 * 3. Page through `messages.list`, fetching metadata for any id not
 *    already cached and upserting each page as it completes.
 * 4. On the last page, promote `scan_start_history_id` to `history_id`,
 *    clear it, and stamp `last_full_scan_at`.
 *
 * Aborting `signal` stops promptly (no new `messages.list`/`get` calls are
 * started; in-flight ones receive the same signal), leaves rows from
 * already-committed pages in place, and rejects with `signal`'s abort
 * reason without writing `history_id`/`last_full_scan_at` — a later call
 * resumes the same scan. Any other error (e.g. `GmailApiError`) propagates
 * the same way.
 */
export async function runFullScan(opts: ScanOptions): Promise<ScanResult> {
  const { gmail, db, now, signal, onProgress } = opts;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  throwIfAborted(signal);

  const profile = await gmail.getProfile(signal);

  const storedEmail = await getSyncState(db, SYNC_KEYS.accountEmail);
  if (storedEmail !== null && storedEmail !== profile.emailAddress) {
    await clearCache(db);
  }
  await setSyncState(db, SYNC_KEYS.accountEmail, profile.emailAddress);

  let scanStartHistoryId = await getSyncState(db, SYNC_KEYS.scanStartHistoryId);
  if (scanStartHistoryId === null) {
    scanStartHistoryId = profile.historyId;
    await setSyncState(db, SYNC_KEYS.scanStartHistoryId, scanStartHistoryId);
  }

  const total = profile.messagesTotal;
  let listed = 0;
  let alreadyCached = 0;
  let fetched = 0;
  let skippedDeleted = 0;
  let fetchedSinceEmit = 0;

  function emit(phase: ScanProgress["phase"]): void {
    onProgress?.({
      phase,
      total,
      listed,
      alreadyCached,
      fetched,
      skippedDeleted,
    });
  }

  emit("starting");

  let pageToken: string | undefined;
  for (;;) {
    throwIfAborted(signal);

    const page = await gmail.listMessageIds({
      pageToken,
      maxResults: PAGE_SIZE,
      signal,
    });
    listed += page.ids.length;

    const known = await getKnownIds(db, page.ids);
    alreadyCached += known.size;
    const unknownIds = page.ids.filter((id) => !known.has(id));

    const pageRows: MessageRow[] = [];
    let nextIndex = 0;

    async function worker(): Promise<void> {
      for (;;) {
        throwIfAborted(signal);
        const index = nextIndex;
        if (index >= unknownIds.length) {
          return;
        }
        nextIndex += 1;

        const id = unknownIds[index]!;
        const message = await gmail.getMessageMetadata(id, signal);
        if (message === null) {
          skippedDeleted += 1;
        } else {
          pageRows.push(toMessageRow(message));
          fetched += 1;
        }

        fetchedSinceEmit += 1;
        if (fetchedSinceEmit >= PROGRESS_FETCH_INTERVAL) {
          fetchedSinceEmit = 0;
          emit("scanning");
        }
      }
    }

    const workerCount = Math.min(concurrency, unknownIds.length);
    // A rejection here (abort, or any other error) is left to propagate:
    // this page's rows were never upserted, so at most one page of
    // already-fetched-but-uncommitted work is lost, matching the module
    // doc comment.
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (pageRows.length > 0) {
      await upsertMessages(db, pageRows);
    }
    emit("scanning");

    if (page.nextPageToken === null) {
      break;
    }
    pageToken = page.nextPageToken;
  }

  await setSyncState(db, SYNC_KEYS.historyId, scanStartHistoryId);
  await deleteSyncState(db, SYNC_KEYS.scanStartHistoryId);
  await setSyncState(db, SYNC_KEYS.lastFullScanAt, String(now()));
  emit("done");

  return {
    accountEmail: profile.emailAddress,
    fetched,
    alreadyCached,
    skippedDeleted,
    historyId: scanStartHistoryId,
  };
}

export interface ScanStatus {
  accountEmail: string | null;
  /** Milliseconds since the epoch, or `null` if no full scan has ever
   * finished. */
  lastFullScanAt: number | null;
  /** Whether `scan_start_history_id` is set — a scan started but didn't
   * reach its last page (interrupted, or simply still running). */
  inProgress: boolean;
}

/** Reads the full-scan status the UI shows (last scan time, whether one is
 * mid-flight) without running anything. */
export async function getScanStatus(db: Db): Promise<ScanStatus> {
  const [accountEmail, lastFullScanAtRaw, scanStartHistoryId] =
    await Promise.all([
      getSyncState(db, SYNC_KEYS.accountEmail),
      getSyncState(db, SYNC_KEYS.lastFullScanAt),
      getSyncState(db, SYNC_KEYS.scanStartHistoryId),
    ]);

  return {
    accountEmail,
    lastFullScanAt:
      lastFullScanAtRaw !== null ? Number(lastFullScanAtRaw) : null,
    inProgress: scanStartHistoryId !== null,
  };
}
