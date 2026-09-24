import { invoke } from "@tauri-apps/api/core";
import type { SecretStore } from "@/lib/auth/types";

/**
 * `SecretStore` backed by the OS keychain, via the `secret_get`/`secret_set`/
 * `secret_delete` Tauri commands in `src-tauri/src/keychain.rs`. This is the
 * only place (besides `lib/platform/sql.ts`) allowed to import
 * `@tauri-apps/*` so the rest of the app can be unit-tested without a Tauri
 * runtime.
 */
export const keychainSecretStore: SecretStore = {
  get: (key) => invoke<string | null>("secret_get", { key }),
  set: (key, value) => invoke<void>("secret_set", { key, value }),
  delete: (key) => invoke<void>("secret_delete", { key }),
};
