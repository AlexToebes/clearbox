import { describe, expect, it } from "vitest";
import { toMessageRow } from "@/lib/gmail/parse";
import type { GmailMessage } from "@/lib/gmail/types";
import {
  getKnownIds,
  getMonthlyVolume,
  getSenders,
  getSummary,
  getSyncState,
  setSyncState,
  setTrashed,
  upsertMessages,
} from "./queries";
import { createTestDb } from "./testing";
import type { MessageRow } from "./types";

function makeMessage(opts: {
  id: string;
  from?: string;
  subject?: string;
  date: string;
  size?: number;
  labels?: string[];
  unsubscribe?: string;
  unsubscribePost?: string;
}): GmailMessage {
  const headers: { name: string; value: string }[] = [];
  if (opts.from !== undefined) {
    headers.push({ name: "From", value: opts.from });
  }
  if (opts.subject !== undefined) {
    headers.push({ name: "Subject", value: opts.subject });
  }
  if (opts.unsubscribe !== undefined) {
    headers.push({ name: "List-Unsubscribe", value: opts.unsubscribe });
  }
  if (opts.unsubscribePost !== undefined) {
    headers.push({
      name: "List-Unsubscribe-Post",
      value: opts.unsubscribePost,
    });
  }

  return {
    id: opts.id,
    threadId: `thread-${opts.id}`,
    internalDate: String(Date.parse(opts.date)),
    sizeEstimate: opts.size ?? 1000,
    labelIds: opts.labels ?? ["INBOX"],
    payload: { headers },
  };
}

function row(opts: Parameters<typeof makeMessage>[0]): MessageRow {
  return toMessageRow(makeMessage(opts));
}

describe("upsertMessages", () => {
  it("is idempotent and only updates label_ids/is_unread/is_trashed on conflict", async () => {
    const db = createTestDb();

    await upsertMessages(db, [
      row({
        id: "m1",
        from: "Alice <alice@example.com>",
        subject: "Hi",
        date: "2024-01-01T00:00:00Z",
        labels: ["INBOX", "UNREAD"],
      }),
    ]);

    let rows = await db.select<MessageRow>(
      "SELECT * FROM messages WHERE id = $1",
      ["m1"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_unread).toBe(1);
    expect(rows[0]!.is_trashed).toBe(0);

    // Re-upsert the same id: now read and trashed, with a new label set.
    await upsertMessages(db, [
      row({
        id: "m1",
        from: "Alice <alice@example.com>",
        subject: "Hi",
        date: "2024-01-01T00:00:00Z",
        labels: ["INBOX", "TRASH"],
      }),
    ]);

    rows = await db.select<MessageRow>("SELECT * FROM messages WHERE id = $1", [
      "m1",
    ]);
    expect(rows).toHaveLength(1); // no duplicate row
    expect(rows[0]!.is_unread).toBe(0);
    expect(rows[0]!.is_trashed).toBe(1);
    expect(JSON.parse(rows[0]!.label_ids)).toEqual(["INBOX", "TRASH"]);
    // Untouched by the ON CONFLICT clause.
    expect(rows[0]!.subject).toBe("Hi");
  });

  it("is a no-op for an empty array", async () => {
    const db = createTestDb();
    await upsertMessages(db, []);
    const count = await db.select<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages",
    );
    expect(count[0]!.n).toBe(0);
  });

  it("chunks a batch that would otherwise exceed 900 bound params", async () => {
    const db = createTestDb();
    const rows = Array.from({ length: 200 }, (_, i) =>
      row({
        id: `m${i}`,
        from: `sender${i}@example.com`,
        date: "2024-01-01T00:00:00Z",
      }),
    );

    await upsertMessages(db, rows);

    const count = await db.select<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages",
    );
    expect(count[0]!.n).toBe(200);
  });
});

describe("getKnownIds", () => {
  it("returns only the ids that are already cached", async () => {
    const db = createTestDb();
    const ids = Array.from({ length: 5 }, (_, i) => `m${i}`);
    await upsertMessages(
      db,
      ids.map((id) =>
        row({ id, from: "a@example.com", date: "2024-01-01T00:00:00Z" }),
      ),
    );

    const known = await getKnownIds(db, [...ids, "missing-1", "missing-2"]);
    expect(known).toEqual(new Set(ids));
  });

  it("returns an empty set for an empty input", async () => {
    const db = createTestDb();
    expect(await getKnownIds(db, [])).toEqual(new Set());
  });
});

describe("setTrashed", () => {
  it("marks messages trashed/untrashed, excluding them from non-trashed queries", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      row({ id: "m1", from: "a@example.com", date: "2024-01-01T00:00:00Z" }),
      row({ id: "m2", from: "a@example.com", date: "2024-01-02T00:00:00Z" }),
    ]);

    await setTrashed(db, ["m2"], true);
    expect((await getSummary(db)).totalMessages).toBe(1);

    await setTrashed(db, ["m2"], false);
    expect((await getSummary(db)).totalMessages).toBe(2);
  });

  it("is a no-op for an empty array", async () => {
    const db = createTestDb();
    await expect(setTrashed(db, [], true)).resolves.toBeUndefined();
  });
});

