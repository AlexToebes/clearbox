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
