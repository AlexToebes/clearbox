import { useEffect, useState } from "react";
import { getServices } from "@/app/services";
import { useScan } from "@/features/sync/useScan";
import { loadDashboard, type DashboardData } from "@/lib/dashboard/data";
import type { SenderGroupBy } from "@/lib/db/queries";
import { SegmentedControl } from "./SegmentedControl";
import { StatTiles } from "./StatTiles";

const GROUP_BY_OPTIONS: { value: SenderGroupBy; label: string }[] = [
  { value: "email", label: "Senders" },
  { value: "domain", label: "Domains" },
];

// The top-senders bar chart's metric toggle (Messages/Storage/Unread) is
// added in a later commit; until then the chart it will drive doesn't
// exist yet, so `loadDashboard` is always asked for the "count" ranking.
const DEFAULT_BAR_METRIC = "count";

/** Simple muted blocks standing in for each card while the first load is
 * in flight — sized to roughly match the layout they'll be replaced by. */
function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="bg-muted h-9 w-48 animate-pulse rounded-lg" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="bg-muted h-24 animate-pulse rounded-xl" />
        ))}
      </div>
    </div>
  );
}

/**
 * The mailbox insights dashboard (issue #6): a grouping filter, KPI tiles,
 * and (added in later commits) the top-senders share donut, ranked
 * top-senders chart and monthly volume chart — all backed by one
 * `loadDashboard` call, re-run whenever the scan's `dataVersion`, the
 * grouping or the bar-chart metric changes. Renders nothing until there's
 * anything cached. Replaces `DashboardPlaceholder`.
 */
export function Dashboard() {
  const { dataVersion, status, run } = useScan();
  const [groupBy, setGroupBy] = useState<SenderGroupBy>("email");
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    const services = getServices();
    if (!services) {
      return;
    }
    let cancelled = false;

    services
      .getDb()
      .then((db) =>
        loadDashboard(db, {
          groupBy,
          barMetric: DEFAULT_BAR_METRIC,
          now: Date.now(),
        }),
      )
      .then((result) => {
        if (!cancelled) {
          setData(result);
        }
      })
      .catch(() => {
        // Leave the last-known data (or the skeleton) showing rather than
        // erroring the whole shell over a re-query failure.
      });

    return () => {
      cancelled = true;
    };
  }, [dataVersion, groupBy]);

  if (data === null) {
    return <DashboardSkeleton />;
  }

  if (data.summary.totalMessages === 0) {
    return null;
  }

  const scanIncomplete = run.kind === "running" || status?.inProgress === true;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          aria-label="Group by"
          options={GROUP_BY_OPTIONS}
          value={groupBy}
          onChange={setGroupBy}
        />
        {scanIncomplete && (
          <p className="text-muted-foreground text-sm">
            Numbers update as the scan runs.
          </p>
        )}
      </div>
      <StatTiles summary={data.summary} />
    </div>
  );
}
