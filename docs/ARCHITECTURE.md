# Clearbox architecture

Clearbox is a local-first desktop app that helps clean up a Gmail mailbox.
Message metadata is fetched from the Gmail API into a local SQLite database,
and every insight (grouping by sender, sizes, volume over time) is a SQL query
against that cache. Nothing is sent to a Clearbox server — there is none.

## Principles

- **Local-first.** Email metadata and tokens never leave the device. This keeps
  user data private and keeps the Google OAuth verification path light (no
  server that stores restricted-scope data).
- **Metadata only.** We fetch headers (`From`, `Subject`, `List-Unsubscribe`,
  `List-Unsubscribe-Post`), labels, dates and sizes. Never message bodies.
- **Reversible actions.** We trash, never permanently delete. Every bulk action
  can be undone.
- **Thin Rust, fat TypeScript.** Rust only hosts Tauri plugins and a few
  commands that need native APIs (OS keychain). All app logic is TypeScript so
  it can be unit-tested with Vitest without a Tauri runtime.

## Stack

| Concern                       | Choice                                                           |
| ----------------------------- | ---------------------------------------------------------------- |
| Desktop shell                 | Tauri 2                                                          |
| UI                            | React, Vite, TypeScript (strict)                                 |
| Styling / components          | Tailwind CSS v4, shadcn/ui                                       |
| Charts                        | shadcn/ui charts (Recharts)                                      |
| Tables                        | TanStack Table + TanStack Virtual                                |
| Data fetching / caching in UI | TanStack Query                                                   |
| Local database                | SQLite via `tauri-plugin-sql`                                    |
| HTTP                          | `tauri-plugin-http` (requests from Rust: no CORS, URL allowlist) |
| OAuth loopback server         | `tauri-plugin-oauth`                                             |
| Open system browser           | `tauri-plugin-opener`                                            |
| Secret storage                | OS keychain via the `keyring` crate (small Rust commands)        |
| Tests                         | Vitest; SQL tests use Node's built-in `node:sqlite`              |

## Layout

```
src/
  main.tsx, App.tsx          app entry, top-level screens
  components/ui/             shadcn/ui components (generated)
  lib/
    platform/                thin wrappers around Tauri APIs (http, keychain,
                             opener, oauth, sql) — the only place that imports
                             @tauri-apps/* so everything else is testable
    auth/                    PKCE, auth URL, token exchange/refresh, session
    gmail/                   Gmail REST client + header parsing
    db/                      Db interface, typed queries
    sync/                    full scan + incremental sync (issues #4, #5)
  features/                  UI features (dashboard, senders, ...)
src-tauri/
  migrations/                SQL migrations (single source of truth; also
                             loaded by the TS tests)
  src/lib.rs                 plugin registration, keychain commands
  capabilities/              permission + HTTP URL allowlist
```

Dependency direction: `features → lib/{sync,db,gmail,auth} → lib/platform`.
Modules under `lib/` take their dependencies (fetch, Db, clock, secret store)
as parameters so tests can pass fakes.

## Authentication (issue #2)

Google OAuth 2.0 for installed apps, using a loopback redirect with PKCE:

1. Generate a PKCE verifier/challenge (S256) and a random `state`.
2. `tauri-plugin-oauth` starts a one-shot HTTP server on `127.0.0.1:<port>`.
3. Open `accounts.google.com/o/oauth2/v2/auth?...&redirect_uri=http://127.0.0.1:<port>`
   in the system browser with `access_type=offline&prompt=consent`.
4. The plugin receives the redirect; we check `state` and exchange the code at
   `oauth2.googleapis.com/token` (with `code_verifier`, and the Desktop
   client's non-confidential `client_secret`).
5. The refresh token goes into the OS keychain; the access token stays in memory
   and is refreshed shortly before expiry or on a 401.

Scope: `https://www.googleapis.com/auth/gmail.modify`. It covers reading
metadata and moving messages to/from Trash. We deliberately avoid
`https://mail.google.com/` (permanent delete) and `gmail.send`.

Client credentials come from `.env.local` (`VITE_GOOGLE_CLIENT_ID`,
`VITE_GOOGLE_CLIENT_SECRET`), see the README.

## Local database (issue #3)

`messages` holds one row per message (id, thread, parsed sender name/email/
domain, subject, date, size, labels, unread flag, unsubscribe headers).
`sync_state` is a key/value table (account, history id, scan timestamps).
Migrations live in `src-tauri/migrations/` and are applied by
`tauri-plugin-sql` at startup.

The TypeScript side only depends on:

```ts
interface Db {
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>;
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
}
```

In the app this is backed by `@tauri-apps/plugin-sql`; in tests by
`node:sqlite` running the same migration files. SQL uses `$1, $2, …`
placeholders (what `tauri-plugin-sql` expects); the test adapter binds them as
named parameters.

## Sync (issues #4, #5)

- **Full scan:** read `historyId` from `users.getProfile`, page through
  `messages.list`, skip IDs already cached, fetch the rest with
  `messages.get?format=metadata`. A token bucket keeps us under the per-user
  quota (250 units/s; `messages.get` costs 5). 429/5xx responses back off
  exponentially. Because cached IDs are skipped, an interrupted scan resumes.
- **Incremental:** `history.list` from the stored `historyId`; on 404 (expired)
  fall back to a full scan.

## Actions (issues #8, #9)

- **Trash:** `messages.batchModify` (≤1000 IDs per call) adding `TRASH`;
  undo removes it. The local cache is updated immediately.
- **Unsubscribe:** RFC 8058 one-click POST when `List-Unsubscribe-Post` is
  present; otherwise open the https URL in the browser or the `mailto:` in the
  mail client.
