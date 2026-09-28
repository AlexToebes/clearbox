/**
 * Loads everything the insights dashboard (issue #6) renders in one shot:
 * the KPI summary, the top-senders "share" donut, the ranked top-senders
 * list, and 24 months of zero-filled volume — each a thin wrapper around
 * `lib/db/queries.ts` so the dashboard itself only ever deals in plain data.
 */

import type { Db } from "@/lib/db/db";
import {
  getMonthlyVolume,
  getSenders,
  getSummary,
  type CacheSummary,
  type SenderGroupBy,
  type SenderStats,
} from "@/lib/db/queries";

/** The metric the top-senders bar chart is ranked/labelled by. Shares the
 * same spelling as `SenderSortBy`'s non-`"latest"` members on purpose. */
export type DashboardBarMetric = "count" | "size" | "unread";

export interface ShareSegment {
  /** The sender email/domain this segment represents, or a sentinel
   * (`"__other__"`) for the rolled-up remainder. */
  key: string;
  label: string;
  count: number;
  isOther: boolean;
}

export interface DashboardShare {
  segments: ShareSegment[];
  total: number;
}

export interface DashboardMonth {
  /** `YYYY-MM`, UTC. */
  month: string;
  count: number;
}

export interface DashboardData {
  summary: CacheSummary;
  share: DashboardShare;
  topSenders: SenderStats[];
  monthly: DashboardMonth[];
}

export interface LoadDashboardOptions {
  groupBy: SenderGroupBy;
  barMetric: DashboardBarMetric;
  /** Epoch ms "now" — the monthly chart's 24-month window ends at this
   * instant's UTC month. Passed in rather than read from `Date.now()` so
   * it's deterministic in tests. */
  now: number;
}

const TOP_SENDERS_LIMIT = 15;
const SHARE_SEGMENTS = 4;
const MONTHLY_WINDOW_MONTHS = 24;

/** Loads all four sections of dashboard data in parallel. */
export async function loadDashboard(
  db: Db,
  opts: LoadDashboardOptions,
): Promise<DashboardData> {
  const [summary, topSenders, shareSenders, monthlyRows] = await Promise.all([
    getSummary(db),
    getSenders(db, {
      groupBy: opts.groupBy,
      sortBy: opts.barMetric,
      limit: TOP_SENDERS_LIMIT,
    }),
    // The share donut always ranks by message count, independent of
    // `barMetric` — it answers "who sends the most mail", not "who's
    // biggest by whatever metric the bar chart happens to show".
    getSenders(db, {
      groupBy: opts.groupBy,
      sortBy: "count",
      limit: SHARE_SEGMENTS,
    }),
    getMonthlyVolume(db),
  ]);

  return {
    summary,
    share: buildShare(shareSenders, summary.totalMessages),
    topSenders,
    monthly: zeroFillMonths(monthlyRows, opts.now, MONTHLY_WINDOW_MONTHS),
  };
}

function buildShare(
  topByCount: SenderStats[],
  totalMessages: number,
): DashboardShare {
  const segments: ShareSegment[] = topByCount.map((sender) => ({
    key: sender.key,
    label: sender.displayName,
    count: sender.messageCount,
    isOther: false,
  }));

  const topSum = segments.reduce((sum, segment) => sum + segment.count, 0);
  const other = totalMessages - topSum;
  if (other > 0) {
    segments.push({
      key: "__other__",
      label: "Other",
      count: other,
      isOther: true,
    });
  }

  return { segments, total: totalMessages };
}

function monthKey(year: number, monthIndex0: number): string {
  return `${String(year).padStart(4, "0")}-${String(monthIndex0 + 1).padStart(2, "0")}`;
}

/** Builds exactly `windowSize` consecutive UTC months ending at `now`'s
 * month (inclusive), filling in `0` for any month `rows` has no entry
 * for. */
function zeroFillMonths(
  rows: { month: string; count: number }[],
  now: number,
  windowSize: number,
): DashboardMonth[] {
  const counts = new Map(rows.map((row) => [row.month, row.count]));

  const end = new Date(now);
  // `endYear * 12 + endMonth` is a month index that increments cleanly
  // across year boundaries, so subtracting `i` and re-deriving
  // year/month below never has to special-case January.
  const endMonthIndex = end.getUTCFullYear() * 12 + end.getUTCMonth();

  const months: DashboardMonth[] = [];
  for (let i = windowSize - 1; i >= 0; i--) {
    const absoluteMonth = endMonthIndex - i;
    const year = Math.floor(absoluteMonth / 12);
    const monthIndex0 = ((absoluteMonth % 12) + 12) % 12;
    const key = monthKey(year, monthIndex0);
    months.push({ month: key, count: counts.get(key) ?? 0 });
  }

  return months;
}
