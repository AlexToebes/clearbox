import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
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
import { niceTicks } from "@/lib/chartScale";
import type { DashboardMonth } from "@/lib/dashboard/data";
import { formatMonthLabel } from "@/lib/format";
import { SegmentedControl } from "./SegmentedControl";

const VIEW_OPTIONS: { value: "chart" | "table"; label: string }[] = [
  { value: "chart", label: "Chart" },
  { value: "table", label: "Table" },
];

const chartConfig: ChartConfig = {
  count: { label: "Messages", color: "var(--chart-1)" },
};

/** Show a label on roughly every 3rd bar so 24 months of x-axis ticks
 * don't collide. */
const X_TICK_INTERVAL = 2;

/** `monthly`'s last entry is always the UTC month containing "now" (see
 * `zeroFillMonths` in `lib/dashboard/data.ts`) — i.e. a partial month,
 * still filling up. Labelled "(so far)" so its shorter bar doesn't read
 * as a drop-off. */
function formatMonthCell(month: string, isCurrent: boolean): string {
  const label = formatMonthLabel(month, true);
  return isCurrent ? `${label} (so far)` : label;
}

function MonthlyTooltip({
  active,
  payload,
  currentMonth,
}: TooltipProps<number, string> & { currentMonth: string | null }) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const item = payload[0];
  const row = item?.payload as DashboardMonth | undefined;
  if (!row) {
    return null;
  }

  return (
    <div className="border-border/50 bg-background rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
      <span className="text-foreground font-medium">
        {formatMonthCell(row.month, row.month === currentMonth)} —{" "}
        {row.count.toLocaleString()} messages
      </span>
    </div>
  );
}

function MonthlyTable({
  months,
  currentMonth,
}: {
  months: DashboardMonth[];
  currentMonth: string | null;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground border-b text-left text-xs">
            <th className="py-2 pr-3 font-normal">Month</th>
            <th className="py-2 text-right font-normal">Messages</th>
          </tr>
        </thead>
        <tbody>
          {months.map((month) => (
            <tr key={month.month} className="border-b last:border-0">
              <td className="py-2 pr-3">
                {formatMonthCell(month.month, month.month === currentMonth)}
              </td>
              <td className="py-2 text-right tabular-nums">
                {month.count.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The 24-month mail volume chart (issue #6): thin columns, one per UTC
 * month, with a table view for the exact numbers. */
export function MonthlyVolumeChart({ monthly }: { monthly: DashboardMonth[] }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const currentMonth =
    monthly.length > 0 ? monthly[monthly.length - 1]!.month : null;

  const maxCount = monthly.reduce(
    (max, month) => Math.max(max, month.count),
    0,
  );
  const yTicks = niceTicks(maxCount);
  const yMax = yTicks[yTicks.length - 1] ?? 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mail per month</CardTitle>
        <CardDescription>Last 24 months</CardDescription>
        <CardAction>
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
          <MonthlyTable months={monthly} currentMonth={currentMonth} />
        ) : (
          <ChartContainer config={chartConfig} className="h-[260px] w-full">
            <BarChart
              data={monthly}
              margin={{ top: 8, right: 8, left: 8, bottom: 4 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="month"
                tickFormatter={(value: string) => formatMonthLabel(value)}
                interval={X_TICK_INTERVAL}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                domain={[0, yMax]}
                ticks={yTicks}
                tickFormatter={(value: number) =>
                  Math.round(value).toLocaleString()
                }
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                width={48}
              />
              <ChartTooltip
                content={<MonthlyTooltip currentMonth={currentMonth} />}
                cursor={{ fill: "var(--muted)" }}
              />
              <Bar
                dataKey="count"
                fill="var(--chart-1)"
                radius={[4, 4, 0, 0]}
                maxBarSize={20}
                isAnimationActive={false}
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
