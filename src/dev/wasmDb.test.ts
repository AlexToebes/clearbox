import { describe, expect, it } from "vitest";
import { toMessageRow } from "@/lib/gmail/parse";
import type { GmailMessage } from "@/lib/gmail/types";
import { upsertMessages, getSummary } from "@/lib/db/queries";
import { createWasmDb } from "./wasmDb";

function makeMessage(id: string, from: string): GmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: "1700000000000",
    sizeEstimate: 1234,
    labelIds: ["INBOX", "UNREAD"],
    payload: { headers: [{ name: "From", value: from }] },
  };
}

describe("createWasmDb", () => {
  it("applies migrations and supports the same queries as the real app", async () => {
    const db = await createWasmDb();

    await upsertMessages(db, [
      toMessageRow(makeMessage("m1", "Alice <alice@example.com>")),
      toMessageRow(makeMessage("m2", "Bob <bob@example.com>")),
    ]);

    const summary = await getSummary(db);
    expect(summary.totalMessages).toBe(2);
    expect(summary.distinctSenders).toBe(2);
  });

  it("returns independent databases across calls", async () => {
    const dbA = await createWasmDb();
    const dbB = await createWasmDb();

    await upsertMessages(dbA, [
      toMessageRow(makeMessage("m1", "Alice <alice@example.com>")),
    ]);

    expect((await getSummary(dbA)).totalMessages).toBe(1);
    expect((await getSummary(dbB)).totalMessages).toBe(0);
  });

  it("binds $1, $2, … positionally, same as tauri-plugin-sql", async () => {
    const db = await createWasmDb();
    await db.execute("INSERT INTO sync_state (key, value) VALUES ($1, $2)", [
      "a",
      "1",
    ]);
    const rows = await db.select<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = $1",
      ["a"],
    );
    expect(rows).toEqual([{ value: "1" }]);
  });
});
