import type { Db } from "./db";
import type { MessageRow } from "./types";

/** A single SQL statement is limited to this many bound parameters, so
 * batch operations are chunked to stay under it. */
const MAX_PARAMS = 900;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

const MESSAGE_COLUMNS = [
  "id",
  "thread_id",
  "from_name",
  "from_email",
  "from_domain",
  "subject",
  "internal_date",
  "size_estimate",
  "label_ids",
  "is_unread",
  "is_trashed",
  "list_unsubscribe",
  "list_unsubscribe_post",
] as const satisfies readonly (keyof MessageRow)[];

const ROWS_PER_UPSERT_CHUNK = Math.floor(MAX_PARAMS / MESSAGE_COLUMNS.length);

/**
 * Inserts (or updates) message rows. On conflict only the fields that can
 * actually change after a message is first cached — labels, unread and
 * trashed state — are overwritten.
 */
export async function upsertMessages(
  db: Db,
  rows: MessageRow[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  for (const batch of chunk(rows, ROWS_PER_UPSERT_CHUNK)) {
    const params: unknown[] = [];
    const valuesSql = batch
      .map((row) => {
        const placeholders = MESSAGE_COLUMNS.map((column) => {
          params.push(row[column]);
          return `$${params.length}`;
        });
        return `(${placeholders.join(", ")})`;
      })
      .join(", ");

    await db.execute(
      `INSERT INTO messages (${MESSAGE_COLUMNS.join(", ")})
       VALUES ${valuesSql}
       ON CONFLICT(id) DO UPDATE SET
         label_ids = excluded.label_ids,
         is_unread = excluded.is_unread,
         is_trashed = excluded.is_trashed`,
      params,
    );
  }
}

/** Which of the given message ids are already cached. */
export async function getKnownIds(db: Db, ids: string[]): Promise<Set<string>> {
  const known = new Set<string>();
  if (ids.length === 0) {
    return known;
  }

  for (const batch of chunk(ids, MAX_PARAMS)) {
    const placeholders = batch.map((_, i) => `$${i + 1}`).join(", ");
    const rows = await db.select<{ id: string }>(
      `SELECT id FROM messages WHERE id IN (${placeholders})`,
      batch,
    );
    for (const row of rows) {
      known.add(row.id);
    }
  }

  return known;
}

/** Marks (or unmarks) the given message ids as trashed in the local cache. */
export async function setTrashed(
  db: Db,
  ids: string[],
  trashed: boolean,
): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  // One param slot is reserved for `trashed` itself.
  const idsPerChunk = MAX_PARAMS - 1;
  for (const batch of chunk(ids, idsPerChunk)) {
    const placeholders = batch.map((_, i) => `$${i + 2}`).join(", ");
    await db.execute(
      `UPDATE messages SET is_trashed = $1 WHERE id IN (${placeholders})`,
      [trashed, ...batch],
    );
  }
}

export interface CacheSummary {
  totalMessages: number;
  unreadMessages: number;
  totalBytes: number;
  distinctSenders: number;
  sendersWithUnsubscribe: number;
}

/** Aggregate stats over the non-trashed cache. */
export async function getSummary(db: Db): Promise<CacheSummary> {
  const rows = await db.select<{
    total_messages: number;
    unread_messages: number;
    total_bytes: number;
    distinct_senders: number;
    senders_with_unsubscribe: number;
  }>(
    `SELECT
       COUNT(*) AS total_messages,
       COALESCE(SUM(is_unread), 0) AS unread_messages,
       COALESCE(SUM(size_estimate), 0) AS total_bytes,
       COUNT(DISTINCT from_email) AS distinct_senders,
       COUNT(DISTINCT CASE
         WHEN list_unsubscribe IS NOT NULL OR list_unsubscribe_post IS NOT NULL
         THEN from_email
       END) AS senders_with_unsubscribe
     FROM messages
     WHERE is_trashed = 0`,
  );

  // An aggregate query with no GROUP BY always returns exactly one row.
  const row = rows[0]!;
  return {
    totalMessages: Number(row.total_messages),
    unreadMessages: Number(row.unread_messages),
    totalBytes: Number(row.total_bytes),
    distinctSenders: Number(row.distinct_senders),
    sendersWithUnsubscribe: Number(row.senders_with_unsubscribe),
  };
}

export interface SenderStats {
  key: string;
  displayName: string;
  messageCount: number;
  unreadCount: number;
  totalBytes: number;
  firstDate: number;
  lastDate: number;
  hasUnsubscribe: boolean;
}

export type SenderGroupBy = "email" | "domain";
export type SenderSortBy = "count" | "size" | "unread" | "latest";

// Fixed whitelists: caller-provided groupBy/sortBy values are only ever
// used to index into these, never interpolated into SQL directly.
const GROUP_COLUMNS: Record<SenderGroupBy, "from_email" | "from_domain"> = {
  email: "from_email",
  domain: "from_domain",
};

const SORT_EXPRESSIONS: Record<SenderSortBy, string> = {
  count: "COUNT(*)",
  size: "SUM(m.size_estimate)",
  unread: "SUM(m.is_unread)",
  latest: "MAX(m.internal_date)",
};

