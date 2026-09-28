/**
 * An in-memory `Db` backed by `@sqlite.org/sqlite-wasm`, migrated the same
 * way the real app database is (`src-tauri/migrations/`). Used only by
 * browser demo mode (`src/dev/demoServices.ts`) — there's no Tauri runtime
 * there to back `@tauri-apps/plugin-sql` (`lib/platform/sql.ts`).
 *
 * Runs entirely on the main thread with an in-memory (`:memory:`) database,
 * not OPFS — so, unlike the worker/OPFS setup sqlite-wasm's own docs lead
 * with, this needs no `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-
 * Policy` headers or `SharedArrayBuffer`.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type { Db, SqlParam } from "@/lib/db/db";

// Vite-only: inlines every migration file's contents at build time. The
// glob is rooted at the project root (leading `/`), not `src/`, since
// migrations live in `src-tauri/migrations/`.
const migrationModules = import.meta.glob<string>(
  "/src-tauri/migrations/*.sql",
  { query: "?raw", import: "default", eager: true },
);

/** All migrations concatenated in filename order — the same order
 * `lib/db/testing.ts` applies them in for tests, and `tauri-plugin-sql`
 * applies them in for the real app. */
function migrationSql(): string {
  return Object.keys(migrationModules)
    .sort()
    .map((path) => migrationModules[path]!)
    .join("\n");
}

type SqliteBindable = string | number | null;

/** Mirrors `tauri-plugin-sql`'s own parameter binding — see the identical
 * (and more detailed) comment on `toBindable` in `lib/db/testing.ts`. */
function toBindable(value: unknown): SqliteBindable {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return JSON.stringify(value);
}

let sqlite3Promise: Promise<Sqlite3Static> | null = null;

/** Loads (once) and returns the sqlite-wasm module. */
function getSqlite3(): Promise<Sqlite3Static> {
  if (!sqlite3Promise) {
    sqlite3Promise = sqlite3InitModule();
  }
  return sqlite3Promise;
}

/** Opens a fresh in-memory `Db`, migrated and ready to use. Each call gets
 * its own independent database. */
export async function createWasmDb(): Promise<Db> {
  const sqlite3 = await getSqlite3();
  const database: Database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec(migrationSql());

  return {
    execute: (sql: string, params: SqlParam[] = []) => {
      database.exec({ sql, bind: params.map(toBindable) });
      return Promise.resolve({ rowsAffected: Number(database.changes()) });
    },
    select: <T>(sql: string, params: SqlParam[] = []) => {
      const rows = database.selectObjects(sql, params.map(toBindable));
      return Promise.resolve(rows as T[]);
    },
  };
}
