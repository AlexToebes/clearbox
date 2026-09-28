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

function MonthlyTooltip({ active, payload }: TooltipProps<number, string>) {
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
        {formatMonthLabel(row.month, true)} — {row.count.toLocaleString()}{" "}
        messages
      </span>
    </div>
  );
}

function MonthlyTable({ months }: { months: DashboardMonth[] }) {
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
                {formatMonthLabel(month.month, true)}
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
          <MonthlyTable months={monthly} />
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
                tickFormatter={(value: number) =>
                  Math.round(value).toLocaleString()
                }
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                width={48}
              />
              <ChartTooltip
                content={<MonthlyTooltip />}
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
