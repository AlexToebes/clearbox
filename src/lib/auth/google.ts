/**
 * Google OAuth 2.0 endpoints, scope and URL helpers for the installed-app
 * loopback flow (see "Authentication" in `docs/ARCHITECTURE.md`).
 */

/** Authorization endpoint: where the user grants (or denies) access. */
export const GOOGLE_AUTH_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";

/** Token endpoint: exchanges an auth code for tokens, or refreshes one. */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Revoke endpoint: invalidates a token (used on sign-out). */
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/**
 * Read/modify (but not permanently delete or send) access to Gmail. See
 * "Authentication" in `docs/ARCHITECTURE.md` for why this scope was chosen
 * over `https://mail.google.com/`.
 */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

export interface BuildAuthUrlOptions {
  clientId: string;
  /** The loopback redirect URI, e.g. `http://127.0.0.1:<port>`. */
  redirectUri: string;
  /** PKCE S256 challenge, from `computeCodeChallenge` in `lib/auth/pkce.ts`. */
  codeChallenge: string;
  /** CSRF guard, from `generateState` in `lib/auth/pkce.ts`. */
  state: string;
  /** Defaults to `GMAIL_SCOPE`. */
  scope?: string;
}

/**
 * Builds the Google authorization URL to open in the system browser:
 * authorization-code flow with PKCE, always requesting a refresh token
 * (`access_type=offline`) and a fresh consent screen (`prompt=consent`, so a
 * refresh token is issued even on a repeat sign-in).
 */
export function buildAuthUrl(opts: BuildAuthUrlOptions): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", opts.scope ?? GMAIL_SCOPE);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

/**
 * An OAuth error: either one Google reported (`error`/`error_description`
 * query params on the redirect) or one detected locally while validating the
 * redirect (a `state` mismatch, or a missing `code`).
 */
export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly description?: string,
  ) {
    super(description ? `${code}: ${description}` : code);
    this.name = "OAuthError";
  }
}

/**
 * Parses the loopback redirect URL, validating `state` and extracting the
 * authorization `code`.
 *
 * Throws `OAuthError` when Google reported an error (e.g. `access_denied`
 * when the user cancels consent), when `state` doesn't match what we sent
 * (`state_mismatch`), or when no `code` is present (`missing_code`).
 */
export function parseRedirect(
  url: string,
  expectedState: string,
): { code: string } {
  const params = new URL(url).searchParams;

  const error = params.get("error");
  if (error) {
    throw new OAuthError(error, params.get("error_description") ?? undefined);
  }

  const state = params.get("state");
  if (state !== expectedState) {
    throw new OAuthError(
      "state_mismatch",
      "Redirect state did not match the request's state.",
    );
  }

  const code = params.get("code");
  if (!code) {
    throw new OAuthError("missing_code", "Redirect had no authorization code.");
  }

  return { code };
}
