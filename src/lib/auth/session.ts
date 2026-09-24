/**
 * The app's Google auth session: PKCE sign-in over the loopback redirect,
 * a keychain-backed refresh token, and an in-memory access token refreshed
 * on demand. See "Authentication" in `docs/ARCHITECTURE.md`.
 *
 * All platform dependencies (HTTP, secret storage, the system clock, the
 * browser opener, the loopback listener) are injected so this can be unit
 * tested without Tauri — see `lib/auth/testing.ts` and `lib/platform/*` for
 * the real/fake implementations.
 */

import {
  computeCodeChallenge,
  generateCodeVerifier,
  generateState,
} from "./pkce";
import { buildAuthUrl, OAuthError, parseRedirect } from "./google";
import { exchangeCode, refreshAccessToken, revokeToken } from "./tokens";
import type { LoopbackListener, SecretStore } from "./types";

/** Secret-store key the refresh token is persisted under. */
const REFRESH_TOKEN_KEY = "google_refresh_token";

/** Refresh proactively once the cached access token is this close to expiry. */
const EXPIRY_BUFFER_MS = 60_000;

/** How long `signIn()` waits for the OAuth redirect before giving up. */
const DEFAULT_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

export type AuthStatus = "signed_out" | "signed_in";

export interface AuthSessionDeps {
  fetch: typeof globalThis.fetch;
  secrets: SecretStore;
  now: () => number;
  /** Opens a URL in the system browser (`lib/platform/opener.ts`). */
  openUrl: (url: string) => Promise<void>;
  /** Starts the loopback redirect server (`lib/platform/oauth.ts`). */
  startLoopbackListener: () => Promise<LoopbackListener>;
  config: { clientId: string; clientSecret: string };
  /** Defaults to 5 minutes. */
  signInTimeoutMs?: number;
}

export interface AuthSession {
  status(): AuthStatus;
  /** Registers `listener` to be called whenever `status()` changes.
   * Returns an unsubscribe function. Meant for React's
   * `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
  /** Reads the refresh token from secret storage, without hitting the
   * network. Resolves to whether a session was restored. */
  restore(): Promise<boolean>;
  /** Runs the full PKCE loopback sign-in flow. Throws `OAuthError` on
   * cancellation (`access_denied`), a `state` mismatch, a timeout waiting
   * for the redirect, or a missing refresh token in Google's response. */
  signIn(): Promise<void>;
  /** Returns a valid access token, refreshing it first if it's missing or
   * close to expiry. Throws `OAuthError("not_signed_in")` when signed out. */
  getAccessToken(): Promise<string>;
  /** Drops the cached access token, forcing the next `getAccessToken()` to
   * refresh. Call this after a Gmail API 401. */
  invalidateAccessToken(): void;
  /** Best-effort revoke, then clears the stored refresh token and goes
   * signed out. Never throws, even if the revoke request fails (e.g.
   * offline). */
  signOut(): Promise<void>;
}

interface CachedAccessToken {
  token: string;
  expiresAt: number;
}

/**
 * Waits for the loopback listener's next *relevant* redirect: one carrying
 * a `code` or `error` query param. Anything else (e.g. the browser
 * requesting `/favicon.ico` against the loopback server) is ignored and we
 * keep waiting. Rejects with `OAuthError("timeout")` if nothing relevant
 * arrives within `timeoutMs`.
 */
