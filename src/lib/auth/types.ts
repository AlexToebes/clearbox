/**
 * Shared types for the auth layer's platform dependencies. Implementations
 * live under `lib/platform/` (the only place allowed to import
 * `@tauri-apps/*`); fakes for tests live in `lib/auth/testing.ts`.
 */

/**
 * Persists secrets (namely the Google OAuth refresh token) outside the app
 * database — see `secret_get`/`secret_set`/`secret_delete` in
 * `src-tauri/src/keychain.rs`, wrapped by `lib/platform/keychain.ts`.
 */
export interface SecretStore {
  /** Resolves to `null` if no value is stored for `key`. */
  get(key: string): Promise<string | null>;
  /** Writes (or overwrites) a value. */
  set(key: string, value: string): Promise<void>;
  /** Deletes a value. Deleting an already-absent key is not an error. */
  delete(key: string): Promise<void>;
}

/**
 * A one-shot local HTTP server that receives the Google OAuth redirect. See
 * `lib/platform/oauth.ts` (backed by `tauri-plugin-oauth`, which binds
 * `127.0.0.1`) for the implementation.
 */
export interface LoopbackListener {
  /** `http://127.0.0.1:<port>` — pass as `redirect_uri` to Google. */
  redirectUri: string;
  /** Resolves with the full URL (including query string) of the first
   * redirect received, e.g. `http://127.0.0.1:<port>/?code=...&state=...`. */
  nextRedirect(): Promise<string>;
  /** Stops the listener. Safe to call more than once. */
  close(): Promise<void>;
}
