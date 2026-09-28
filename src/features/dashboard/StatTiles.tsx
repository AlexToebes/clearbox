import { Card, CardContent } from "@/components/ui/card";
import type { CacheSummary } from "@/lib/db/queries";
import { formatBytes, formatCompact, formatPercent } from "@/lib/format";

interface Tile {
  label: string;
  value: string;
  subLine?: string;
}

function buildTiles(summary: CacheSummary): Tile[] {
  const unreadShare =
    summary.totalMessages > 0
      ? summary.unreadMessages / summary.totalMessages
      : 0;

  return [
    { label: "Messages", value: formatCompact(summary.totalMessages) },
    {
      label: "Unread",
      value: formatCompact(summary.unreadMessages),
      subLine: `${formatPercent(unreadShare)} of messages`,
    },
    { label: "Storage", value: formatBytes(summary.totalBytes) },
    { label: "Senders", value: formatCompact(summary.distinctSenders) },
    {
      label: "Can unsubscribe",
      value: formatCompact(summary.sendersWithUnsubscribe),
      subLine: "senders with an unsubscribe link",
    },
  ];
}

/** The dashboard's KPI row (issue #6): five small tiles — label, value,
 * optional sub-line — over the cache summary. */
export function StatTiles({ summary }: { summary: CacheSummary }) {
  const tiles = buildTiles(summary);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((tile) => (
        <Card key={tile.label} className="gap-1 py-4">
          <CardContent className="flex flex-col gap-1 px-4">
            <span className="text-muted-foreground text-sm">{tile.label}</span>
            <span className="text-2xl font-semibold tabular-nums">
              {tile.value}
            </span>
            {tile.subLine && (
              <span className="text-muted-foreground text-xs">
                {tile.subLine}
              </span>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
