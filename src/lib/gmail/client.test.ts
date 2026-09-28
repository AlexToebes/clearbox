import { describe, expect, it, vi } from "vitest";
import { createGmailClient, GmailApiError } from "./client";
import { GMAIL_QUOTA_UNITS, type RateLimiter } from "./rateLimiter";
import type { GmailMessage } from "./types";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A `RateLimiter` fake that grants every request instantly while
 * recording the units and signal it was called with, so tests can assert
 * exactly what quota `createGmailClient` acquires and when. */
function createRecordingRateLimiter(): {
  rateLimiter: RateLimiter;
  calls: { units: number; signal: AbortSignal | undefined }[];
} {
  const calls: { units: number; signal: AbortSignal | undefined }[] = [];
  return {
    rateLimiter: {
      acquire: (units: number, signal?: AbortSignal) => {
        calls.push({ units, signal });
        return Promise.resolve();
      },
    },
    calls,
  };
}

function errorResponse(
  status: number,
  reason?: string,
  message = "boom",
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      error: { message, errors: reason ? [{ reason }] : [] },
    }),
    {
      status,
      headers: { "Content-Type": "application/json", ...extraHeaders },
    },
  );
}

const PROFILE_BODY = {
  emailAddress: "alex@example.com",
  messagesTotal: 100,
  threadsTotal: 20,
  historyId: "h1",
};

/** A fetch stub that returns queued responses in order, recording every
 * call's URL, headers and abort signal. */
function createQueueFetch(responses: Response[]): {
  fetch: typeof globalThis.fetch;
  calls: {
    url: string;
    authorization: string | null;
    signal: AbortSignal | null | undefined;
  }[];
} {
  const calls: {
    url: string;
    authorization: string | null;
    signal: AbortSignal | null | undefined;
  }[] = [];
  let index = 0;
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("Authorization"),
      signal: init?.signal,
    });
    const response = responses[index];
    index += 1;
    if (!response) {
      throw new Error("createQueueFetch: ran out of queued responses");
    }
    return Promise.resolve(response);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function recordingSleep(): {
  sleep: (ms: number) => Promise<void>;
  delays: number[];
} {
  const delays: number[] = [];
  return {
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
    delays,
  };
}

