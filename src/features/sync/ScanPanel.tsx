import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useAuth } from "@/features/auth/context";
import type { ScanProgress } from "@/lib/sync/scan";
import {
  describeProgress,
  estimateFullScanMs,
  formatDuration,
} from "@/lib/sync/progress";
import { describeScanError } from "./errorMessage";
import { useScan } from "./useScan";

/**
 * Reads "now", refreshed every `intervalMs` — a render body can't call
 * `Date.now()` directly (React's purity rule), so this pushes the impure
 * read into an effect and hands back the last value it read. `null` until
 * the first effect has run, right after mount.
 */
function useNow(intervalMs: number): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // The initial read goes through a timeout (rather than a direct
    // `setNow(Date.now())` here) so the effect doesn't synchronously
    // trigger a cascading re-render of its own.
    const initial = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [intervalMs]);

  return now;
}

type MessagesTotalState =
  | { kind: "loading" }
  | { kind: "loaded"; messagesTotal: number }
  | { kind: "error" };

/** Loads `messagesTotal` from `getProfile()`, used by the pre-scan cards to
 * estimate how long the first scan will take. */
function useMessagesTotal(): MessagesTotalState {
  const { gmail } = useAuth();
  const [state, setState] = useState<MessagesTotalState>({ kind: "loading" });

  useEffect(() => {
    if (!gmail) {
      return;
    }
    let cancelled = false;

    gmail
      .getProfile()
      .then((profile) => {
        if (!cancelled) {
          setState({ kind: "loaded", messagesTotal: profile.messagesTotal });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ kind: "error" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [gmail]);

  return state;
}

const RELATIVE_UNITS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "week", ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
];
const relativeTimeFormat = new Intl.RelativeTimeFormat("en", {
  numeric: "auto",
});

/** e.g. "5 minutes ago". */
function formatRelativeTime(timestampMs: number, nowMs: number): string {
  const diffMs = timestampMs - nowMs;
  for (const { unit, ms } of RELATIVE_UNITS) {
    if (Math.abs(diffMs) >= ms) {
      return relativeTimeFormat.format(Math.round(diffMs / ms), unit);
    }
  }
  return relativeTimeFormat.format(Math.round(diffMs / 1000), "second");
}

/** The shared card shown before a first scan, and again when one was
 * interrupted or cancelled — same body, different title/button copy. */
function IntroCard({
  title,
  buttonLabel,
  onStart,
}: {
  title: string;
  buttonLabel: string;
  onStart: () => void;
}) {
  const messagesTotal = useMessagesTotal();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <CardDescription>
          Clearbox reads the sender, subject, date and size of each message —
          never the contents — and keeps them on this computer.
        </CardDescription>
        {messagesTotal.kind === "loaded" && (
          <CardDescription>
            Your mailbox has about{" "}
            {messagesTotal.messagesTotal.toLocaleString()} messages; the first
            scan takes{" "}
            {formatDuration(estimateFullScanMs(messagesTotal.messagesTotal))}.
          </CardDescription>
        )}
      </CardContent>
      <CardFooter>
        <Button onClick={onStart}>{buttonLabel}</Button>
      </CardFooter>
    </Card>
  );
}

/** Progress bar + ETA line shown while a scan is running. Its own
 * component so `useNow` — and the 1s interval it runs — only exists while
 * this is actually on screen. */
function RunningCard({
  progress,
  startedAt,
  onPause,
}: {
  progress: ScanProgress;
  startedAt: number;
  onPause: () => void;
}) {
  const now = useNow(1000);
  // Before the first tick, elapsedMs is 0 — describeProgress simply
  // reports no ETA yet (it needs 3s of elapsed time regardless), so this
  // never shows an incorrect one.
  const elapsedMs = now === null ? 0 : Math.max(0, now - startedAt);
  const summary = describeProgress(progress, elapsedMs);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scanning your mailbox</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Progress value={summary.percent} aria-label="Scan progress" />
        <CardDescription className="tabular-nums">
          {summary.processed.toLocaleString()} of ~
          {summary.total.toLocaleString()} messages
          {summary.etaMs !== null && ` · ${formatDuration(summary.etaMs)} left`}
        </CardDescription>
      </CardContent>
      <CardFooter>
        <Button variant="outline" onClick={onPause}>
          Pause
        </Button>
      </CardFooter>
    </Card>
  );
}

/** The compact "last scanned" row shown once a scan has completed. Its own
 * component for the same reason as `RunningCard`. */
function CompletedRow({
  lastFullScanAt,
  onCheckForNewMail,
}: {
  lastFullScanAt: number;
  onCheckForNewMail: () => void;
}) {
  const now = useNow(60_000);

  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-muted-foreground text-sm">
        Last scanned {formatRelativeTime(lastFullScanAt, now ?? lastFullScanAt)}
      </p>
      <Button variant="outline" onClick={onCheckForNewMail}>
        Check for new mail
      </Button>
    </div>
  );
}

/** Shows the current full-scan status and lets the user start, pause, or
 * resume it (issue #4). See `useScan`/`lib/sync/scanController.ts`. */
export function ScanPanel() {
  const scan = useScan();

  if (scan.status === null) {
    return (
      <Card>
        <CardContent>
          <div className="bg-muted h-4 w-48 animate-pulse rounded" />
        </CardContent>
      </Card>
    );
  }

  if (scan.run.kind === "running") {
    return (
      <RunningCard
        progress={scan.run.progress}
        startedAt={scan.run.startedAt}
        onPause={scan.cancel}
      />
    );
  }

  if (scan.run.kind === "error") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Couldn't finish the scan</CardTitle>
          <CardDescription>{describeScanError(scan.run.error)}</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button onClick={scan.start}>Try again</Button>
        </CardFooter>
      </Card>
    );
  }

  if (scan.run.kind === "cancelled" || scan.status.inProgress) {
    return (
      <IntroCard
        title="Scan paused"
        buttonLabel="Resume scan"
        onStart={scan.start}
      />
    );
  }

  if (scan.status.lastFullScanAt === null) {
    return (
      <IntroCard
        title="Scan your mailbox"
        buttonLabel="Start scan"
        onStart={scan.start}
      />
    );
  }

  return (
    <CompletedRow
      lastFullScanAt={scan.status.lastFullScanAt}
      onCheckForNewMail={scan.start}
    />
  );
}
