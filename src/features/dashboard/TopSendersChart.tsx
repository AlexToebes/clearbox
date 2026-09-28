import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  XAxis,
  YAxis,
  type LabelProps,
  type TooltipProps,
} from "recharts";
import {
  Card,
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

interface BarViewBox {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/**
 * A tip label rendered manually (rather than via `LabelList`'s default
 * text renderer) because that default wraps onto two lines for short
 * bars — it treats the *bar's* width as the text's wrap width, which is
 * far too narrow for a label meant to sit to the right of the bar.
 */
function renderValueLabel(metric: DashboardBarMetric) {
  return function ValueLabel(props: LabelProps) {
    const viewBox = props.viewBox as BarViewBox | undefined;
    const x = viewBox?.x ?? 0;
    const y = viewBox?.y ?? 0;
    const width = viewBox?.width ?? 0;
    const height = viewBox?.height ?? 0;
    const value =
      typeof props.value === "number" ? props.value : Number(props.value ?? 0);

    return (
      <text
        x={x + width + 6}
        y={y + height / 2}
        dy={4}
        textAnchor="start"
        fontSize={12}
        className="fill-muted-foreground"
      >
        {formatMetricValue(value, metric)}
      </text>
    );
  };
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

// Fixed percentage widths (rather than per-cell `max-w`) so the table
// always fits its card without a `<td>`'s intrinsic content width
// starving its neighbors — the failure mode that squeezed the numeric
// columns down to a few unreadable pixels.
const SENDER_COL_WIDTH = "40%";
const NUMERIC_COL_WIDTH = "12%";
const DATE_COL_WIDTH = "16%";

function TopSendersTable({
  senders,
  groupBy,
}: {
  senders: SenderStats[];
  groupBy: SenderGroupBy;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed text-sm">
        <colgroup>
          <col style={{ width: SENDER_COL_WIDTH }} />
          <col style={{ width: NUMERIC_COL_WIDTH }} />
          <col style={{ width: NUMERIC_COL_WIDTH }} />
          <col style={{ width: NUMERIC_COL_WIDTH }} />
          <col style={{ width: DATE_COL_WIDTH }} />
        </colgroup>
        <thead>
          <tr className="text-muted-foreground border-b text-left text-xs">
            <th className="py-2 pr-3 font-normal">
              {groupBy === "domain" ? "Domain" : "Sender"}
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
              <td className="py-2 pr-3">
                <div className="truncate">{sender.displayName}</div>
                {sender.key !== sender.displayName && (
                  <div className="text-muted-foreground truncate text-xs">
                    {sender.key}
                  </div>
                )}
              </td>
              <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
                {sender.messageCount.toLocaleString()}
              </td>
              <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
                {sender.unreadCount.toLocaleString()}
              </td>
              <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
                {formatBytes(sender.totalBytes)}
              </td>
              <td className="py-2 text-right whitespace-nowrap tabular-nums">
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
  const title = `Top ${noun}`;

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
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>
              Ranked by {METRIC_LABELS[barMetric].toLowerCase()}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
          </div>
        </div>
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
                width={185}
                tick={{ fontSize: 12 }}
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
                  content={renderValueLabel(barMetric)}
                />
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
