/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, SqlParam } from "./db";

// node:sqlite is still an experimental module and logs a one-time
// `ExperimentalWarning` the moment it's loaded. That's expected here (it's
// only used in tests) and shouldn't be mistaken for a real problem, so we
// silence just that message. It has to be patched *before* the module is
// loaded, hence `require` (which runs synchronously right here) instead of a
// static `import`, which Node would hoist above this patch.
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning.message;
  if (message.includes("SQLite is an experimental feature")) {
    return;
  }
  (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
};

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

type SqliteBindable = string | number | null;

/**
 * Mirrors `tauri-plugin-sql`'s own parameter binding (see
 * `tauri-plugin-sql` 2.4.1's `src/wrapper.rs`, `DbPool::Sqlite::execute`/
 * `select`): `null`/`undefined` bind as SQL `NULL`, strings and numbers
 * bind natively, and *everything else* — notably booleans, arrays and
 * objects — falls through to `query.bind(value)`, which binds a
 * `serde_json::Value` that sqlx-sqlite encodes as TEXT JSON. In practice
 * that means a JS `true` is stored as the three-character string `"true"`,
 * not the integer `1`. Don't rely on this fallback for flag columns —
 * convert booleans to `0`/`1` (or `SqlParam`-typed values generally)
 * before calling `execute`/`select`; this only exists so the test adapter
 * reproduces the real trap instead of quietly avoiding it.
 */
function toBindable(value: unknown): SqliteBindable {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return JSON.stringify(value);
}

/** Node's built-in `node:sqlite` doesn't bind `$1, $2, …` positionally, only
 * as named parameters — convert our positional array into `{ $1: …, $2: … }`. */
function toNamedParams(
  params: readonly unknown[],
): Record<string, SqliteBindable> {
  const named: Record<string, SqliteBindable> = {};
  params.forEach((value, index) => {
    named[`$${index + 1}`] = toBindable(value);
  });
  return named;
}

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src-tauri/migrations",
);

function applyMigrations(db: InstanceType<typeof DatabaseSync>): void {
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    db.exec(sql);
  }
}

/** An in-memory `Db`, migrated the same way the real app database is, for
 * use in tests. */
export function createTestDb(): Db {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);

  return {
    execute: (sql, params: SqlParam[] = []) => {
      const stmt = sqlite.prepare(sql);
      const result = stmt.run(toNamedParams(params));
      return Promise.resolve({ rowsAffected: Number(result.changes) });
    },
    select: <T>(sql: string, params: SqlParam[] = []) => {
      const stmt = sqlite.prepare(sql);
      const rows = stmt.all(toNamedParams(params));
      return Promise.resolve(rows.map((row) => ({ ...row })) as T[]);
    },
  };
}
