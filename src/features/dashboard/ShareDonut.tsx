import { Cell, Pie, PieChart, type TooltipProps } from "recharts";
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
import type { DashboardShare, ShareSegment } from "@/lib/dashboard/data";
import type { SenderGroupBy } from "@/lib/db/queries";
import { formatCompact, formatPercent } from "@/lib/format";

/** The fixed color slot order for the top 4 segments (never cycled, never
 * reassigned) — see `src/index.css`. `Other` always gets the dedicated
 * neutral, regardless of its position. */
const SEGMENT_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
] as const;
const OTHER_COLOR = "var(--chart-other)";

interface ColoredSegment extends ShareSegment {
  color: string;
}

function colorSegments(segments: ShareSegment[]): ColoredSegment[] {
  let colorIndex = 0;
  return segments.map((segment) => ({
    ...segment,
    color: segment.isOther
      ? OTHER_COLOR
      : (SEGMENT_COLORS[colorIndex++] ?? OTHER_COLOR),
  }));
}

function ShareTooltip({
  active,
  payload,
  total,
}: TooltipProps<number, string> & { total: number }) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const item = payload[0];
  if (!item) {
    return null;
  }

  const label = typeof item.name === "string" ? item.name : "";
  const count = typeof item.value === "number" ? item.value : 0;
  const color = typeof item.color === "string" ? item.color : undefined;
  const percent = total > 0 ? count / total : 0;

  return (
    <div className="border-border/50 bg-background grid gap-1 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
      <div className="text-foreground flex items-center gap-1.5 font-medium">
        {color && (
          <span
            className="h-2 w-2 shrink-0 rounded-[2px]"
            style={{ backgroundColor: color }}
          />
        )}
        {label}
      </div>
      <div className="text-muted-foreground">
        {count.toLocaleString()} messages · {formatPercent(percent)}
      </div>
    </div>
  );
}

function ShareLegend({
  segments,
  total,
}: {
  segments: ColoredSegment[];
  total: number;
}) {
  return (
    <ul className="flex min-w-0 flex-1 flex-col gap-2">
      {segments.map((segment) => (
        <li key={segment.key} className="flex items-center gap-2 text-sm">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: segment.color }}
            aria-hidden
          />
          <span
            className="text-foreground min-w-0 flex-1 truncate"
            title={segment.key}
          >
            {segment.label}
          </span>
          <span className="text-foreground tabular-nums">
            {segment.count.toLocaleString()}
          </span>
          <span className="text-muted-foreground w-9 text-right text-xs tabular-nums">
            {formatPercent(total > 0 ? segment.count / total : 0)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The "share of mail" donut (issue #6): top 4 senders/domains by message
 * count, plus a rolled-up "Other" slice, with a center total and a legend
 * carrying the numbers so identity is never color-alone. */
export function ShareDonut({
  share,
  groupBy,
}: {
  share: DashboardShare;
  groupBy: SenderGroupBy;
}) {
  const noun = groupBy === "domain" ? "domains" : "senders";
  const segments = colorSegments(share.segments);

  const chartConfig: ChartConfig = Object.fromEntries(
    segments.map((segment) => [
      segment.key,
      { label: segment.label, color: segment.color },
    ]),
  );

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Where your mail comes from</CardTitle>
        <CardDescription>Share of messages, top 4 {noun}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-4 sm:flex-row">
        <div className="relative aspect-square w-full max-w-[200px] shrink-0">
          <ChartContainer config={chartConfig} className="aspect-square">
            <PieChart>
              <ChartTooltip
                content={<ShareTooltip total={share.total} />}
                cursor={false}
              />
              <Pie
                data={segments}
                dataKey="count"
                nameKey="label"
                innerRadius="62%"
                outerRadius="90%"
                startAngle={90}
                endAngle={-270}
                stroke="var(--card)"
                strokeWidth={2}
                isAnimationActive={false}
              >
                {segments.map((segment) => (
                  <Cell key={segment.key} fill={segment.color} />
                ))}
              </Pie>
            </PieChart>
          </ChartContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xl font-semibold tabular-nums">
              {formatCompact(share.total)}
            </span>
            <span className="text-muted-foreground text-xs">messages</span>
          </div>
        </div>
        <ShareLegend segments={segments} total={share.total} />
      </CardContent>
    </Card>
  );
}
