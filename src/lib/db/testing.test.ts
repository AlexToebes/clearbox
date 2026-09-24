import { describe, expect, it } from "vitest";
import { createTestDb } from "./testing";

describe("createTestDb", () => {
  it("applies the migrations (messages and sync_state tables exist)", async () => {
    const db = createTestDb();

    const tables = await db.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );

    expect(tables.map((t) => t.name)).toEqual(["messages", "sync_state"]);
  });

  it("returns a fresh, independent database per call", async () => {
    const a = createTestDb();
    const b = createTestDb();

    await a.execute("INSERT INTO sync_state (key, value) VALUES ($1, $2)", [
      "k",
      "v",
    ]);

    const rowsInB = await b.select("SELECT * FROM sync_state");
    expect(rowsInB).toEqual([]);
  });

  it("binds $1, $2, … params positionally, including a null value", async () => {
    const db = createTestDb();

    await db.execute(
      `INSERT INTO messages (
        id, thread_id, from_name, from_email, from_domain, subject,
        internal_date, size_estimate, label_ids, is_unread, is_trashed,
        list_unsubscribe, list_unsubscribe_post
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        "msg-1",
        "thread-1",
        "Alice",
        "alice@example.com",
        "example.com",
        "Hello",
        1_700_000_000_000,
        1234,
        '["UNREAD","INBOX"]',
        1, // is_unread
        0, // is_trashed
        null, // list_unsubscribe
        "<https://example.com/unsub>, POST",
      ],
    );

    const rows = await db.select<{
      id: string;
      from_name: string;
      is_unread: number;
      is_trashed: number;
      list_unsubscribe: string | null;
      list_unsubscribe_post: string;
    }>("SELECT * FROM messages WHERE id = $1", ["msg-1"]);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.from_name).toBe("Alice");
    expect(row.is_unread).toBe(1);
    expect(row.is_trashed).toBe(0);
    expect(row.list_unsubscribe).toBeNull();
    expect(row.list_unsubscribe_post).toBe("<https://example.com/unsub>, POST");
  });

  it("binds a boolean as JSON text, not an integer — the tauri-plugin-sql trap this adapter deliberately reproduces", async () => {
    const db = createTestDb();

    await db.execute(
      "INSERT INTO sync_state (key, value) VALUES ($1, $2)",
      // `SqlParam` excludes booleans precisely so this doesn't compile in
      // real call sites; cast past it here to document the runtime trap.
      ["flag", true as unknown as string],
    );

    const rows = await db.select<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = $1",
      ["flag"],
    );

    // Bound as the *text* "true" (via JSON.stringify), matching
    // tauri-plugin-sql/sqlx-sqlite's real behavior — not the integer 1.
    expect(rows[0]!.value).toBe("true");
  });

  it("binds more than nine params correctly (exercises $10, $11, …)", async () => {
    const db = createTestDb();

    const ids = Array.from({ length: 11 }, (_, i) => `id-${i}`);
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");

    for (const id of ids) {
      await db.execute(
        `INSERT INTO messages (
          id, thread_id, from_email, from_domain, internal_date,
          size_estimate, label_ids, is_unread
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, id, "a@example.com", "example.com", 0, 0, "[]", 0],
      );
    }

    const rows = await db.select<{ id: string }>(
      `SELECT id FROM messages WHERE id IN (${placeholders}) ORDER BY id`,
      ids,
    );

    expect(rows.map((r) => r.id)).toEqual(
      [...ids].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("execute() reports rowsAffected", async () => {
    const db = createTestDb();

    const insert = await db.execute(
      "INSERT INTO sync_state (key, value) VALUES ($1, $2)",
      ["historyId", "12345"],
    );
    expect(insert.rowsAffected).toBe(1);

    const update = await db.execute(
      "UPDATE sync_state SET value = $1 WHERE key = $2",
      ["67890", "historyId"],
    );
    expect(update.rowsAffected).toBe(1);

    const noMatch = await db.execute(
      "UPDATE sync_state SET value = $1 WHERE key = $2",
      ["nope", "does-not-exist"],
    );
    expect(noMatch.rowsAffected).toBe(0);
  });
});