describe("getProfile", () => {
  it("sends a bearer token and returns the parsed profile", async () => {
    const { fetch, calls } = createQueueFetch([
      jsonResponse(200, PROFILE_BODY),
    ]);
    const getAccessToken = vi.fn().mockResolvedValue("token-1");

    const client = createGmailClient({
      fetch,
      getAccessToken,
      invalidateAccessToken: vi.fn(),
    });

    await expect(client.getProfile()).resolves.toEqual(PROFILE_BODY);
    expect(calls).toEqual([
      {
        url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        authorization: "Bearer token-1",
      },
    ]);
  });

  it("on a 401, invalidates the token, refreshes once, and retries", async () => {
    const { fetch, calls } = createQueueFetch([
      errorResponse(401, undefined, "Invalid Credentials"),
      jsonResponse(200, PROFILE_BODY),
    ]);
    const getAccessToken = vi
      .fn()
      .mockResolvedValueOnce("stale-token")
      .mockResolvedValueOnce("fresh-token");
    const invalidateAccessToken = vi.fn();

    const client = createGmailClient({
      fetch,
      getAccessToken,
      invalidateAccessToken,
    });

    await expect(client.getProfile()).resolves.toEqual(PROFILE_BODY);
    expect(invalidateAccessToken).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(calls.map((c) => c.authorization)).toEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
    ]);
  });

  it("throws GmailApiError after a second 401 (retried only once)", async () => {
    const { fetch } = createQueueFetch([
      errorResponse(401, undefined, "Invalid Credentials"),
      errorResponse(401, undefined, "Invalid Credentials"),
    ]);
    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
    });

    await expect(client.getProfile()).rejects.toMatchObject({
      status: 401,
      message: "Invalid Credentials",
    });
  });

  it("retries 429s with exponential-full-jitter backoff, then succeeds", async () => {
    const { fetch } = createQueueFetch([
      errorResponse(429, "rateLimitExceeded"),
      errorResponse(429, "rateLimitExceeded"),
      errorResponse(429, "rateLimitExceeded"),
      jsonResponse(200, PROFILE_BODY),
    ]);
    const { sleep, delays } = recordingSleep();

    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
      sleep,
      random: () => 1, // full jitter cap, deterministic
      maxRetries: 5,
    });

    await expect(client.getProfile()).resolves.toEqual(PROFILE_BODY);
    // cap = min(32000, 1000 * 2^retries) at retries = 0, 1, 2
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it("honors a Retry-After header (seconds) over the computed backoff", async () => {
    const { fetch } = createQueueFetch([
      errorResponse(503, undefined, "Service Unavailable", {
        "Retry-After": "5",
      }),
      jsonResponse(200, PROFILE_BODY),
    ]);
    const { sleep, delays } = recordingSleep();

    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
      sleep,
      random: () => 1,
    });

    await expect(client.getProfile()).resolves.toEqual(PROFILE_BODY);
    expect(delays).toEqual([5000]);
  });

  it("honors a Retry-After header (HTTP-date), computed against the injected clock", async () => {
    const nowMs = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    const { fetch } = createQueueFetch([
      errorResponse(503, undefined, "Service Unavailable", {
        "Retry-After": "Wed, 21 Oct 2015 07:28:10 GMT",
      }),
      jsonResponse(200, PROFILE_BODY),
    ]);
    const { sleep, delays } = recordingSleep();

    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
      sleep,
      random: () => 1,
      now: () => nowMs,
    });

    await expect(client.getProfile()).resolves.toEqual(PROFILE_BODY);
    expect(delays).toEqual([10_000]);
  });

  it("falls back to jittered backoff for an unparseable Retry-After (never NaN/hot-loops)", async () => {
    const { fetch } = createQueueFetch([
      errorResponse(503, undefined, "Service Unavailable", {
        "Retry-After": "not-a-valid-header-value",
      }),
      jsonResponse(200, PROFILE_BODY),
    ]);
    const { sleep, delays } = recordingSleep();

    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
      sleep,
      random: () => 1,
    });

    await expect(client.getProfile()).resolves.toEqual(PROFILE_BODY);
    // Falls back to backoffDelayMs(0) = min(32000, 1000) * 1, not NaN/0.
    expect(delays).toEqual([1000]);
  });

  it("clamps an overly long Retry-After to MAX_BACKOFF_MS", async () => {
    const { fetch } = createQueueFetch([
      errorResponse(503, undefined, "Service Unavailable", {
        "Retry-After": "99999",
      }),
      jsonResponse(200, PROFILE_BODY),
    ]);
    const { sleep, delays } = recordingSleep();

    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
      sleep,
      random: () => 1,
    });

    await expect(client.getProfile()).resolves.toEqual(PROFILE_BODY);
    expect(delays).toEqual([32_000]);
  });

  it("retries a 403 reason: rateLimitExceeded", async () => {
    const { fetch } = createQueueFetch([
      errorResponse(403, "userRateLimitExceeded"),
      jsonResponse(200, PROFILE_BODY),
    ]);
    const { sleep, delays } = recordingSleep();

    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
      sleep,
      random: () => 0.5,
    });

    await expect(client.getProfile()).resolves.toEqual(PROFILE_BODY);
    expect(delays).toEqual([500]);
  });

  it("does not retry a 403 for a non-rate-limit reason", async () => {
    const { fetch, calls } = createQueueFetch([
      errorResponse(403, "insufficientPermissions", "Insufficient Permission"),
    ]);
    const sleep = vi.fn();

    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
      sleep,
    });

    await expect(client.getProfile()).rejects.toMatchObject({
      status: 403,
      reason: "insufficientPermissions",
      message: "Insufficient Permission",
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("gives up after maxRetries and throws GmailApiError", async () => {
    const { fetch, calls } = createQueueFetch([
      errorResponse(500, undefined, "Internal Error"),
      errorResponse(500, undefined, "Internal Error"),
      errorResponse(500, undefined, "Internal Error"),
    ]);
    const { sleep, delays } = recordingSleep();

    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
      sleep,
      random: () => 1,
      maxRetries: 2,
    });

    await expect(client.getProfile()).rejects.toBeInstanceOf(GmailApiError);
    // Initial attempt + 2 retries = 3 calls total.
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([1000, 2000]);
  });
});

