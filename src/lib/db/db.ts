/**
 * The minimal database interface the rest of the app depends on. In the
 * Tauri app this is backed by `@tauri-apps/plugin-sql` (see
 * `lib/platform/sql.ts`); in tests it's backed by Node's built-in
 * `node:sqlite` (see `lib/db/testing.ts`).
 *
 * SQL uses `$1, $2, …` placeholders, matching what `tauri-plugin-sql`
 * expects.
 */
export interface Db {
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>;
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
}
