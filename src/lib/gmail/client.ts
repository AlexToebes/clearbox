/**
 * Authorized Gmail REST client: adds the bearer token to every request,
 * retries once (after refreshing) on a 401, and retries with exponential
 * backoff (full jitter) on 429s, 5xxs and rate-limited 403s. See "Sync" in
 * `docs/ARCHITECTURE.md`.
 *
 * Only `getProfile` is implemented here; `messages.list`/`get`/
 * `batchModify` land with issue #4.
 */

import type { GmailProfile } from "./types";

const BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Base backoff delay (1s), doubled per retry. */
const BASE_BACKOFF_MS = 1000;
/** Backoff never waits longer than this per retry (32s). */
const MAX_BACKOFF_MS = 32000;
const DEFAULT_MAX_RETRIES = 5;

/**
 * A Gmail API error that wasn't retried away: any non-2xx response other
 * than a since-retried 401, or a retryable response (429/5xx/rate-limited
 * 403) that kept failing past `maxRetries`.
 */
export class GmailApiError extends Error {
  constructor(
    public readonly status: number,
    /** `error.errors[0].reason` from Google's error body, if present
     * (e.g. `"rateLimitExceeded"`, `"notFound"`). */
    public readonly reason: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

export interface GmailClientDeps {
  fetch: typeof globalThis.fetch;
  /** Returns a valid access token, refreshing it first if needed
   * (`AuthSession.getAccessToken` in `lib/auth/session.ts`). */
  getAccessToken: () => Promise<string>;
  /** Drops the cached access token after a 401, so the retried
   * `getAccessToken()` call refreshes instead of reusing the same token. */
  invalidateAccessToken: () => void;
  /** Defaults to a real `setTimeout`-based sleep; tests inject an instant
   * one. */
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to 5. */
  maxRetries?: number;
  /** Source of randomness for full-jitter backoff. Defaults to
   * `Math.random`; tests inject a fixed value to assert exact delays. */
  random?: () => number;
}

export interface GmailClient {
  /** `GET /profile`: the signed-in account's address and message/thread
   * counts. */
  getProfile(): Promise<GmailProfile>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RawErrorBody {
  error?: {
    message?: string;
    errors?: { reason?: string }[];
  };
}

/** Parses a Gmail API error body (`{"error": {"message", "errors": [...]}}`),
 * falling back to a generic message for a non-JSON or unexpected body. */
async function readErrorBody(
  response: Response,
): Promise<{ message: string; reason: string | undefined }> {
  try {
    const body = (await response.json()) as RawErrorBody;
    return {
      message: body.error?.message ?? `HTTP ${response.status}`,
      reason: body.error?.errors?.[0]?.reason,
    };
  } catch {
    return { message: `HTTP ${response.status}`, reason: undefined };
  }
}

/** 429 (quota), 5xx (server error), and a 403 whose reason marks it as a
 * rate limit rather than a permission problem, are all worth retrying. */
function isRetryable(status: number, reason: string | undefined): boolean {
  return (
    status === 429 ||
    status >= 500 ||
    (status === 403 &&
      (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded"))
  );
}

/** Creates a `GmailClient` backed by `deps`. */
export function createGmailClient(deps: GmailClientDeps): GmailClient {
  const sleep = deps.sleep ?? defaultSleep;
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const random = deps.random ?? Math.random;

  /** Exponential backoff with full jitter: a uniform random delay between
   * 0 and `min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2^retriesSoFar)`. */
  function backoffDelayMs(retriesSoFar: number): number {
    const cap = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** retriesSoFar);
    return random() * cap;
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let token = await deps.getAccessToken();
    let usedUnauthorizedRetry = false;
    let retries = 0;

    for (;;) {
      const response = await deps.fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      if (response.status === 401 && !usedUnauthorizedRetry) {
        usedUnauthorizedRetry = true;
        deps.invalidateAccessToken();
        token = await deps.getAccessToken();
        continue;
      }

      const { message, reason } = await readErrorBody(response);

      if (isRetryable(response.status, reason) && retries < maxRetries) {
        const retryAfter = response.headers.get("Retry-After");
        const delayMs = retryAfter
          ? Number(retryAfter) * 1000
          : backoffDelayMs(retries);
        retries += 1;
        await sleep(delayMs);
        continue;
      }

      throw new GmailApiError(response.status, reason, message);
    }
  }

  return {
    getProfile: () => request<GmailProfile>("/profile"),
  };
}
