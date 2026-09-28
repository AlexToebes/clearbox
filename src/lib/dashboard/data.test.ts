import { describe, expect, it } from "vitest";
import { toMessageRow } from "@/lib/gmail/parse";
import { upsertMessages } from "@/lib/db/queries";
import { createTestDb } from "@/lib/db/testing";
import type { GmailMessage } from "@/lib/gmail/types";
import type { MessageRow } from "@/lib/db/types";
import { loadDashboard } from "./data";

function makeMessage(opts: {
  id: string;
  from: string;
  date: string;
  size?: number;
  unread?: boolean;
  unsubscribe?: string;
}): GmailMessage {
  const headers: { name: string; value: string }[] = [
    { name: "From", value: opts.from },
  ];
  if (opts.unsubscribe !== undefined) {
    headers.push({ name: "List-Unsubscribe", value: opts.unsubscribe });
  }

  return {
    id: opts.id,
    threadId: `thread-${opts.id}`,
    internalDate: String(Date.parse(opts.date)),
    sizeEstimate: opts.size ?? 1000,
    labelIds: opts.unread === false ? [] : ["UNREAD"],
    payload: { headers },
  };
}

function row(opts: Parameters<typeof makeMessage>[0]): MessageRow {
  return toMessageRow(makeMessage(opts));
}

const NOW = Date.UTC(2025, 5, 15); // 2025-06-15, UTC

describe("loadDashboard — monthly", () => {
  it("returns exactly the last 24 UTC months, zero-filled, ending at now's month", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      row({ id: "m1", from: "a@example.com", date: "2025-06-01T00:00:00Z" }),
      row({ id: "m2", from: "a@example.com", date: "2025-06-02T00:00:00Z" }),
    ]);

    const result = await loadDashboard(db, {
      groupBy: "email",
      barMetric: "count",
      now: NOW,
    });

    expect(result.monthly).toHaveLength(24);
    expect(result.monthly[0]).toEqual({ month: "2023-07", count: 0 });
    expect(result.monthly[23]).toEqual({ month: "2025-06", count: 2 });
    // Everything else is zero-filled.
    const nonZero = result.monthly.filter((m) => m.count !== 0);
    expect(nonZero).toEqual([{ month: "2025-06", count: 2 }]);
  });

  it("crosses a year boundary correctly", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      row({ id: "m1", from: "a@example.com", date: "2024-12-31T12:00:00Z" }),
      row({ id: "m2", from: "a@example.com", date: "2025-01-01T00:00:00Z" }),
    ]);

    const result = await loadDashboard(db, {
      groupBy: "email",
      barMetric: "count",
      now: Date.UTC(2025, 0, 10), // 2025-01-10
    });

    expect(result.monthly).toHaveLength(24);
    expect(result.monthly[0]!.month).toBe("2023-02");
    expect(result.monthly[23]!.month).toBe("2025-01");
    const dec2024 = result.monthly.find((m) => m.month === "2024-12");
    const jan2025 = result.monthly.find((m) => m.month === "2025-01");
    expect(dec2024).toEqual({ month: "2024-12", count: 1 });
    expect(jan2025).toEqual({ month: "2025-01", count: 1 });
  });
});

describe("loadDashboard — share", () => {
  it("omits the Other segment when there are 4 or fewer senders", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      row({ id: "m1", from: "a@example.com", date: "2025-06-01T00:00:00Z" }),
      row({ id: "m2", from: "b@example.com", date: "2025-06-01T00:00:00Z" }),
      row({ id: "m3", from: "c@example.com", date: "2025-06-01T00:00:00Z" }),
    ]);

    const result = await loadDashboard(db, {
      groupBy: "email",
      barMetric: "count",
      now: NOW,
    });

    expect(result.share.segments).toHaveLength(3);
    expect(result.share.segments.some((s) => s.isOther)).toBe(false);
    expect(result.share.total).toBe(3);
  });

  it("rolls the remainder past the top 4 into an Other segment", async () => {
    const db = createTestDb();
    const rows: MessageRow[] = [];
    // 4 senders with 5 messages each, and 3 more senders with 1 each — the
    // top 4 by count should be the 5-message senders, and Other = 3.
    for (const sender of ["a", "b", "c", "d"]) {
      for (let i = 0; i < 5; i++) {
        rows.push(
          row({
            id: `${sender}-${i}`,
            from: `${sender}@example.com`,
            date: "2025-06-01T00:00:00Z",
          }),
        );
      }
    }
    for (const sender of ["e", "f", "g"]) {
      rows.push(
        row({
          id: sender,
          from: `${sender}@example.com`,
          date: "2025-06-01T00:00:00Z",
        }),
      );
    }
    await upsertMessages(db, rows);

    const result = await loadDashboard(db, {
      groupBy: "email",
      barMetric: "count",
      now: NOW,
    });

    expect(result.share.total).toBe(23);
    expect(result.share.segments).toHaveLength(5);
    const other = result.share.segments.find((s) => s.isOther);
    expect(other).toEqual({
      key: "__other__",
      label: "Other",
      count: 3,
      isOther: true,
    });
    expect(result.share.segments.filter((s) => !s.isOther)).toHaveLength(4);
  });
});

describe("loadDashboard — topSenders", () => {
  it("sorts by the requested barMetric", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      // "small" sends many small messages.
      row({
        id: "s1",
        from: "small@example.com",
        date: "2025-06-01T00:00:00Z",
        size: 100,
      }),
      row({
        id: "s2",
        from: "small@example.com",
        date: "2025-06-01T00:00:00Z",
        size: 100,
      }),
      row({
        id: "s3",
        from: "small@example.com",
        date: "2025-06-01T00:00:00Z",
        size: 100,
      }),
      // "big" sends one huge message.
      row({
        id: "b1",
        from: "big@example.com",
        date: "2025-06-01T00:00:00Z",
        size: 1_000_000,
      }),
    ]);

    const byCount = await loadDashboard(db, {
      groupBy: "email",
      barMetric: "count",
      now: NOW,
    });
    expect(byCount.topSenders[0]!.key).toBe("small@example.com");

    const bySize = await loadDashboard(db, {
      groupBy: "email",
      barMetric: "size",
      now: NOW,
    });
    expect(bySize.topSenders[0]!.key).toBe("big@example.com");
  });

  it("sorts by unread count", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      row({
        id: "r1",
        from: "reader@example.com",
        date: "2025-06-01T00:00:00Z",
        unread: false,
      }),
      row({
        id: "r2",
        from: "reader@example.com",
        date: "2025-06-01T00:00:00Z",
        unread: false,
      }),
      row({
        id: "u1",
        from: "unread@example.com",
        date: "2025-06-01T00:00:00Z",
        unread: true,
      }),
    ]);

    const result = await loadDashboard(db, {
      groupBy: "email",
      barMetric: "unread",
      now: NOW,
    });
    expect(result.topSenders[0]!.key).toBe("unread@example.com");
  });

  it("groups by domain when requested", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      row({
        id: "d1",
        from: "a@news.example.com",
        date: "2025-06-01T00:00:00Z",
      }),
      row({
        id: "d2",
        from: "b@news.example.com",
        date: "2025-06-01T00:00:00Z",
      }),
    ]);

    const result = await loadDashboard(db, {
      groupBy: "domain",
      barMetric: "count",
      now: NOW,
    });
    expect(result.topSenders[0]!.key).toBe("news.example.com");
  });
});
