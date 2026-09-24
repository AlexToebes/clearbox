import type { SecretStore } from "./types";

/** An in-memory `SecretStore`, for use in tests. */
export function createTestSecretStore(): SecretStore {
  const secrets = new Map<string, string>();

  return {
    get: (key) => Promise.resolve(secrets.get(key) ?? null),
    set: (key, value) => {
      secrets.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      secrets.delete(key);
      return Promise.resolve();
    },
  };
}
