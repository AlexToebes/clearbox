import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
import type { DashboardBarMetric } from "@/lib/dashboard/data";
import type { SenderGroupBy, SenderStats } from "@/lib/db/queries";
import { formatBytes } from "@/lib/format";
import { SegmentedControl } from "./SegmentedControl";

const ROW_HEIGHT_PX = 28;
const CHART_ROWS = 15;
const CATEGORY_LABEL_MAX_CHARS = 26;

const METRIC_OPTIONS: { value: DashboardBarMetric; label: string }[] = [
  { value: "count", label: "Messages" },
  { value: "size", label: "Storage" },
  { value: "unread", label: "Unread" },
];

const VIEW_OPTIONS: { value: "chart" | "table"; label: string }[] = [
  { value: "chart", label: "Chart" },
  { value: "table", label: "Table" },
];

const METRIC_LABELS: Record<DashboardBarMetric, string> = {
  count: "Messages",
  size: "Storage",
  unread: "Unread",
};

function metricValue(sender: SenderStats, metric: DashboardBarMetric): number {
  switch (metric) {
    case "count":
      return sender.messageCount;
    case "size":
      return sender.totalBytes;
    case "unread":
      return sender.unreadCount;
  }
}

function formatMetricValue(value: number, metric: DashboardBarMetric): string {
  return metric === "size" ? formatBytes(value) : value.toLocaleString();
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

interface ChartRow {
  key: string;
  displayName: string;
  categoryLabel: string;
  value: number;
}

const dateFormatter = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

function TopSendersTooltip({
  active,
  payload,
  metric,
}: TooltipProps<number, string> & { metric: DashboardBarMetric }) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const item = payload[0];
  const row = item?.payload as ChartRow | undefined;
  if (!row) {
    return null;
  }

  return (
    <div className="border-border/50 bg-background grid gap-1 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
      <div className="text-foreground font-medium">{row.displayName}</div>
      <div className="text-muted-foreground">{row.key}</div>
      <div className="text-foreground tabular-nums">
        {METRIC_LABELS[metric]}: {formatMetricValue(row.value, metric)}
      </div>
    </div>
  );
}

function TopSendersTable({
  senders,
  groupBy,
}: {
  senders: SenderStats[];
  groupBy: SenderGroupBy;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground border-b text-left text-xs">
            <th className="py-2 pr-3 font-normal">Name</th>
            <th className="py-2 pr-3 font-normal">
              {groupBy === "domain" ? "Domain" : "Email"}
            </th>
            <th className="py-2 pr-3 text-right font-normal">Messages</th>
            <th className="py-2 pr-3 text-right font-normal">Unread</th>
            <th className="py-2 pr-3 text-right font-normal">Storage</th>
            <th className="py-2 text-right font-normal">Last message</th>
          </tr>
        </thead>
        <tbody>
          {senders.map((sender) => (
            <tr key={sender.key} className="border-b last:border-0">
              <td className="max-w-[220px] truncate py-2 pr-3">
                {sender.displayName}
              </td>
              <td className="text-muted-foreground max-w-[200px] truncate py-2 pr-3">
                {sender.key}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {sender.messageCount.toLocaleString()}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {sender.unreadCount.toLocaleString()}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {formatBytes(sender.totalBytes)}
              </td>
              <td className="py-2 text-right tabular-nums">
                {dateFormatter.format(new Date(sender.lastDate))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The ranked top-senders bar chart (issue #6): 15 senders/domains as
 * horizontal bars, with a metric toggle that drives both the ranking and
 * the tip labels, and a table view carrying the full detail. */
export function TopSendersChart({
  senders,
  groupBy,
  barMetric,
  onBarMetricChange,
}: {
  senders: SenderStats[];
  groupBy: SenderGroupBy;
  barMetric: DashboardBarMetric;
  onBarMetricChange: (metric: DashboardBarMetric) => void;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const noun = groupBy === "domain" ? "domains" : "senders";

  const chartData: ChartRow[] = senders.map((sender) => ({
    key: sender.key,
    displayName: sender.displayName,
    categoryLabel: truncate(sender.displayName, CATEGORY_LABEL_MAX_CHARS),
    value: metricValue(sender, barMetric),
  }));

  const chartConfig: ChartConfig = {
    value: { label: METRIC_LABELS[barMetric], color: "var(--chart-1)" },
  };

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>
          Top {noun.charAt(0).toUpperCase() + noun.slice(1)}
        </CardTitle>
        <CardDescription>
          Ranked by {METRIC_LABELS[barMetric].toLowerCase()}
        </CardDescription>
        <CardAction className="flex flex-col items-end gap-2">
          <SegmentedControl
            aria-label="Rank by"
            options={METRIC_OPTIONS}
            value={barMetric}
            onChange={onBarMetricChange}
          />
          <SegmentedControl
            aria-label="View"
            options={VIEW_OPTIONS}
            value={view}
            onChange={setView}
          />
        </CardAction>
      </CardHeader>
      <CardContent>
        {view === "table" ? (
          <TopSendersTable senders={senders} groupBy={groupBy} />
        ) : (
          <ChartContainer
            config={chartConfig}
            style={{ height: CHART_ROWS * ROW_HEIGHT_PX }}
            className="w-full"
          >
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 4, right: 64, left: 4, bottom: 4 }}
            >
              <CartesianGrid horizontal={false} vertical={false} />
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="categoryLabel"
                width={150}
                tickLine={false}
                axisLine={false}
                interval={0}
              />
              <ChartTooltip
                content={<TopSendersTooltip metric={barMetric} />}
                cursor={{ fill: "var(--muted)" }}
              />
              <Bar
                dataKey="value"
                fill="var(--chart-1)"
                radius={[0, 4, 4, 0]}
                barSize={18}
                isAnimationActive={false}
              >
                <LabelList
                  dataKey="value"
                  position="right"
                  className="fill-muted-foreground"
                  fontSize={12}
                  formatter={(value: number) =>
                    formatMetricValue(value, barMetric)
                  }
                />
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
