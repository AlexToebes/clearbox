import { describe, expect, it, vi } from "vitest";
import { createGmailClient, GmailApiError } from "./client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
 * call's URL and headers. */
function createQueueFetch(responses: Response[]): {
  fetch: typeof globalThis.fetch;
  calls: { url: string; authorization: string | null }[];
} {
  const calls: { url: string; authorization: string | null }[] = [];
  let index = 0;
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("Authorization"),
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
