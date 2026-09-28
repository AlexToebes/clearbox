/**
 * The browser demo mode `Services` (see `docs/ARCHITECTURE.md` and the
 * README's "Demo mode" section): the same shape `src/app/services.ts`
 * builds, but with fake `AuthSession`/`GmailClient` implementations and an
 * in-memory `Db` (`src/dev/wasmDb.ts`) standing in for the Tauri-backed
 * ones. Everything above the platform edge — the UI, the real scan
 * controller/`runFullScan`, and every SQL query — runs unmodified.
 *
 * Only reachable via `pnpm dev:demo` (`vite --mode demo`): `vite.config.ts`
 * aliases `@/app/services` to this file solely in that mode, so none of
 * this (or `@sqlite.org/sqlite-wasm`) is ever pulled into a production
 * build. This module therefore imports the real `src/app/services.ts` by
 * *relative* path — importing it as `@/app/services` here would hit that
 * same alias and import this file right back.
 */

import {
  createScan,
  createSignOutAndClear,
  type Services,
} from "../app/services";
import type { Db } from "@/lib/db/db";
import { setSyncState, SYNC_KEYS, upsertMessages } from "@/lib/db/queries";
import type { AuthSession, AuthStatus } from "@/lib/auth/session";
import { OAuthError } from "@/lib/auth/google";
import type { GmailClient, ListMessageIdsOptions } from "@/lib/gmail/client";
import { toMessageRow } from "@/lib/gmail/parse";
import { sleepAbortable } from "@/lib/gmail/rateLimiter";
import type { GmailMessage, GmailProfile } from "@/lib/gmail/types";
import { generateFakeMailbox } from "./fakeMailbox";
import { createWasmDb } from "./wasmDb";

const DEMO_EMAIL = "demo@example.com";
const DEMO_HISTORY_ID = "1000";
const LIST_PAGE_SIZE = 500;
/** Base range for `getMessageMetadata`'s simulated network latency, before
 * the `?speed=` multiplier. */
const BASE_LATENCY_MS: readonly [number, number] = [5, 30];

interface DemoOptions {
  messageCount: number;
  seed: number;
  /** Latency multiplier; 0 = instant. */
  speed: number;
  /** Pre-populate the database as though a full scan already ran. */
  preScanned: boolean;
}

function readDemoOptions(): DemoOptions {
  const params = new URLSearchParams(window.location.search);

  function numberParam(name: string, fallback: number): number {
    const raw = params.get(name);
    if (raw === null) {
      return fallback;
    }
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  return {
    messageCount: numberParam("messages", 20000),
    seed: numberParam("seed", 1),
    speed: numberParam("speed", 1),
    preScanned: params.get("scanned") === "1",
  };
}

// ---------------------------------------------------------------------
// Fake AuthSession: always signed in, no network/keychain involved.
// ---------------------------------------------------------------------

function createFakeAuthSession(): AuthSession {
  let status: AuthStatus = "signed_in";
  const listeners = new Set<() => void>();

  function setStatus(next: AuthStatus): void {
    if (status === next) {
      return;
    }
    status = next;
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    status: () => status,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    restore: () => Promise.resolve(true),
    signIn: () => {
      setStatus("signed_in");
      return Promise.resolve();
    },
    getAccessToken: () =>
      status === "signed_in"
        ? Promise.resolve("demo-access-token")
        : Promise.reject(new OAuthError("not_signed_in")),
    invalidateAccessToken: () => {
      // Nothing to invalidate — there's no real token.
    },
    signOut: () => {
      setStatus("signed_out");
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------
// Fake GmailClient: serves a generated mailbox out of memory.
// ---------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeGmailClient(
  messages: readonly GmailMessage[],
  speed: number,
): GmailClient {
  // `messages` is already newest-first (see `generateFakeMailbox`), same
  // as Gmail's own `messages.list` default ordering.
  const idsNewestFirst = messages.map((m) => m.id);
  const byId = new Map(messages.map((m) => [m.id, m]));

  async function simulatedLatency(signal?: AbortSignal): Promise<void> {
    if (speed <= 0) {
      return;
    }
    const [min, max] = BASE_LATENCY_MS;
    const ms = (min + Math.random() * (max - min)) * speed;
    await sleepAbortable(sleep, ms, signal);
  }

  return {
    getProfile: async (signal?: AbortSignal): Promise<GmailProfile> => {
      await simulatedLatency(signal);
      return {
        emailAddress: DEMO_EMAIL,
        // A real mailbox's `messagesTotal` includes Spam/Trash, which
        // `messages.list` (and so this fake) excludes — pad it a little so
        // the scan's progress bar behaves the same way it does for real.
        messagesTotal: Math.round(messages.length * 1.02),
        threadsTotal: messages.length,
        historyId: DEMO_HISTORY_ID,
      };
    },

    listMessageIds: async (opts: ListMessageIdsOptions = {}) => {
      await simulatedLatency(opts.signal);
      const maxResults = opts.maxResults ?? LIST_PAGE_SIZE;
      const start = opts.pageToken ? Number(opts.pageToken) : 0;
      const page = idsNewestFirst.slice(start, start + maxResults);
      const next = start + maxResults;
      return {
        ids: page,
        nextPageToken: next < idsNewestFirst.length ? String(next) : null,
        resultSizeEstimate: idsNewestFirst.length,
      };
    },

    getMessageMetadata: async (id: string, signal?: AbortSignal) => {
      await simulatedLatency(signal);
      return byId.get(id) ?? null;
    },
  };
}

// ---------------------------------------------------------------------
// Wiring: a real ScanController/signOutAndClear (from `app/services.ts`)
// around the fakes above and an in-memory `Db`.
// ---------------------------------------------------------------------

let services: Services | null = null;

/** Same shape as `app/services.ts`'s `getServices()`, but every platform
 * edge (auth, Gmail, the database) is faked — see the module doc comment. */
export function getServices(): Services | null {
  if (services) {
    return services;
  }

  const options = readDemoOptions();
  const now = Date.now();
  const messages = generateFakeMailbox({
    seed: options.seed,
    messageCount: options.messageCount,
    now,
  });

  const auth = createFakeAuthSession();
  const gmail = createFakeGmailClient(messages, options.speed);

  let dbPromise: Promise<Db> | null = null;
  function getDb(): Promise<Db> {
    if (!dbPromise) {
      dbPromise = createWasmDb().then(async (db) => {
        if (options.preScanned) {
          await upsertMessages(db, messages.map(toMessageRow));
          await setSyncState(db, SYNC_KEYS.accountEmail, DEMO_EMAIL);
          await setSyncState(db, SYNC_KEYS.historyId, DEMO_HISTORY_ID);
          await setSyncState(db, SYNC_KEYS.lastFullScanAt, String(now));
        }
        return db;
      });
    }
    return dbPromise;
  }

  const scan = createScan(gmail, getDb);
  const signOutAndClear = createSignOutAndClear(auth, scan, getDb);

  services = { auth, gmail, getDb, scan, signOutAndClear };
  return services;
}
