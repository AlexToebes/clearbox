import { describe, expect, it } from "vitest";
import { getSyncState, setSyncState, SYNC_KEYS } from "@/lib/db/queries";
import { createTestDb } from "@/lib/db/testing";
import { GmailApiError, type GmailClient } from "@/lib/gmail/client";
import type { GmailMessage, GmailProfile } from "@/lib/gmail/types";
import { getScanStatus, runFullScan, type ScanProgress } from "./scan";

const PROFILE: GmailProfile = {
  emailAddress: "alex@example.com",
  messagesTotal: 4,
  threadsTotal: 4,
  historyId: "h1",
};

/** Builds a `GmailMessage` fixture the same way `parse.test.ts` does. */
function makeMessage(opts: {
  id: string;
  from?: string;
  subject?: string;
  date: string;
}): GmailMessage {
  const headers: { name: string; value: string }[] = [];
  if (opts.from !== undefined) {
    headers.push({ name: "From", value: opts.from });
  }
  if (opts.subject !== undefined) {
    headers.push({ name: "Subject", value: opts.subject });
  }
  return {
    id: opts.id,
    threadId: `thread-${opts.id}`,
    internalDate: String(Date.parse(opts.date)),
    sizeEstimate: 1000,
    labelIds: ["INBOX"],
    payload: { headers },
  };
}

interface ConcurrencyTracker {
  current: number;
  max: number;
}

type FakeGmail = Pick<
  GmailClient,
  "getProfile" | "listMessageIds" | "getMessageMetadata"
>;

/** A fake `GmailClient` (the three methods `runFullScan` depends on) with
 * configurable pages and per-id message fixtures (`null` simulates a 404 —
 * a message deleted since it was listed). */
function createFakeGmail(config: {
  getProfile: () => GmailProfile;
  pages: { ids: string[]; nextPageToken: string | null }[];
  messages: Map<string, GmailMessage | null>;
  /** Bumped/dropped around each `getMessageMetadata` call so tests can
   * assert the worker pool never exceeds its concurrency limit. */
  tracker?: ConcurrencyTracker;
  /** Artificial delay per `getMessageMetadata` call, so concurrent calls
   * actually overlap in time. */
  delayMs?: number;
  /** Called right after a `getMessageMetadata` call resolves (with the
   * fetched id), before the worker loops again — lets a test trigger an
   * abort deterministically partway through a page. */
  onAfterFetch?: (id: string) => void;
}): FakeGmail {
  let pageIndex = 0;

  return {
    getProfile: (signal?: AbortSignal) => {
      if (signal?.aborted) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- mirroring the real client's abort behavior (see rateLimiter.ts).
        return Promise.reject<GmailProfile>(signal.reason);
      }
      return Promise.resolve(config.getProfile());
    },

    listMessageIds: (opts = {}) => {
      if (opts.signal?.aborted) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see above.
        return Promise.reject(opts.signal.reason);
      }
      const page = config.pages[pageIndex];
      if (!page) {
        throw new Error("createFakeGmail: ran out of pages");
      }
      pageIndex += 1;
      return Promise.resolve({
        ids: page.ids,
        nextPageToken: page.nextPageToken,
        resultSizeEstimate: page.ids.length,
      });
    },

    getMessageMetadata: async (id: string, signal?: AbortSignal) => {
      if (signal?.aborted) {
        throw signal.reason;
      }

      if (config.tracker) {
        config.tracker.current += 1;
        config.tracker.max = Math.max(
          config.tracker.max,
          config.tracker.current,
        );
      }
      if (config.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, config.delayMs));
      }
      if (config.tracker) {
        config.tracker.current -= 1;
      }

      if (signal?.aborted) {
        throw signal.reason;
      }
      if (!config.messages.has(id)) {
        throw new Error(`createFakeGmail: no fixture for id "${id}"`);
      }
      const message = config.messages.get(id) as GmailMessage | null;
      config.onAfterFetch?.(id);
      return message;
    },
  };
}

async function cachedIds(
  db: ReturnType<typeof createTestDb>,
): Promise<string[]> {
  const rows = await db.select<{ id: string }>(
    "SELECT id FROM messages ORDER BY id",
  );
  return rows.map((r) => r.id);
}

