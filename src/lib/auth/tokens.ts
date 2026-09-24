/**
 * Google OAuth 2.0 token exchange, refresh and revocation — see
 * "Authentication" in `docs/ARCHITECTURE.md`. All requests go through the
 * caller-supplied `fetch` (routed through `lib/platform/http.ts` in the
 * app, a fake in tests) so this module has no Tauri dependency.
 */

import {
  GMAIL_SCOPE,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  OAuthError,
} from "./google";

/**
 * A validated, in-memory representation of a Google token response. Only
 * `accessToken` and `expiresAt` are needed to call the Gmail API;
 * `refreshToken` is present on the initial code exchange (and stored in the
 * OS keychain — see `lib/auth/session.ts`), not on subsequent refreshes
 * (unless Google rotates it). `scope` is likewise present on the initial
 * exchange but often absent from a plain refresh response — see
 * `requestTokenSet`'s scope handling.
 */
export interface TokenSet {
  accessToken: string;
  /** Milliseconds since the epoch (`now() + expires_in * 1000`). */
  expiresAt: number;
  refreshToken?: string;
  scope?: string;
}

/** Raw shape of a Google token-endpoint response, before validation. */
interface RawTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/** Raw shape of a Google error response, e.g. `{"error": "invalid_grant"}`. */
interface RawErrorResponse {
  error?: string;
  error_description?: string;
}

async function toOAuthError(response: Response): Promise<OAuthError> {
  try {
    const body = (await response.json()) as RawErrorResponse;
    if (body.error) {
      return new OAuthError(body.error, body.error_description);
    }
  } catch {
    // Not a JSON body (or no `error` field) — fall through to the generic
    // HTTP-status error below.
  }
  return new OAuthError(`http_${response.status}`);
}

/**
 * POSTs `body` to the token endpoint and validates the response into a
 * `TokenSet`: throws `OAuthError` if `access_token`/`expires_in` are
 * missing (malformed response).
 *
 * Scope handling (`"insufficient_scope"` — the user unticked the Gmail
 * checkbox on Google's granular consent screen): a refresh-token response
 * routinely omits `scope` entirely (Google doesn't re-report it on every
 * refresh), so we only enforce the check when `scope` is present in the
 * response, or when `requireScope` is set — the initial authorization-code
 * exchange, where Google always includes it and we want a missing value to
 * fail loudly rather than silently granting access.
 *
 * Network failures from `fetchImpl` propagate as-is.
 */
async function requestTokenSet(
  fetchImpl: typeof globalThis.fetch,
  now: () => number,
  body: URLSearchParams,
  { requireScope }: { requireScope: boolean },
): Promise<TokenSet> {
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw await toOAuthError(response);
  }

  const raw = (await response.json()) as RawTokenResponse;
  if (
    typeof raw.access_token !== "string" ||
    typeof raw.expires_in !== "number"
  ) {
    throw new OAuthError(
      "invalid_token_response",
      "Token response was missing access_token or expires_in.",
    );
  }

  if (raw.scope !== undefined || requireScope) {
    const grantedScopes = (raw.scope ?? "").split(" ");
    if (!grantedScopes.includes(GMAIL_SCOPE)) {
      throw new OAuthError(
        "insufficient_scope",
        "Granted scope did not include Gmail access — the Gmail checkbox " +
          "on Google's consent screen may have been unticked.",
      );
    }
  }

  return {
    accessToken: raw.access_token,
    expiresAt: now() + raw.expires_in * 1000,
    refreshToken: raw.refresh_token,
    scope: raw.scope,
  };
}

export interface ExchangeCodeOptions {
  fetch: typeof globalThis.fetch;
  /** Clock, so `expiresAt` is deterministic in tests. */
  now: () => number;
  clientId: string;
  clientSecret: string;
  /** Authorization code from the loopback redirect (`parseRedirect`). */
  code: string;
  /** PKCE verifier matching the challenge sent to `buildAuthUrl`. */
  codeVerifier: string;
  redirectUri: string;
}

/**
 * Exchanges an authorization code for a `TokenSet`
 * (`grant_type=authorization_code`), completing the PKCE flow. Requires the
 * response to report a `scope` that includes `GMAIL_SCOPE`.
 */
export function exchangeCode(opts: ExchangeCodeOptions): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    code_verifier: opts.codeVerifier,
    redirect_uri: opts.redirectUri,
  });
  return requestTokenSet(opts.fetch, opts.now, body, { requireScope: true });
}

export interface RefreshAccessTokenOptions {
  fetch: typeof globalThis.fetch;
  now: () => number;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * Exchanges a refresh token for a new access token
 * (`grant_type=refresh_token`). The response's `refresh_token` is normally
 * absent (Google doesn't rotate it); callers should keep using the refresh
 * token they already have unless a new one is returned. A missing `scope`
 * in the response is accepted (see `requestTokenSet`); a present one is
 * still checked against `GMAIL_SCOPE`.
 */
export function refreshAccessToken(
  opts: RefreshAccessTokenOptions,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
  });
  return requestTokenSet(opts.fetch, opts.now, body, { requireScope: false });
}

export interface RevokeTokenOptions {
  fetch: typeof globalThis.fetch;
  /** An access or refresh token to revoke. */
  token: string;
}

/**
 * Revokes a token (used on sign-out). An HTTP 400 with `error:
 * "invalid_token"` — Google's response when the token is already revoked
 * or expired — is treated as success, since the end state (no valid token)
 * is what the caller wants either way.
 */
export async function revokeToken(opts: RevokeTokenOptions): Promise<void> {
  const response = await opts.fetch(GOOGLE_REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: opts.token }).toString(),
  });

  if (response.ok) {
    return;
  }

  const error = await toOAuthError(response);
  if (response.status === 400 && error.code === "invalid_token") {
    return;
  }
  throw error;
}
