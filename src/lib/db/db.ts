/**
 * A value that can be safely bound as a SQL parameter. `tauri-plugin-sql`
 * (see `lib/platform/sql.ts`) only binds `null`, strings and numbers
 * natively — anything else (including booleans, arrays and objects) is
 * silently serialized as JSON text instead, which is almost never what you
 * want for a flag column. Keeping this type narrow makes passing a boolean
 * a compile error; convert it to `0`/`1` at the call site instead.
 */
export type SqlParam = string | number | null;

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
  execute(sql: string, params?: SqlParam[]): Promise<{ rowsAffected: number }>;
  select<T>(sql: string, params?: SqlParam[]): Promise<T[]>;
}
