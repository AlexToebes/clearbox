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
import {
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  type TokenSet,
} from "./tokens";
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
  /** Runs the full PKCE loopback sign-in flow. Throws `OAuthError` when
   * Google reports the user denied consent (`access_denied`), on a `state`
   * mismatch, on a timeout waiting for the redirect, on a missing refresh
   * token in Google's response (`no_refresh_token`), or — when `signal` is
   * aborted — `"cancelled"`. In every case the loopback listener is closed
   * and no tokens are stored. */
  signIn(options?: { signal?: AbortSignal }): Promise<void>;
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

/** Rejects with `OAuthError("cancelled")` when `signal` fires. Used to race
 * the sign-in flow so cancellation wins immediately, however far the flow
 * has gotten. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new OAuthError("cancelled", "Sign-in was cancelled.")),
      { once: true },
    );
  });
}

/** Creates an `AuthSession` backed by `deps`. */
export function createAuthSession(deps: AuthSessionDeps): AuthSession {
  let status: AuthStatus = "signed_out";
  let accessToken: CachedAccessToken | null = null;
  let refreshInFlight: Promise<string> | null = null;
  let signInInFlight = false;
  const listeners = new Set<() => void>();

  /**
   * Bumped whenever the session moves on from underneath a pending
   * operation (`signOut()`, a new `signIn()`): a `doRefresh()` started
   * under an older generation discards its result instead of resurrecting
   * a signed-out session or clobbering a newer sign-in.
   */
  let generation = 0;

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

  async function doSignIn(signal?: AbortSignal): Promise<void> {
    // A new sign-in attempt supersedes any refresh still in flight from a
    // previous session.
    generation += 1;

    if (signal?.aborted) {
      throw new OAuthError("cancelled", "Sign-in was cancelled.");
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await computeCodeChallenge(codeVerifier);
    const state = generateState();

    const listener = await deps.startLoopbackListener();
    try {
      // The whole open-URL/wait-for-redirect/exchange-code flow runs as one
      // unit here so it can be raced against cancellation: whichever
      // settles first wins, and — critically — the commit below (storing
      // the refresh token, caching the access token, going signed_in) only
      // runs if the flow itself won. If cancellation wins, the flow keeps
      // running in the background (e.g. a redirect that arrives after the
      // user clicked Cancel) but its eventual result is simply never used.
      const flow = (async (): Promise<TokenSet> => {
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

        return exchangeCode({
          fetch: deps.fetch,
          now: deps.now,
          clientId: deps.config.clientId,
          clientSecret: deps.config.clientSecret,
          code,
          codeVerifier,
          redirectUri: listener.redirectUri,
        });
      })();

      const tokens = signal
        ? await Promise.race([flow, rejectOnAbort(signal)])
        : await flow;

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

  async function signIn(options?: { signal?: AbortSignal }): Promise<void> {
    if (signInInFlight) {
      throw new OAuthError(
        "sign_in_in_progress",
        "A sign-in is already in progress.",
      );
    }
    signInInFlight = true;
    try {
      await doSignIn(options?.signal);
    } finally {
      signInInFlight = false;
    }
  }

  async function doRefresh(): Promise<string> {
    // Captured before any await: if `generation` has moved on by the time
    // this settles (a concurrent signOut() or signIn()), the result below
    // is stale and must be discarded.
    const refreshGeneration = generation;

    const refreshToken = await deps.secrets.get(REFRESH_TOKEN_KEY);
    if (!refreshToken) {
      if (refreshGeneration === generation) {
        setStatus("signed_out");
      }
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

      if (refreshGeneration !== generation) {
        // The session moved on while this refresh was in flight (signed
        // out, or a new sign-in started) — don't resurrect it or clobber
        // whatever the session is doing now.
        throw new OAuthError("not_signed_in");
      }

      if (tokens.refreshToken) {
        // Google rotated the refresh token; persist the new one.
        await deps.secrets.set(REFRESH_TOKEN_KEY, tokens.refreshToken);
      }
      accessToken = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
      return tokens.accessToken;
    } catch (err) {
      if (
        refreshGeneration === generation &&
        err instanceof OAuthError &&
        err.code === "invalid_grant"
      ) {
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
    // Invalidate any refresh still in flight before the first await, so it
    // can't re-cache a token or flip status back to signed_in underneath
    // this call.
    generation += 1;

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
