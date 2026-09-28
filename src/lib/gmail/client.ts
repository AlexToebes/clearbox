/**
 * Authorized Gmail REST client: adds the bearer token to every request,
 * retries once (after refreshing) on a 401, and retries with exponential
 * backoff (full jitter) on 429s, 5xxs and rate-limited 403s. Every attempt
 * (including retries) first acquires quota from a token-bucket rate
 * limiter, so a full mailbox scan stays under Gmail's per-user quota. See
 * "Sync" in `docs/ARCHITECTURE.md`.
 *
 * `messages.batchModify` lands with issue #8/#9.
 */

import {
  DEFAULT_GMAIL_UNITS_PER_SECOND,
  GMAIL_QUOTA_UNITS,
  createRateLimiter,
  sleepAbortable,
  type RateLimiter,
} from "./rateLimiter";
import type {
  GmailMessage,
  GmailMessageListResponse,
  GmailProfile,
} from "./types";

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
  /** Clock used to turn an HTTP-date `Retry-After` header into a delay.
   * Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to a token bucket at `DEFAULT_GMAIL_UNITS_PER_SECOND`, using
   * the real clock and `setTimeout`. Tests inject a fake (or a recording
   * one) to assert exactly what quota each call acquires. */
  rateLimiter?: RateLimiter;
}

export interface ListMessageIdsOptions {
  /** Continues a previous `listMessageIds` call. */
  pageToken?: string;
  /** Results per page. Defaults to 500, Gmail's own per-page maximum. */
  maxResults?: number;
  signal?: AbortSignal;
}

export interface ListMessageIdsResult {
  ids: string[];
  /** `null` once the last page has been reached. */
  nextPageToken: string | null;
  resultSizeEstimate: number;
}

export interface GmailClient {
  /** `GET /profile`: the signed-in account's address and message/thread
   * counts. */
  getProfile(signal?: AbortSignal): Promise<GmailProfile>;
  /** `GET /messages`: one page of message ids in the mailbox (excluding
   * Spam/Trash). Used to enumerate the mailbox for a full scan. */
  listMessageIds(opts?: ListMessageIdsOptions): Promise<ListMessageIdsResult>;
  /** `GET /messages/{id}?format=metadata`: the headers, labels, size and
   * date Clearbox caches for one message (see "Metadata only" in
   * `docs/ARCHITECTURE.md`). Returns `null` on a 404 — the message was
   * deleted after it was listed. */
  getMessageMetadata(
    id: string,
    signal?: AbortSignal,
  ): Promise<GmailMessage | null>;
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

/**
 * Parses a `Retry-After` header (RFC 9110 §10.2.3) into a delay in
 * milliseconds: either `delta-seconds` (an unsigned integer, e.g. `"120"`)
 * or an HTTP-date (e.g. `"Wed, 21 Oct 2015 07:28:00 GMT"`), in which case
 * the delay is `date - now()`. Returns `null` — meaning "fall back to the
 * computed backoff" — when the header is absent, isn't valid in either
 * form, or names a date that's already in the past (a negative delay).
 *
 * `Number("Wed, 21 Oct …")` is `NaN`, and `setTimeout(fn, NaN)` fires on
 * the next tick — silently turning a rate-limit response into a hot retry
 * loop — so the delta-seconds form is matched explicitly rather than
 * handed straight to `Number()`.
 */
function parseRetryAfterMs(
  header: string | null,
  now: () => number,
): number | null {
  if (header === null) {
    return null;
  }

  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return null;
  }
  const delayMs = dateMs - now();
  return delayMs >= 0 ? delayMs : null;
}

/** Creates a `GmailClient` backed by `deps`. */
export function createGmailClient(deps: GmailClientDeps): GmailClient {
  const sleep = deps.sleep ?? defaultSleep;
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const rateLimiter =
    deps.rateLimiter ??
    createRateLimiter({
      unitsPerSecond: DEFAULT_GMAIL_UNITS_PER_SECOND,
      now: Date.now,
      sleep: defaultSleep,
    });

  /** Exponential backoff with full jitter: a uniform random delay between
   * 0 and `min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2^retriesSoFar)`. */
  function backoffDelayMs(retriesSoFar: number): number {
    const cap = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** retriesSoFar);
    return random() * cap;
  }

  /**
   * Makes one logical API call, transparently handling the 401-refresh and
   * retryable-error-backoff loops. `units` is the call's Gmail quota cost
   * (`GMAIL_QUOTA_UNITS`); quota is acquired before every attempt,
   * including retries, so a slow patch of backoff doesn't let a burst of
   * *other* calls blow through the budget while this one waits.
   */
  async function request<T>(
    path: string,
    units: number,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    let token = await deps.getAccessToken();
    let usedUnauthorizedRetry = false;
    let retries = 0;

    for (;;) {
      await rateLimiter.acquire(units, signal);

      const response = await deps.fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
        signal,
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
        const retryAfterMs = parseRetryAfterMs(
          response.headers.get("Retry-After"),
          now,
        );
        const delayMs =
          retryAfterMs !== null
            ? Math.min(retryAfterMs, MAX_BACKOFF_MS)
            : backoffDelayMs(retries);
        retries += 1;
        await sleepAbortable(sleep, delayMs, signal);
        continue;
      }

      throw new GmailApiError(response.status, reason, message);
    }
  }

  async function getMessageMetadata(
    id: string,
    signal?: AbortSignal,
  ): Promise<GmailMessage | null> {
    const params = new URLSearchParams({ format: "metadata" });
    for (const header of [
      "From",
      "Subject",
      "List-Unsubscribe",
      "List-Unsubscribe-Post",
    ]) {
      params.append("metadataHeaders", header);
    }

    try {
      return await request<GmailMessage>(
        `/messages/${encodeURIComponent(id)}?${params.toString()}`,
        GMAIL_QUOTA_UNITS.messagesGet,
        {},
        signal,
      );
    } catch (err) {
      if (err instanceof GmailApiError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  return {
    getProfile: (signal?: AbortSignal) =>
      request<GmailProfile>(
        "/profile",
        GMAIL_QUOTA_UNITS.getProfile,
        {},
        signal,
      ),

    listMessageIds: async (opts: ListMessageIdsOptions = {}) => {
      const params = new URLSearchParams();
      params.set("maxResults", String(opts.maxResults ?? 500));
      if (opts.pageToken !== undefined) {
        params.set("pageToken", opts.pageToken);
      }
      params.set("includeSpamTrash", "false");

      const response = await request<GmailMessageListResponse>(
        `/messages?${params.toString()}`,
        GMAIL_QUOTA_UNITS.messagesList,
        {},
        opts.signal,
      );

      return {
        ids: (response.messages ?? []).map((m) => m.id),
        nextPageToken: response.nextPageToken ?? null,
        resultSizeEstimate: response.resultSizeEstimate,
      };
    },

    getMessageMetadata,
  };
}