function escapeLikeWildcards(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface GetSendersOptions {
  groupBy: SenderGroupBy;
  sortBy: SenderSortBy;
  limit?: number;
  search?: string;
}

/** Per-sender (or per-domain) stats over the non-trashed cache. */
export async function getSenders(
  db: Db,
  opts: GetSendersOptions,
): Promise<SenderStats[]> {
  const groupColumn = `m.${GROUP_COLUMNS[opts.groupBy]}`;
  const sortExpr = SORT_EXPRESSIONS[opts.sortBy];

  const params: unknown[] = [];
  const whereClauses = ["m.is_trashed = 0"];

  const search = opts.search?.trim();
  if (search) {
    const pattern = `%${escapeLikeWildcards(search.toLowerCase())}%`;
    params.push(pattern, pattern);
    whereClauses.push(
      `(LOWER(${groupColumn}) LIKE $${params.length - 1} ESCAPE '\\' ` +
        `OR LOWER(COALESCE(m.from_name, '')) LIKE $${params.length} ESCAPE '\\')`,
    );
  }

  const displayNameExpr =
    opts.groupBy === "email"
      ? `(SELECT m2.from_name FROM messages m2
           WHERE m2.from_email = m.from_email
             AND m2.is_trashed = 0
             AND m2.from_name IS NOT NULL
           ORDER BY m2.internal_date DESC
           LIMIT 1)`
      : "m.from_domain";

  let sql = `
    SELECT
      ${groupColumn} AS key,
      ${displayNameExpr} AS display_name,
      COUNT(*) AS message_count,
      SUM(m.is_unread) AS unread_count,
      SUM(m.size_estimate) AS total_bytes,
      MIN(m.internal_date) AS first_date,
      MAX(m.internal_date) AS last_date,
      MAX(CASE
        WHEN m.list_unsubscribe IS NOT NULL OR m.list_unsubscribe_post IS NOT NULL
        THEN 1 ELSE 0
      END) AS has_unsubscribe
    FROM messages m
    WHERE ${whereClauses.join(" AND ")}
    GROUP BY ${groupColumn}
    ORDER BY ${sortExpr} DESC, key ASC
  `;

  if (opts.limit !== undefined) {
    params.push(opts.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const rows = await db.select<{
    key: string;
    display_name: string | null;
    message_count: number;
    unread_count: number;
    total_bytes: number;
    first_date: number;
    last_date: number;
    has_unsubscribe: number;
  }>(sql, params);

  return rows.map((row) => ({
    key: row.key,
    displayName: row.display_name ?? row.key,
    messageCount: Number(row.message_count),
    unreadCount: Number(row.unread_count),
    totalBytes: Number(row.total_bytes),
    firstDate: Number(row.first_date),
    lastDate: Number(row.last_date),
    hasUnsubscribe: Boolean(row.has_unsubscribe),
  }));
}

export interface MonthlyVolume {
  /** `YYYY-MM`, in UTC. */
  month: string;
  /** `null` when no `keys` were requested (a single total-per-month row). */
  key: string | null;
  count: number;
}

export interface GetMonthlyVolumeOptions {
  groupBy?: SenderGroupBy;
  keys?: string[];
}

/** Message counts per UTC month over the non-trashed cache. */
export async function getMonthlyVolume(
  db: Db,
  opts?: GetMonthlyVolumeOptions,
): Promise<MonthlyVolume[]> {
  const keys = opts?.keys ?? [];

  if (keys.length === 0) {
    const rows = await db.select<{ month: string; count: number }>(
      `SELECT strftime('%Y-%m', internal_date / 1000, 'unixepoch') AS month,
              COUNT(*) AS count
       FROM messages
       WHERE is_trashed = 0
       GROUP BY month
       ORDER BY month`,
    );
    return rows.map((row) => ({
      month: row.month,
      key: null,
      count: Number(row.count),
    }));
  }

  const groupColumn = GROUP_COLUMNS[opts?.groupBy ?? "email"];
  const results: MonthlyVolume[] = [];

  for (const batch of chunk(keys, MAX_PARAMS)) {
    const placeholders = batch.map((_, i) => `$${i + 1}`).join(", ");
    const rows = await db.select<{
      month: string;
      key: string;
      count: number;
    }>(
      `SELECT strftime('%Y-%m', internal_date / 1000, 'unixepoch') AS month,
              ${groupColumn} AS key,
              COUNT(*) AS count
       FROM messages
       WHERE is_trashed = 0 AND ${groupColumn} IN (${placeholders})
       GROUP BY month, ${groupColumn}`,
      batch,
    );
    for (const row of rows) {
      results.push({
        month: row.month,
        key: row.key,
        count: Number(row.count),
      });
    }
  }

  results.sort((a, b) =>
    a.month === b.month
      ? (a.key ?? "").localeCompare(b.key ?? "")
      : a.month.localeCompare(b.month),
  );

  return results;
}

/** Reads a `sync_state` value (`null` if unset). */
export async function getSyncState(
  db: Db,
  key: string,
): Promise<string | null> {
  const rows = await db.select<{ value: string }>(
    "SELECT value FROM sync_state WHERE key = $1",
    [key],
  );
  return rows[0]?.value ?? null;
}

/** Writes (or overwrites) a `sync_state` value. */
export async function setSyncState(
  db: Db,
  key: string,
  value: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO sync_state (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}