describe("getSummary", () => {
  it("returns all zeros for an empty database", async () => {
    const db = createTestDb();
    expect(await getSummary(db)).toEqual({
      totalMessages: 0,
      unreadMessages: 0,
      totalBytes: 0,
      distinctSenders: 0,
      sendersWithUnsubscribe: 0,
    });
  });

  it("aggregates non-trashed messages only", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      row({
        id: "m1",
        from: "alice@example.com",
        date: "2024-01-01T00:00:00Z",
        size: 100,
        labels: ["UNREAD"],
        unsubscribe: "<https://example.com/unsub>",
      }),
      row({
        id: "m2",
        from: "alice@example.com",
        date: "2024-01-02T00:00:00Z",
        size: 200,
        labels: [],
      }),
      row({
        id: "m3",
        from: "bob@example.com",
        date: "2024-01-03T00:00:00Z",
        size: 300,
        labels: ["UNREAD"],
      }),
      row({
        id: "m4",
        from: "carol@example.com",
        date: "2024-01-04T00:00:00Z",
        size: 400,
        labels: ["TRASH"],
      }),
    ]);

    expect(await getSummary(db)).toEqual({
      totalMessages: 3,
      unreadMessages: 2,
      totalBytes: 600,
      distinctSenders: 2,
      sendersWithUnsubscribe: 1,
    });
  });
});

describe("getSenders", () => {
  it("groups by email, with the most recent non-null from_name as displayName", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      row({
        id: "m1",
        from: "Alice <alice@example.com>",
        date: "2024-01-01T00:00:00Z",
        size: 100,
      }),
      row({
        id: "m2",
        from: "Alice B <alice@example.com>",
        date: "2024-01-05T00:00:00Z",
        size: 200,
        labels: ["UNREAD"],
      }),
      row({
        id: "m3",
        from: "Bob <bob@other.com>",
        date: "2024-01-02T00:00:00Z",
        size: 50,
      }),
    ]);

    const senders = await getSenders(db, { groupBy: "email", sortBy: "count" });
    expect(senders).toHaveLength(2);

    const alice = senders.find((s) => s.key === "alice@example.com")!;
    expect(alice.messageCount).toBe(2);
    expect(alice.unreadCount).toBe(1);
    expect(alice.totalBytes).toBe(300);
    expect(alice.displayName).toBe("Alice B");
    expect(alice.hasUnsubscribe).toBe(false);
    expect(alice.firstDate).toBeLessThan(alice.lastDate);
  });

  it("groups by domain, using the domain itself as displayName", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      row({
        id: "m1",
        from: "alice@example.com",
        date: "2024-01-01T00:00:00Z",
      }),
      row({
        id: "m2",
        from: "carol@example.com",
        date: "2024-01-02T00:00:00Z",
      }),
      row({ id: "m3", from: "bob@other.com", date: "2024-01-03T00:00:00Z" }),
    ]);

    const senders = await getSenders(db, {
      groupBy: "domain",
      sortBy: "count",
    });
    expect(senders.map((s) => s.key).sort()).toEqual([
      "example.com",
      "other.com",
    ]);

    const example = senders.find((s) => s.key === "example.com")!;
    expect(example.messageCount).toBe(2);
    expect(example.displayName).toBe("example.com");
  });

  it("excludes trashed messages", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      row({
        id: "m1",
        from: "a@example.com",
        date: "2024-01-01T00:00:00Z",
        labels: ["TRASH"],
      }),
    ]);
    expect(await getSenders(db, { groupBy: "email", sortBy: "count" })).toEqual(
      [],
    );
  });

  it("sorts by count, size, unread and latest", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      row({
        id: "m1",
        from: "a@x.com",
        date: "2024-01-01T00:00:00Z",
        size: 10,
      }),
      row({
        id: "m2",
        from: "a@x.com",
        date: "2024-01-02T00:00:00Z",
        size: 10,
      }),
      row({
        id: "m3",
        from: "b@x.com",
        date: "2024-03-01T00:00:00Z",
        size: 1000,
        labels: ["UNREAD"],
      }),
    ]);
    // a@x.com: count=2, size=20, unread=0, latest=Jan 2
    // b@x.com: count=1, size=1000, unread=1, latest=Mar 1

    expect(
      (await getSenders(db, { groupBy: "email", sortBy: "count" })).map(
        (s) => s.key,
      ),
    ).toEqual(["a@x.com", "b@x.com"]);

    expect(
      (await getSenders(db, { groupBy: "email", sortBy: "size" })).map(
        (s) => s.key,
      ),
    ).toEqual(["b@x.com", "a@x.com"]);

    expect(
      (await getSenders(db, { groupBy: "email", sortBy: "unread" })).map(
        (s) => s.key,
      ),
    ).toEqual(["b@x.com", "a@x.com"]);

    expect(
      (await getSenders(db, { groupBy: "email", sortBy: "latest" })).map(
        (s) => s.key,
      ),
    ).toEqual(["b@x.com", "a@x.com"]);
  });

  it("applies limit", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      row({ id: "m1", from: "a@x.com", date: "2024-01-01T00:00:00Z" }),
      row({ id: "m2", from: "b@x.com", date: "2024-01-01T00:00:00Z" }),
      row({ id: "m3", from: "c@x.com", date: "2024-01-01T00:00:00Z" }),
    ]);

    const senders = await getSenders(db, {
      groupBy: "email",
      sortBy: "count",
      limit: 2,
    });
    expect(senders).toHaveLength(2);
  });

  it("search matches the key or the sender name, case-insensitively", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      row({
        id: "m1",
        from: "Alice Smith <alice@example.com>",
        date: "2024-01-01T00:00:00Z",
      }),
      row({ id: "m2", from: "bob@other.com", date: "2024-01-02T00:00:00Z" }),
    ]);

    expect(
      (
        await getSenders(db, {
          groupBy: "email",
          sortBy: "count",
          search: "ALICE",
        })
      ).map((s) => s.key),
    ).toEqual(["alice@example.com"]);

    expect(
      (
        await getSenders(db, {
          groupBy: "email",
          sortBy: "count",
          search: "other.com",
        })
      ).map((s) => s.key),
    ).toEqual(["bob@other.com"]);

    expect(
      await getSenders(db, {
        groupBy: "email",
        sortBy: "count",
        search: "no-such-sender",
      }),
    ).toEqual([]);
  });

  it("treats '%' and '_' in search as literal characters, not SQL wildcards", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      row({
        id: "m1",
        from: "Alice <alice@example.com>",
        date: "2024-01-01T00:00:00Z",
      }),
      row({
        id: "m2",
        from: "100% Fan <fan@example.com>",
        date: "2024-01-02T00:00:00Z",
      }),
    ]);

    // If '%' weren't escaped, this pattern ("%%%") would match every row.
    const percentSearch = await getSenders(db, {
      groupBy: "email",
      sortBy: "count",
      search: "%",
    });
    expect(percentSearch.map((s) => s.key)).toEqual(["fan@example.com"]);

    // If '_' weren't escaped, it would match any single character.
    const underscoreSearch = await getSenders(db, {
      groupBy: "email",
      sortBy: "count",
      search: "_",
    });
    expect(underscoreSearch).toEqual([]);
  });
});