describe("runFullScan", () => {
  it("a fresh 2-page scan stores all rows and writes sync state", async () => {
    const db = createTestDb();
    const messages = new Map(
      ["m1", "m2", "m3", "m4"].map((id) => [
        id,
        makeMessage({ id, from: `${id}@x.com`, date: "2024-01-01T00:00:00Z" }),
      ]),
    );
    const gmail = createFakeGmail({
      getProfile: () => PROFILE,
      pages: [
        { ids: ["m1", "m2"], nextPageToken: "p2" },
        { ids: ["m3", "m4"], nextPageToken: null },
      ],
      messages,
    });

    const result = await runFullScan({ gmail, db, now: () => 5000 });

    expect(result).toEqual({
      accountEmail: "alex@example.com",
      fetched: 4,
      alreadyCached: 0,
      skippedDeleted: 0,
      historyId: "h1",
    });
    expect(await cachedIds(db)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(await getSyncState(db, SYNC_KEYS.accountEmail)).toBe(
      "alex@example.com",
    );
    expect(await getSyncState(db, SYNC_KEYS.historyId)).toBe("h1");
    expect(await getSyncState(db, SYNC_KEYS.scanStartHistoryId)).toBeNull();
    expect(await getSyncState(db, SYNC_KEYS.lastFullScanAt)).toBe("5000");
  });

  it("counts and skips 404s (messages deleted since being listed)", async () => {
    const db = createTestDb();
    const messages = new Map<string, GmailMessage | null>([
      [
        "m1",
        makeMessage({
          id: "m1",
          from: "a@x.com",
          date: "2024-01-01T00:00:00Z",
        }),
      ],
      ["m2", null], // deleted since listing
      [
        "m3",
        makeMessage({
          id: "m3",
          from: "c@x.com",
          date: "2024-01-03T00:00:00Z",
        }),
      ],
    ]);
    const gmail = createFakeGmail({
      getProfile: () => PROFILE,
      pages: [{ ids: ["m1", "m2", "m3"], nextPageToken: null }],
      messages,
    });

    const result = await runFullScan({ gmail, db, now: () => 1 });

    expect(result.fetched).toBe(2);
    expect(result.skippedDeleted).toBe(1);
    expect(await cachedIds(db)).toEqual(["m1", "m3"]);
  });

  it("wipes old rows and sync state when the signed-in account switches", async () => {
    const db = createTestDb();
    const profileA: GmailProfile = {
      emailAddress: "old@example.com",
      messagesTotal: 2,
      threadsTotal: 2,
      historyId: "old-h1",
    };
    const gmailA = createFakeGmail({
      getProfile: () => profileA,
      pages: [{ ids: ["a1", "a2"], nextPageToken: null }],
      messages: new Map(
        ["a1", "a2"].map((id) => [
          id,
          makeMessage({ id, from: "a@old.com", date: "2024-01-01T00:00:00Z" }),
        ]),
      ),
    });
    await runFullScan({ gmail: gmailA, db, now: () => 1 });
    expect(await cachedIds(db)).toEqual(["a1", "a2"]);

    const profileB: GmailProfile = {
      emailAddress: "new@example.com",
      messagesTotal: 1,
      threadsTotal: 1,
      historyId: "new-h1",
    };
    const gmailB = createFakeGmail({
      getProfile: () => profileB,
      pages: [{ ids: ["b1"], nextPageToken: null }],
      messages: new Map([
        [
          "b1",
          makeMessage({
            id: "b1",
            from: "b@new.com",
            date: "2024-02-01T00:00:00Z",
          }),
        ],
      ]),
    });
    const result = await runFullScan({ gmail: gmailB, db, now: () => 2 });

    expect(result.accountEmail).toBe("new@example.com");
    expect(await cachedIds(db)).toEqual(["b1"]); // old rows gone
    expect(await getSyncState(db, SYNC_KEYS.accountEmail)).toBe(
      "new@example.com",
    );
    expect(await getSyncState(db, SYNC_KEYS.historyId)).toBe("new-h1");
  });

  it("aborting mid-page rejects, keeps earlier pages' rows, and writes no history_id", async () => {
    const db = createTestDb();
    const messages = new Map(
      ["m1", "m2", "m3", "m4"].map((id) => [
        id,
        makeMessage({ id, from: `${id}@x.com`, date: "2024-01-01T00:00:00Z" }),
      ]),
    );
    const controller = new AbortController();
    const gmail = createFakeGmail({
      getProfile: () => PROFILE,
      pages: [
        { ids: ["m1", "m2"], nextPageToken: "p2" },
        { ids: ["m3", "m4"], nextPageToken: null },
      ],
      messages,
      onAfterFetch: (id) => {
        if (id === "m3") {
          controller.abort();
        }
      },
    });

    await expect(
      runFullScan({
        gmail,
        db,
        now: () => 1,
        signal: controller.signal,
        concurrency: 1, // deterministic: m4 is never even started
      }),
    ).rejects.toBeInstanceOf(DOMException);

    // Page 1 (m1, m2) was committed; page 2's m3 was fetched but never
    // upserted (the page never finished), and m4 was never fetched at all.
    expect(await cachedIds(db)).toEqual(["m1", "m2"]);
    expect(await getSyncState(db, SYNC_KEYS.historyId)).toBeNull();
    expect(await getSyncState(db, SYNC_KEYS.lastFullScanAt)).toBeNull();
    expect(await getSyncState(db, SYNC_KEYS.scanStartHistoryId)).toBe("h1");
  });

  it("resuming after an abort skips cached ids and keeps the ORIGINAL scan_start_history_id as the final historyId", async () => {
    const db = createTestDb();
    const messages = new Map(
      ["m1", "m2", "m3", "m4"].map((id) => [
        id,
        makeMessage({ id, from: `${id}@x.com`, date: "2024-01-01T00:00:00Z" }),
      ]),
    );
    const pages = () => [
      { ids: ["m1", "m2"], nextPageToken: "p2" },
      { ids: ["m3", "m4"], nextPageToken: null },
    ];

    // The mailbox's historyId moves on between the interrupted attempt and
    // the resumed one, simulating new mail arriving in between. A resumed
    // scan must still finish at the *first* attempt's historyId.
    let profileCall = 0;
    const profiles: GmailProfile[] = [
      { ...PROFILE, historyId: "h1" },
      { ...PROFILE, historyId: "h2" },
    ];
    const getProfile = () =>
      profiles[profileCall++] ?? profiles[profiles.length - 1]!;

    const controller = new AbortController();
    const firstAttempt = createFakeGmail({
      getProfile,
      pages: pages(),
      messages,
      onAfterFetch: (id) => {
        if (id === "m3") {
          controller.abort();
        }
      },
    });

    await expect(
      runFullScan({
        gmail: firstAttempt,
        db,
        now: () => 1,
        signal: controller.signal,
        concurrency: 1,
      }),
    ).rejects.toBeInstanceOf(DOMException);
    expect(await cachedIds(db)).toEqual(["m1", "m2"]);

    const resumedAttempt = createFakeGmail({
      getProfile,
      pages: pages(),
      messages,
    });
    const result = await runFullScan({
      gmail: resumedAttempt,
      db,
      now: () => 2,
      concurrency: 1,
    });

    expect(result.alreadyCached).toBe(2); // m1, m2 skipped this run
    expect(result.fetched).toBe(2); // m3, m4 fetched this run
    expect(result.historyId).toBe("h1"); // the ORIGINAL id, not h2
    expect(await cachedIds(db)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(await getSyncState(db, SYNC_KEYS.historyId)).toBe("h1");
    expect(await getSyncState(db, SYNC_KEYS.scanStartHistoryId)).toBeNull();
  });

  it("never runs more getMessageMetadata calls at once than `concurrency`", async () => {
    const db = createTestDb();
    const ids = Array.from({ length: 25 }, (_, i) => `m${i}`);
    const messages = new Map(
      ids.map((id) => [
        id,
        makeMessage({ id, from: "a@x.com", date: "2024-01-01T00:00:00Z" }),
      ]),
    );
    const tracker: ConcurrencyTracker = { current: 0, max: 0 };
    const gmail = createFakeGmail({
      getProfile: () => PROFILE,
      pages: [{ ids, nextPageToken: null }],
      messages,
      tracker,
      delayMs: 1,
    });

    const result = await runFullScan({
      gmail,
      db,
      now: () => 1,
      concurrency: 4,
    });

    expect(result.fetched).toBe(25);
    expect(tracker.max).toBeLessThanOrEqual(4);
    expect(tracker.max).toBeGreaterThan(1); // sanity: actually ran concurrently
  });

  it("stops sibling workers as soon as one getMessageMetadata call fails, and rejects with that original error", async () => {
    const db = createTestDb();
    const badError = new GmailApiError(403, "insufficientPermissions", "nope");
    // Only "bad", "g1" and "g2" should ever be started: with concurrency 3,
    // those are the only ids the 3 workers grab before "bad" fails and
    // stops the pool. "g3".."g9" must never be fetched.
    const ids = ["bad", "g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9"];

    let inFlight = 0;
    const started: string[] = [];
    const sawAbortedSignal: string[] = [];

    const gmail: Pick<
      GmailClient,
      "getProfile" | "listMessageIds" | "getMessageMetadata"
    > = {
      getProfile: () => Promise.resolve(PROFILE),
      listMessageIds: () =>
        Promise.resolve({
          ids,
          nextPageToken: null,
          resultSizeEstimate: ids.length,
        }),
      getMessageMetadata: async (id, signal) => {
        started.push(id);
        inFlight += 1;
        try {
          if (id === "bad") {
            // Fails immediately (no delay), so it's the first to settle.
            throw badError;
          }
          // The "good" ids are still in flight when "bad" fails; give
          // them time to observe the internal signal aborting.
          await new Promise((resolve) => setTimeout(resolve, 15));
          if (signal?.aborted) {
            sawAbortedSignal.push(id);
            throw signal.reason;
          }
          return makeMessage({
            id,
            from: "a@x.com",
            date: "2024-01-01T00:00:00Z",
          });
        } finally {
          inFlight -= 1;
        }
      },
    };

    await expect(
      runFullScan({ gmail, db, now: () => 1, concurrency: 3 }),
    ).rejects.toBe(badError);

    // No fetch was left running once runFullScan settled.
    expect(inFlight).toBe(0);
    // Only the 3 initially-dispatched ids ever started.
    expect(started.sort()).toEqual(["bad", "g1", "g2"]);
    // Both in-flight siblings observed the abort.
    expect(sawAbortedSignal.sort()).toEqual(["g1", "g2"]);
    // The failed page's rows (none, since none of "g1"/"g2" got stored)
    // were never committed, and no sync state got written this run.
    expect(await cachedIds(db)).toEqual([]);
    expect(await getSyncState(db, SYNC_KEYS.historyId)).toBeNull();
  });

  it("still rejects with the outer signal's abort reason even if a worker fails around the same time", async () => {
    const db = createTestDb();
    const ids = ["a", "b", "c"];
    const messages = new Map(
      ids.map((id) => [
        id,
        makeMessage({ id, from: "a@x.com", date: "2024-01-01T00:00:00Z" }),
      ]),
    );
    const controller = new AbortController();
    const gmail = createFakeGmail({
      getProfile: () => PROFILE,
      pages: [{ ids, nextPageToken: null }],
      messages,
      onAfterFetch: () => controller.abort(),
    });

    await expect(
      runFullScan({
        gmail,
        db,
        now: () => 1,
        signal: controller.signal,
        concurrency: 1,
      }),
    ).rejects.toBeInstanceOf(DOMException);
  });

  it("emits progress events that are monotonic per field and end with phase 'done'", async () => {
    const db = createTestDb();
    const ids = Array.from({ length: 120 }, (_, i) => `m${i}`);
    const messages = new Map(
      ids.map((id) => [
        id,
        makeMessage({ id, from: "a@x.com", date: "2024-01-01T00:00:00Z" }),
      ]),
    );
    const gmail = createFakeGmail({
      getProfile: () => PROFILE,
      pages: [{ ids, nextPageToken: null }],
      messages,
    });
    const events: ScanProgress[] = [];

    await runFullScan({
      gmail,
      db,
      now: () => 1,
      onProgress: (progress) => events.push(progress),
    });

    expect(events[0]!.phase).toBe("starting");
    expect(events[events.length - 1]!.phase).toBe("done");
    expect(events[events.length - 1]).toMatchObject({
      listed: 120,
      fetched: 120,
    });

    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.listed).toBeGreaterThanOrEqual(events[i - 1]!.listed);
      expect(events[i]!.fetched).toBeGreaterThanOrEqual(events[i - 1]!.fetched);
      expect(events[i]!.alreadyCached).toBeGreaterThanOrEqual(
        events[i - 1]!.alreadyCached,
      );
      expect(events[i]!.skippedDeleted).toBeGreaterThanOrEqual(
        events[i - 1]!.skippedDeleted,
      );
    }

    // Throttled: not silent for the whole page, but not one event per
    // message either.
    const scanningEvents = events.filter((e) => e.phase === "scanning");
    expect(scanningEvents.length).toBeGreaterThan(1);
    expect(scanningEvents.length).toBeLessThan(120);
  });
});

describe("getScanStatus", () => {
  it("reports the empty state for a fresh database", async () => {
    const db = createTestDb();
    expect(await getScanStatus(db)).toEqual({
      accountEmail: null,
      lastFullScanAt: null,
      inProgress: false,
    });
  });

  it("reports inProgress while scan_start_history_id is set", async () => {
    const db = createTestDb();
    await setSyncState(db, SYNC_KEYS.accountEmail, "alex@example.com");
    await setSyncState(db, SYNC_KEYS.scanStartHistoryId, "h1");

    expect(await getScanStatus(db)).toEqual({
      accountEmail: "alex@example.com",
      lastFullScanAt: null,
      inProgress: true,
    });
  });

  it("reports the completed state after a full scan finishes", async () => {
    const db = createTestDb();
    const gmail = createFakeGmail({
      getProfile: () => PROFILE,
      pages: [{ ids: [], nextPageToken: null }],
      messages: new Map(),
    });

    await runFullScan({ gmail, db, now: () => 5000 });

    expect(await getScanStatus(db)).toEqual({
      accountEmail: "alex@example.com",
      lastFullScanAt: 5000,
      inProgress: false,
    });
  });
});
