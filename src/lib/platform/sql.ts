import Database from "@tauri-apps/plugin-sql";
import type { Db } from "@/lib/db/db";

/**
 * Opens (and, via `tauri-plugin-sql`'s configured migrations, migrates) the
 * app's local SQLite database. This is the only module allowed to import
 * `@tauri-apps/*` so the rest of the app can be unit-tested without a Tauri
 * runtime.
 */
export async function openDatabase(): Promise<Db> {
  const database = await Database.load("sqlite:clearbox.db");

  return {
    execute: (sql, params) => database.execute(sql, params),
    select: <T>(sql: string, params?: unknown[]) =>
      database.select<T[]>(sql, params),
  };
}