async function waitForRedirect(
  listener: LoopbackListener,
  timeoutMs: number,
): Promise<string> {
  const findRelevantRedirect = async (): Promise<string> => {
    for (;;) {
      const raw = await listener.nextRedirect();
      const params = new URL(raw).searchParams;
      if (params.has("code") || params.has("error")) {
        return raw;
      }
    }
  };

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OAuthError("timeout")), timeoutMs);
  });

  try {
    return await Promise.race([findRelevantRedirect(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Creates an `AuthSession` backed by `deps`. */
export function createAuthSession(deps: AuthSessionDeps): AuthSession {
  let status: AuthStatus = "signed_out";
  let accessToken: CachedAccessToken | null = null;
  let refreshInFlight: Promise<string> | null = null;
  let signInInFlight = false;
  const listeners = new Set<() => void>();

  function setStatus(next: AuthStatus): void {
    if (status === next) {
      return;
    }
    status = next;
    for (const listener of listeners) {
      listener();
    }
  }

  async function restore(): Promise<boolean> {
    const refreshToken = await deps.secrets.get(REFRESH_TOKEN_KEY);
    if (refreshToken) {
      setStatus("signed_in");
      return true;
    }
    setStatus("signed_out");
    return false;
  }

  async function doSignIn(): Promise<void> {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await computeCodeChallenge(codeVerifier);
    const state = generateState();

    const listener = await deps.startLoopbackListener();
    try {
      await deps.openUrl(
        buildAuthUrl({
          clientId: deps.config.clientId,
          redirectUri: listener.redirectUri,
          codeChallenge,
          state,
        }),
      );

      const redirectUrl = await waitForRedirect(
        listener,
        deps.signInTimeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS,
      );
      const { code } = parseRedirect(redirectUrl, state);

      const tokens = await exchangeCode({
        fetch: deps.fetch,
        now: deps.now,
        clientId: deps.config.clientId,
        clientSecret: deps.config.clientSecret,
        code,
        codeVerifier,
        redirectUri: listener.redirectUri,
      });

      if (!tokens.refreshToken) {
        throw new OAuthError(
          "no_refresh_token",
          "Google did not return a refresh token.",
        );
      }

      await deps.secrets.set(REFRESH_TOKEN_KEY, tokens.refreshToken);
      accessToken = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
      setStatus("signed_in");
    } finally {
      await listener.close();
    }
  }

  async function signIn(): Promise<void> {
    if (signInInFlight) {
      throw new OAuthError(
        "sign_in_in_progress",
        "A sign-in is already in progress.",
      );
    }
    signInInFlight = true;
    try {
      await doSignIn();
    } finally {
      signInInFlight = false;
    }
  }

  async function doRefresh(): Promise<string> {
    const refreshToken = await deps.secrets.get(REFRESH_TOKEN_KEY);
    if (!refreshToken) {
      setStatus("signed_out");
      throw new OAuthError("not_signed_in");
    }

    try {
      const tokens = await refreshAccessToken({
        fetch: deps.fetch,
        now: deps.now,
        clientId: deps.config.clientId,
        clientSecret: deps.config.clientSecret,
        refreshToken,
      });
      accessToken = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
      return tokens.accessToken;
    } catch (err) {
      if (err instanceof OAuthError && err.code === "invalid_grant") {
        await deps.secrets.delete(REFRESH_TOKEN_KEY);
        accessToken = null;
        setStatus("signed_out");
      }
      throw err;
    }
  }

  function getAccessToken(): Promise<string> {
    if (status !== "signed_in") {
      return Promise.reject(new OAuthError("not_signed_in"));
    }

    if (accessToken && accessToken.expiresAt - deps.now() > EXPIRY_BUFFER_MS) {
      return Promise.resolve(accessToken.token);
    }

    if (!refreshInFlight) {
      refreshInFlight = doRefresh().finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  function invalidateAccessToken(): void {
    accessToken = null;
  }

  async function signOut(): Promise<void> {
    const refreshToken = await deps.secrets.get(REFRESH_TOKEN_KEY);
    if (refreshToken) {
      try {
        await revokeToken({ fetch: deps.fetch, token: refreshToken });
      } catch {
        // Best-effort: sign-out must clear local state even when offline
        // or the token is already invalid.
      }
    }
    await deps.secrets.delete(REFRESH_TOKEN_KEY);
    accessToken = null;
    setStatus("signed_out");
  }

  return {
    status: () => status,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    restore,
    signIn,
    getAccessToken,
    invalidateAccessToken,
    signOut,
  };
}
