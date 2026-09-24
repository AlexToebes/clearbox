/**
 * Wires the real platform implementations (`lib/platform/*`) into the
 * `lib/auth` and `lib/gmail` layers. This is the only UI-side module
 * allowed to do that wiring — everything under `src/features/` and
 * `src/app/` should go through `getServices()` rather than constructing an
 * `AuthSession`/`GmailClient` itself.
 */

import { createAuthSession, type AuthSession } from "@/lib/auth/session";
import { getGoogleConfig } from "@/lib/config";
import { createGmailClient, type GmailClient } from "@/lib/gmail/client";
import { httpFetch } from "@/lib/platform/http";
import { keychainSecretStore } from "@/lib/platform/keychain";
import { startLoopbackListener } from "@/lib/platform/oauth";
import { openExternalUrl } from "@/lib/platform/opener";

export interface Services {
  auth: AuthSession;
  gmail: GmailClient;
}

let services: Services | null = null;

/**
 * Builds (once) and returns the app's `AuthSession`/`GmailClient` pair, or
 * `null` if the Google OAuth client isn't configured (`getGoogleConfig()`).
 */
export function getServices(): Services | null {
  if (services) {
    return services;
  }

  const config = getGoogleConfig();
  if (!config) {
    return null;
  }

  const auth = createAuthSession({
    fetch: httpFetch,
    secrets: keychainSecretStore,
    now: Date.now,
    openUrl: openExternalUrl,
    startLoopbackListener,
    config,
  });

  const gmail = createGmailClient({
    fetch: httpFetch,
    getAccessToken: () => auth.getAccessToken(),
    invalidateAccessToken: () => auth.invalidateAccessToken(),
  });

  services = { auth, gmail };
  return services;
}
