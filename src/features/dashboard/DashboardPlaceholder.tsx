import { useEffect, useState } from "react";
import { getServices } from "@/app/services";
import { getSummary } from "@/lib/db/queries";
import { useScan } from "@/features/sync/useScan";

/**
 * Stands in for the real dashboard (issue #6): a single line summarizing
 * what's cached locally so far, re-queried whenever the scan controller's
 * `dataVersion` changes. Renders nothing until there's anything cached.
 */
export function DashboardPlaceholder() {
  const { dataVersion } = useScan();
  const [summary, setSummary] = useState<{
    totalMessages: number;
    distinctSenders: number;
  } | null>(null);

  useEffect(() => {
    const services = getServices();
    if (!services) {
      return;
    }
    let cancelled = false;

    services
      .getDb()
      .then((db) => getSummary(db))
      .then((result) => {
        if (!cancelled) {
          setSummary(result);
        }
      })
      .catch(() => {
        // The dashboard is a placeholder; a failed re-query just leaves
        // the last-known summary (or nothing) showing rather than erroring
        // the whole shell.
      });

    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  if (!summary || summary.totalMessages === 0) {
    return null;
  }

  return (
    <p className="text-muted-foreground text-sm">
      {summary.totalMessages.toLocaleString()} messages from{" "}
      {summary.distinctSenders.toLocaleString()} senders cached locally — the
      dashboard is coming in #6.
    </p>
  );
}
