import { describe, expect, it } from "vitest";
import type { ScanProgress } from "./scan";
import {
  ASSUMED_MESSAGES_PER_SECOND,
  describeProgress,
  estimateFullScanMs,
  formatDuration,
} from "./progress";

/** Builds a `ScanProgress` fixture, defaulting every count to 0. */
function progress(overrides: Partial<ScanProgress>): ScanProgress {
  return {
    phase: "scanning",
    total: 0,
    listed: 0,
    alreadyCached: 0,
    fetched: 0,
    skippedDeleted: 0,
    ...overrides,
  };
}

describe("describeProgress", () => {
  describe("processed / total / percent", () => {
    const cases: {
      name: string;
      p: ScanProgress;
      elapsedMs: number;
      processed: number;
      total: number;
      percent: number;
    }[] = [
      {
        name: "nothing done yet",
        p: progress({ phase: "starting", total: 100 }),
        elapsedMs: 0,
        processed: 0,
        total: 100,
        percent: 0,
      },
      {
        name: "counts cached, fetched and deleted as processed",
        p: progress({
          total: 100,
          alreadyCached: 10,
          fetched: 20,
          skippedDeleted: 5,
        }),
        elapsedMs: 0,
        processed: 35,
        total: 100,
        percent: 35,
      },
      {
        name: "floors a fractional percent",
        p: progress({ total: 3, fetched: 1 }),
        elapsedMs: 0,
        processed: 1,
        total: 3,
        percent: 33,
      },
      {
        name: "total grows past Gmail's estimate when processed exceeds it",
        p: progress({ total: 10, fetched: 15 }),
        elapsedMs: 0,
        processed: 15,
        total: 15,
        percent: 99,
      },
      {
        name: "caps percent at 99 while not done, even fully caught up",
        p: progress({ phase: "scanning", total: 10, fetched: 10 }),
        elapsedMs: 0,
        processed: 10,
        total: 10,
        percent: 99,
      },
      {
        name: "reports 100 only once phase is done",
        p: progress({ phase: "done", total: 10, fetched: 10 }),
        elapsedMs: 0,
        processed: 10,
        total: 10,
        percent: 100,
      },
      {
        name: "zero total and zero processed doesn't divide by zero",
        p: progress({ phase: "starting", total: 0 }),
        elapsedMs: 0,
        processed: 0,
        total: 0,
        percent: 0,
      },
    ];

    it.each(cases)("$name", ({ p, elapsedMs, processed, total, percent }) => {
      const result = describeProgress(p, elapsedMs);
      expect(result.processed).toBe(processed);
      expect(result.total).toBe(total);
      expect(result.percent).toBe(percent);
    });
  });

  describe("etaMs", () => {
    const cases: {
      name: string;
      p: ScanProgress;
      elapsedMs: number;
      etaMs: number | null;
    }[] = [
      {
        name: "null before 20 messages are fetched this run",
        p: progress({ total: 1000, fetched: 19 }),
        elapsedMs: 10_000,
        etaMs: null,
      },
      {
        name: "null before 3s have elapsed, even with plenty fetched",
        p: progress({ total: 1000, fetched: 500 }),
        elapsedMs: 2999,
        etaMs: null,
      },
      {
        name: "fetched + skippedDeleted both count toward the threshold",
        // 20 messages in 3000ms => rate 20/3000/ms; processed = 20,
        // remaining = 1000 - 20 = 980 => eta = 980 / (20 / 3000) = 147000ms.
        p: progress({ total: 1000, fetched: 10, skippedDeleted: 10 }),
        elapsedMs: 3000,
        etaMs: 147_000,
      },
      {
        name: "computed once both thresholds are met",
        // 100 messages in 5000ms => rate 0.02/ms; remaining = 1000 - 100 = 900
        // => eta = 900 / 0.02 = 45000ms.
        p: progress({ total: 1000, fetched: 100 }),
        elapsedMs: 5000,
        etaMs: 45_000,
      },
      {
        name: "remaining never goes negative once processed exceeds total",
        p: progress({ total: 10, fetched: 30 }),
        elapsedMs: 5000,
        etaMs: 0,
      },
    ];

    it.each(cases)("$name", ({ p, elapsedMs, etaMs }) => {
      const result = describeProgress(p, elapsedMs);
      if (etaMs === null) {
        expect(result.etaMs).toBeNull();
      } else {
        expect(result.etaMs).toBeCloseTo(etaMs, 6);
      }
    });
  });
});

describe("formatDuration", () => {
  const cases: { ms: number; expected: string }[] = [
    { ms: 0, expected: "less than a minute" },
    { ms: 30_000, expected: "less than a minute" },
    { ms: 59_999, expected: "less than a minute" },
    { ms: 60_000, expected: "about 1 min" },
    { ms: 3 * 60_000, expected: "about 3 min" },
    { ms: 59 * 60_000, expected: "about 59 min" },
    { ms: 60 * 60_000, expected: "about 1 h" },
    { ms: 60 * 60_000 + 20 * 60_000, expected: "about 1 h 20 min" },
    { ms: 2 * 60 * 60_000, expected: "about 2 h" },
  ];

  it.each(cases)("formats $ms ms as $expected", ({ ms, expected }) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe("estimateFullScanMs", () => {
  it("assumes a steady 40 messages/s", () => {
    expect(ASSUMED_MESSAGES_PER_SECOND).toBe(40);
  });

  const cases: { messagesTotal: number; expectedMs: number }[] = [
    { messagesTotal: 0, expectedMs: 0 },
    { messagesTotal: 40, expectedMs: 1000 },
    { messagesTotal: 4800, expectedMs: 120_000 },
    { messagesTotal: 48_000, expectedMs: 1_200_000 },
  ];

  it.each(cases)(
    "estimates $messagesTotal messages as $expectedMs ms",
    ({ messagesTotal, expectedMs }) => {
      expect(estimateFullScanMs(messagesTotal)).toBe(expectedMs);
    },
  );

  it("matches formatDuration's output for a realistic mailbox", () => {
    expect(formatDuration(estimateFullScanMs(48_000))).toBe("about 20 min");
  });
});