describe("getMonthlyVolume", () => {
  it("totals non-trashed messages per UTC month across a year boundary", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      row({ id: "m1", from: "a@x.com", date: "2023-12-15T12:00:00Z" }),
      row({ id: "m2", from: "a@x.com", date: "2023-12-20T12:00:00Z" }),
      row({ id: "m3", from: "a@x.com", date: "2024-01-05T12:00:00Z" }),
      row({ id: "m4", from: "a@x.com", date: "2024-01-31T23:59:59Z" }),
      row({ id: "m5", from: "a@x.com", date: "2024-02-01T00:00:01Z" }),
      row({
        id: "m6",
        from: "a@x.com",
        date: "2024-01-15T00:00:00Z",
        labels: ["TRASH"],
      }),
    ]);

    expect(await getMonthlyVolume(db)).toEqual([
      { month: "2023-12", key: null, count: 2 },
      { month: "2024-01", key: null, count: 2 },
      { month: "2024-02", key: null, count: 1 },
    ]);
  });

  it("groups by key when keys are given, excluding unlisted senders", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      row({
        id: "m1",
        from: "alice@example.com",
        date: "2023-12-15T00:00:00Z",
      }),
      row({ id: "m2", from: "bob@example.com", date: "2023-12-20T00:00:00Z" }),
      row({
        id: "m3",
        from: "alice@example.com",
        date: "2024-01-05T00:00:00Z",
      }),
      row({ id: "m4", from: "carol@other.com", date: "2024-01-06T00:00:00Z" }),
    ]);

    const volume = await getMonthlyVolume(db, {
      groupBy: "email",
      keys: ["alice@example.com", "bob@example.com"],
    });

    expect(volume).toEqual([
      { month: "2023-12", key: "alice@example.com", count: 1 },
      { month: "2023-12", key: "bob@example.com", count: 1 },
      { month: "2024-01", key: "alice@example.com", count: 1 },
    ]);
  });

  it("returns an empty array when there are no matching messages", async () => {
    const db = createTestDb();
    await upsertMessages(db, [
      row({
        id: "m1",
        from: "a@x.com",
        date: "2024-01-01T00:00:00Z",
        labels: ["TRASH"],
      }),
    ]);
    expect(await getMonthlyVolume(db)).toEqual([]);
  });
});

describe("sync state", () => {
  it("round-trips: unset -> set -> update", async () => {
    const db = createTestDb();
    expect(await getSyncState(db, "historyId")).toBeNull();

    await setSyncState(db, "historyId", "111");
    expect(await getSyncState(db, "historyId")).toBe("111");

    await setSyncState(db, "historyId", "222");
    expect(await getSyncState(db, "historyId")).toBe("222");
  });
});
