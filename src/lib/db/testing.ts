/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db";

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

type SqlBindable = string | number | bigint | null;

/** Node's built-in `node:sqlite` doesn't bind `$1, $2, …` positionally, only
 * as named parameters — convert our positional array into `{ $1: …, $2: … }`. */
function toNamedParams(params: unknown[]): Record<string, SqlBindable> {
  const named: Record<string, SqlBindable> = {};
  params.forEach((value, index) => {
    let bound: SqlBindable;
    if (typeof value === "boolean") {
      bound = value ? 1 : 0;
    } else if (value === undefined) {
      bound = null;
    } else {
      bound = value as SqlBindable;
    }
    named[`$${index + 1}`] = bound;
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
    execute: (sql, params = []) => {
      const stmt = sqlite.prepare(sql);
      const result = stmt.run(toNamedParams(params));
      return Promise.resolve({ rowsAffected: Number(result.changes) });
    },
    select: <T>(sql: string, params: unknown[] = []) => {
      const stmt = sqlite.prepare(sql);
      const rows = stmt.all(toNamedParams(params));
      return Promise.resolve(rows.map((row) => ({ ...row })) as T[]);
    },
  };
}
