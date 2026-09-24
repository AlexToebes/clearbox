/**
 * A row of the `messages` table. Property names are identical to the
 * columns (see `src-tauri/migrations/0001_init.sql`) so mapping to/from SQL
 * stays a straight pass-through.
 */
export interface MessageRow {
  id: string;
  thread_id: string;
  from_name: string | null;
  from_email: string;
  from_domain: string;
  subject: string | null;
  /** Milliseconds since the epoch. */
  internal_date: number;
  /** Bytes. */
  size_estimate: number;
  /** JSON-encoded array of Gmail label ids. */
  label_ids: string;
  /** 0/1 — bound as a real SQLite integer, never a JS boolean (see
   * `SqlParam` in `lib/db/db.ts`). */
  is_unread: 0 | 1;
  is_trashed: 0 | 1;
  list_unsubscribe: string | null;
  list_unsubscribe_post: string | null;
}
