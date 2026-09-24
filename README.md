# Clearbox

Clearbox is a local-first desktop app for cleaning up a Gmail mailbox: see
who's filling your inbox, unsubscribe from noisy senders, and bulk-trash
what you don't need. Message metadata is synced into a local SQLite
database and every insight is a SQL query against that cache — nothing is
sent to a Clearbox server, because there is none. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how it's built.

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install) (for the Tauri shell)
- Tauri's platform dependencies — see
  [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)
- **Linux only:** a Secret Service provider for the OS keychain (e.g.
  [GNOME Keyring](https://wiki.gnome.org/Projects/GnomeKeyring)) — this is
  where the Google refresh token is stored

## Google Cloud setup

Clearbox needs its own Google OAuth client to sign in to Gmail:

1. Create a project in the
   [Google Cloud Console](https://console.cloud.google.com/).
2. **APIs & Services → Library**: enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**.
   - Publishing status: **Testing** (no Google review needed while you're
     the only user).
   - **Test users**: add your own Google account.
   - **Scopes**: add `https://www.googleapis.com/auth/gmail.modify` (read
     and modify, but not permanently delete or send — see "Authentication"
     in `docs/ARCHITECTURE.md` for why).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Desktop app**.
   - Copy the generated **Client ID** and **Client secret**.
5. Copy `.env.example` to `.env.local` and fill them in:

   ```
   VITE_GOOGLE_CLIENT_ID=...
   VITE_GOOGLE_CLIENT_SECRET=...
   ```

### Notes

- **Testing-mode refresh tokens expire after 7 days.** Google auto-revokes
  them for apps left in Testing publishing status, so you'll need to
  reconnect Gmail in Clearbox about once a week until the app is verified
  (or you move the consent screen to Production).
- **The Desktop client secret isn't confidential.** Google's installed-app
  OAuth flow doesn't treat it as one (there's no way for a desktop app to
  keep a secret) — see
  [Google's OAuth 2.0 for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)
  docs. `.env.local` is still gitignored, but don't treat this value like a
  server-side API key.

## Development

```sh
pnpm install
pnpm tauri dev
```

Other scripts:

| Command             | Does                              |
| ------------------- | --------------------------------- |
| `pnpm test`         | Run the Vitest suite once         |
| `pnpm test:watch`   | Run Vitest in watch mode          |
| `pnpm lint`         | ESLint                            |
| `pnpm typecheck`    | `tsc --noEmit`                    |
| `pnpm format`       | Prettier, writing changes         |
| `pnpm format:check` | Prettier, check only              |
| `pnpm build`        | Typecheck + production Vite build |

`src-tauri/src/keychain.rs` has a round-trip test that talks to the real OS
keychain; it's `#[ignore]`d by default, so run it explicitly with
`cd src-tauri && cargo test -- --ignored`.

## Roadmap

Clearbox is built issue by issue — see the
[GitHub issues](https://github.com/alextoebes/clearbox/issues) for what's
done and what's next (auth, local DB, full/incremental sync, the sender
dashboard, trash/unsubscribe actions).