describe("listMessageIds", () => {
  it("requests maxResults=500 and includeSpamTrash=false by default, no pageToken", async () => {
    const { fetch, calls } = createQueueFetch([
      jsonResponse(200, {
        messages: [{ id: "m1", threadId: "t1" }],
        resultSizeEstimate: 1,
      }),
    ]);
    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
    });

    await client.listMessageIds();

    expect(calls[0]!.url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=500&includeSpamTrash=false",
    );
  });

  it("includes pageToken, in maxResults/pageToken/includeSpamTrash order, and honors a custom maxResults", async () => {
    const { fetch, calls } = createQueueFetch([
      jsonResponse(200, { messages: [], resultSizeEstimate: 0 }),
    ]);
    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
    });

    await client.listMessageIds({ pageToken: "page-2", maxResults: 100 });

    expect(calls[0]!.url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&pageToken=page-2&includeSpamTrash=false",
    );
  });

  it("maps ids, nextPageToken and resultSizeEstimate from a non-empty page", async () => {
    const { fetch } = createQueueFetch([
      jsonResponse(200, {
        messages: [
          { id: "m1", threadId: "t1" },
          { id: "m2", threadId: "t2" },
        ],
        nextPageToken: "next",
        resultSizeEstimate: 12345,
      }),
    ]);
    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
    });

    await expect(client.listMessageIds()).resolves.toEqual({
      ids: ["m1", "m2"],
      nextPageToken: "next",
      resultSizeEstimate: 12345,
    });
  });

  it("treats an empty page (no `messages` field) as ids: [], nextPageToken: null", async () => {
    const { fetch } = createQueueFetch([
      jsonResponse(200, { resultSizeEstimate: 0 }),
    ]);
    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
    });

    await expect(client.listMessageIds()).resolves.toEqual({
      ids: [],
      nextPageToken: null,
      resultSizeEstimate: 0,
    });
  });

  it("acquires messagesList quota units", async () => {
    const { fetch } = createQueueFetch([
      jsonResponse(200, { resultSizeEstimate: 0 }),
    ]);
    const { rateLimiter, calls } = createRecordingRateLimiter();
    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
      rateLimiter,
    });

    await client.listMessageIds();

    expect(calls).toEqual([
      { units: GMAIL_QUOTA_UNITS.messagesList, signal: undefined },
    ]);
  });
});

describe("getMessageMetadata", () => {
  const MESSAGE_BODY: GmailMessage = {
    id: "m1",
    threadId: "t1",
    internalDate: "1700000000000",
    sizeEstimate: 123,
    labelIds: ["INBOX"],
    payload: {
      headers: [{ name: "Subject", value: "Hi" }],
    },
  };

  it("requests format=metadata with exactly the four cached headers, in order", async () => {
    const { fetch, calls } = createQueueFetch([
      jsonResponse(200, MESSAGE_BODY),
    ]);
    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
    });

    await client.getMessageMetadata("m1");

    expect(calls[0]!.url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/m1" +
        "?format=metadata&metadataHeaders=From&metadataHeaders=Subject" +
        "&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post",
    );
  });

  it("URL-encodes the message id", async () => {
    const { fetch, calls } = createQueueFetch([
      jsonResponse(200, { ...MESSAGE_BODY, id: "weird/id with space" }),
    ]);
    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
    });

    await client.getMessageMetadata("weird/id with space");

    expect(calls[0]!.url).toContain(
      `/messages/${encodeURIComponent("weird/id with space")}?`,
    );
  });

  it("returns the parsed message on success", async () => {
    const { fetch } = createQueueFetch([jsonResponse(200, MESSAGE_BODY)]);
    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
    });

    await expect(client.getMessageMetadata("m1")).resolves.toEqual(
      MESSAGE_BODY,
    );
  });

  it("returns null on a 404 (message deleted since it was listed)", async () => {
    const { fetch } = createQueueFetch([
      errorResponse(404, "notFound", "Not Found"),
    ]);
    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
    });

    await expect(client.getMessageMetadata("gone")).resolves.toBeNull();
  });

  it("still throws GmailApiError for a non-404 failure", async () => {
    const { fetch } = createQueueFetch([
      errorResponse(403, "insufficientPermissions", "Insufficient Permission"),
    ]);
    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
    });

    await expect(client.getMessageMetadata("m1")).rejects.toBeInstanceOf(
      GmailApiError,
    );
  });

  it("acquires messagesGet quota units", async () => {
    const { fetch } = createQueueFetch([jsonResponse(200, MESSAGE_BODY)]);
    const { rateLimiter, calls } = createRecordingRateLimiter();
    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
      rateLimiter,
    });

    await client.getMessageMetadata("m1");

    expect(calls).toEqual([
      { units: GMAIL_QUOTA_UNITS.messagesGet, signal: undefined },
    ]);
  });
});

