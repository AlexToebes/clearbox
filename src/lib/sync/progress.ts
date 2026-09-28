/**
 * Turns a raw `ScanProgress` (see `lib/sync/scan.ts`) into the numbers the
 * UI actually shows: how many messages have been accounted for, a percent
 * complete, and (once there's enough signal) an ETA. Kept separate from
 * `scan.ts` so it can be unit tested independently of the scan itself.
 */

import type { ScanProgress } from "./scan";

/** Fetched-or-skipped messages needed this run before we trust the
 * observed rate enough to show an ETA. */
const MIN_FETCHED_FOR_ETA = 20;
/** Elapsed time needed before we trust the observed rate enough to show an
 * ETA. */
const MIN_ELAPSED_MS_FOR_ETA = 3000;

/** The rate limiter's default budget (200 units/s) divided by
 * `messages.get`'s cost (5 units) — the steady-state throughput a full
 * scan can sustain once it's fetching metadata back-to-back. */
export const ASSUMED_MESSAGES_PER_SECOND = 40;

export interface ScanProgressSummary {
  /** Messages this run has finished dealing with one way or another:
   * already cached (skipped), freshly fetched, or fetched but since
   * deleted. */
  processed: number;
  /** `max(p.total, processed)` — Gmail's `messagesTotal` is only an
   * estimate, and also counts Spam/Trash, which the scan excludes, so
   * `processed` can end up exceeding it. */
  total: number;
  /** 0–100. Only ever 100 once `p.phase === "done"`; otherwise capped at
   * 99 so the bar doesn't read "complete" while work remains. */
  percent: number;
  /** Estimated time remaining, in milliseconds, or `null` until there's
   * enough signal to trust it (see `MIN_FETCHED_FOR_ETA`/
   * `MIN_ELAPSED_MS_FOR_ETA`). */
  etaMs: number | null;
}

/** Derives the UI-facing scan summary from a raw `ScanProgress` and how
 * long the current run has been going. */
export function describeProgress(
  p: ScanProgress,
  elapsedMs: number,
): ScanProgressSummary {
  const processed = p.alreadyCached + p.fetched + p.skippedDeleted;
  const total = Math.max(p.total, processed);

  const percent =
    p.phase === "done"
      ? 100
      : Math.min(99, total > 0 ? Math.floor((processed / total) * 100) : 0);

  const fetchedThisRun = p.fetched + p.skippedDeleted;
  let etaMs: number | null = null;
  if (
    fetchedThisRun >= MIN_FETCHED_FOR_ETA &&
    elapsedMs >= MIN_ELAPSED_MS_FOR_ETA
  ) {
    const rate = fetchedThisRun / elapsedMs; // messages per millisecond
    const remaining = Math.max(0, total - processed);
    etaMs = remaining / rate;
  }

  return { processed, total, percent, etaMs };
}

/**
 * Renders a duration for people: "less than a minute" under a minute,
 * "about N min" under an hour, otherwise "about H h M min" (or just
 * "about H h" when there's no leftover minutes).
 */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);

  if (totalMinutes < 1) {
    return "less than a minute";
  }
  if (totalMinutes < 60) {
    return `about ${totalMinutes} min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `about ${hours} h ${minutes} min` : `about ${hours} h`;
}

/** Estimates how long a full scan of a mailbox this size will take,
 * assuming a steady `ASSUMED_MESSAGES_PER_SECOND` throughput. */
export function estimateFullScanMs(messagesTotal: number): number {
  return (messagesTotal / ASSUMED_MESSAGES_PER_SECOND) * 1000;
}