describe("getProfile quota", () => {
  it("acquires getProfile quota units", async () => {
    const { fetch } = createQueueFetch([jsonResponse(200, PROFILE_BODY)]);
    const { rateLimiter, calls } = createRecordingRateLimiter();
    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
      rateLimiter,
    });

    await client.getProfile();

    expect(calls).toEqual([
      { units: GMAIL_QUOTA_UNITS.getProfile, signal: undefined },
    ]);
  });
});

describe("rate limiting across retries", () => {
  it("acquires quota before every attempt, including retries, with the same cost each time", async () => {
    const { fetch } = createQueueFetch([
      errorResponse(500, undefined, "Internal Error"),
      errorResponse(500, undefined, "Internal Error"),
      jsonResponse(200, PROFILE_BODY),
    ]);
    const { sleep } = recordingSleep();
    const { rateLimiter, calls } = createRecordingRateLimiter();

    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
      sleep,
      random: () => 1,
      rateLimiter,
    });

    await expect(client.getProfile()).resolves.toEqual(PROFILE_BODY);
    expect(calls).toEqual([
      { units: GMAIL_QUOTA_UNITS.getProfile, signal: undefined },
      { units: GMAIL_QUOTA_UNITS.getProfile, signal: undefined },
      { units: GMAIL_QUOTA_UNITS.getProfile, signal: undefined },
    ]);
  });

  it("acquires quota again on the retry after a 401", async () => {
    const { fetch } = createQueueFetch([
      errorResponse(401, undefined, "Invalid Credentials"),
      jsonResponse(200, PROFILE_BODY),
    ]);
    const { rateLimiter, calls } = createRecordingRateLimiter();

    const client = createGmailClient({
      fetch,
      getAccessToken: vi
        .fn()
        .mockResolvedValueOnce("stale")
        .mockResolvedValueOnce("fresh"),
      invalidateAccessToken: vi.fn(),
      rateLimiter,
    });

    await expect(client.getProfile()).resolves.toEqual(PROFILE_BODY);
    expect(calls).toHaveLength(2);
  });
});

describe("abort handling", () => {
  it("passes the signal through to fetch", async () => {
    const { fetch, calls } = createQueueFetch([
      jsonResponse(200, PROFILE_BODY),
    ]);
    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
    });
    const controller = new AbortController();

    await client.getProfile(controller.signal);

    expect(calls[0]!.signal).toBe(controller.signal);
  });

  it("acquiring quota is passed the signal", async () => {
    const { fetch } = createQueueFetch([jsonResponse(200, PROFILE_BODY)]);
    const { rateLimiter, calls } = createRecordingRateLimiter();
    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
      rateLimiter,
    });
    const controller = new AbortController();

    await client.getProfile(controller.signal);

    expect(calls[0]!.signal).toBe(controller.signal);
  });

  it("aborting while sleeping for backoff rejects promptly and makes no further attempts", async () => {
    const { fetch, calls } = createQueueFetch([
      errorResponse(500, undefined, "Internal Error"),
      jsonResponse(200, PROFILE_BODY), // never reached
    ]);
    // A sleep that never resolves on its own, so the only way `request()`
    // moves on is via the abort listener `sleepAbortable` registers.
    const hangingSleep = () => new Promise<void>(() => {});
    const controller = new AbortController();

    const client = createGmailClient({
      fetch,
      getAccessToken: vi.fn().mockResolvedValue("token"),
      invalidateAccessToken: vi.fn(),
      sleep: hangingSleep,
      random: () => 1,
    });

    const pending = client.getProfile(controller.signal);

    // Let the first attempt fail and reach the hanging backoff sleep
    // before aborting.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(DOMException);
    // Only the one failed attempt: no retry after the abort.
    expect(calls).toHaveLength(1);
  });
});
