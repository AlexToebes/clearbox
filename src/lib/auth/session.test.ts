import { describe, expect, it, vi } from "vitest";
import { GMAIL_SCOPE } from "./google";
import { createAuthSession, type AuthSessionDeps } from "./session";
import { createTestSecretStore } from "./testing";
import type { LoopbackListener, SecretStore } from "./types";

const NOW = 1_700_000_000_000;
const CLIENT_ID = "client-1";
const CLIENT_SECRET = "secret-1";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A `LoopbackListener` a test can push redirects into, or leave hanging. */
function createFakeListener(): LoopbackListener & {
  emit: (url: string) => void;
  closeCalls: () => number;
} {
  const queue: string[] = [];
  let waiting: ((url: string) => void) | null = null;
  let closeCalls = 0;

  return {
    redirectUri: "http://127.0.0.1:9999",
    nextRedirect: () =>
      new Promise<string>((resolve) => {
        const queued = queue.shift();
        if (queued !== undefined) {
          resolve(queued);
        } else {
          waiting = resolve;
        }
      }),
    close: () => {
      closeCalls += 1;
      return Promise.resolve();
    },
    emit: (url: string) => {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(url);
      } else {
        queue.push(url);
      }
    },
    closeCalls: () => closeCalls,
  };
}

/** Routes token/revoke requests to canned responses, recording call counts. */
function createFakeFetch(
  handlers: Partial<{
    token: () => Response;
    revoke: () => Response;
  }>,
): { fetch: typeof globalThis.fetch; tokenCalls: () => number } {
  let tokenCalls = 0;
  const fetch = vi.fn((input: string): Promise<Response> => {
    const url = input;
    if (url.includes("/token")) {
      tokenCalls += 1;
      return Promise.resolve(
        handlers.token?.() ?? jsonResponse(200, tokenBody()),
      );
    }
    if (url.includes("/revoke")) {
      return Promise.resolve(
        handlers.revoke?.() ?? new Response(null, { status: 200 }),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof globalThis.fetch;

  return { fetch, tokenCalls: () => tokenCalls };
}

/**
 * Waits until `mockFn` has been called at least `times` times. `signIn()`
 * does real async work (PKCE's `crypto.subtle.digest`) before opening the
 * URL, so a fixed number of microtask ticks isn't reliable — poll instead.
 */
async function waitForCalls(
  openUrl: AuthSessionDeps["openUrl"],
  times = 1,
): Promise<void> {
  await vi.waitFor(
    () => {
      if (vi.mocked(openUrl).mock.calls.length < times) {
        throw new Error("not called yet");
      }
    },
    { timeout: 1000, interval: 5 },
  );
}

/**
 * A fetch stub whose `/token` response is controlled by the test, via a
 * returned `resolveToken`. Used to land a refresh's fetch resolution at a
 * precise point relative to another call (e.g. `signOut()`).
 */
function createDeferredTokenFetch(): {
  fetch: typeof globalThis.fetch;
  resolveToken: (body: Record<string, unknown>) => void;
} {
  let resolvePending!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    resolvePending = resolve;
  });

  const fetch = vi.fn((input: string): Promise<Response> => {
    if (input.includes("/token")) {
      return pending;
    }
    if (input.includes("/revoke")) {
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    throw new Error(`unexpected fetch: ${input}`);
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    resolveToken: (body) => resolvePending(jsonResponse(200, body)),
  };
}

function tokenBody(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "access-1",
    expires_in: 3600,
    refresh_token: "refresh-1",
    scope: GMAIL_SCOPE,
    ...overrides,
  };
}

function baseDeps(
  overrides: Partial<AuthSessionDeps> & {
    listener?: ReturnType<typeof createFakeListener>;
    secrets?: SecretStore;
  } = {},
): AuthSessionDeps & { listener: ReturnType<typeof createFakeListener> } {
  const listener = overrides.listener ?? createFakeListener();
  const { fetch } = createFakeFetch({});
  return {
    fetch,
    secrets: overrides.secrets ?? createTestSecretStore(),
    now: () => NOW,
    openUrl: vi.fn().mockResolvedValue(undefined),
    startLoopbackListener: vi.fn().mockResolvedValue(listener),
    config: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    signInTimeoutMs: 50,
    ...overrides,
    listener,
  };
}

describe("signIn", () => {
  it("opens the auth URL, waits for the redirect, exchanges the code, and stores the refresh token", async () => {
    const listener = createFakeListener();
    const { fetch } = createFakeFetch({});
    const secrets = createTestSecretStore();
    const deps = baseDeps({ listener, fetch, secrets });
    const session = createAuthSession(deps);

    const notifications: string[] = [];
    session.subscribe(() => notifications.push(session.status()));

    const signInPromise = session.signIn();
    // Let signIn() reach the point of opening the URL and awaiting the redirect.
    await waitForCalls(deps.openUrl);

    expect(deps.openUrl).toHaveBeenCalledTimes(1);
    const openedUrl = new URL(vi.mocked(deps.openUrl).mock.calls[0]![0]);
    const state = openedUrl.searchParams.get("state")!;

    listener.emit(`http://127.0.0.1:9999/?state=${state}&code=auth-code`);
    await signInPromise;

    expect(session.status()).toBe("signed_in");
    expect(notifications).toEqual(["signed_in"]);
    await expect(secrets.get("google_refresh_token")).resolves.toBe(
      "refresh-1",
    );
    expect(listener.closeCalls()).toBe(1);
  });

  it("ignores stray redirects with neither code nor error", async () => {
    const listener = createFakeListener();
    const deps = baseDeps({ listener });
    const session = createAuthSession(deps);

    const signInPromise = session.signIn();
    await waitForCalls(deps.openUrl);

    const state = new URL(
      vi.mocked(deps.openUrl).mock.calls[0]![0],
    ).searchParams.get("state")!;

    listener.emit("http://127.0.0.1:9999/favicon.ico");
    await Promise.resolve();
    listener.emit(`http://127.0.0.1:9999/?state=${state}&code=auth-code`);

    await signInPromise;
    expect(session.status()).toBe("signed_in");
  });

  it("rejects with access_denied and still closes the listener", async () => {
    const listener = createFakeListener();
    const deps = baseDeps({ listener });
    const session = createAuthSession(deps);

    const signInPromise = session.signIn();
    await waitForCalls(deps.openUrl);
    const state = new URL(
      vi.mocked(deps.openUrl).mock.calls[0]![0],
    ).searchParams.get("state")!;

    listener.emit(
      `http://127.0.0.1:9999/?state=${state}&error=access_denied&error_description=User+denied`,
    );

    await expect(signInPromise).rejects.toMatchObject({
      code: "access_denied",
    });
    expect(session.status()).toBe("signed_out");
    expect(listener.closeCalls()).toBe(1);
  });

  it("rejects with state_mismatch and still closes the listener", async () => {
    const listener = createFakeListener();
    const deps = baseDeps({ listener });
    const session = createAuthSession(deps);

    const signInPromise = session.signIn();
    await waitForCalls(deps.openUrl);

    listener.emit("http://127.0.0.1:9999/?state=wrong&code=auth-code");

    await expect(signInPromise).rejects.toMatchObject({
      code: "state_mismatch",
    });
    expect(listener.closeCalls()).toBe(1);
  });

  it("times out and still closes the listener", async () => {
    const listener = createFakeListener();
    const deps = baseDeps({ listener, signInTimeoutMs: 10 });
    const session = createAuthSession(deps);

    await expect(session.signIn()).rejects.toMatchObject({ code: "timeout" });
    expect(listener.closeCalls()).toBe(1);
  });

  it("throws no_refresh_token when Google's response has no refresh_token", async () => {
    const listener = createFakeListener();
    const { fetch } = createFakeFetch({
      token: () => jsonResponse(200, tokenBody({ refresh_token: undefined })),
    });
    const deps = baseDeps({ listener, fetch });
    const session = createAuthSession(deps);

    const signInPromise = session.signIn();
    await waitForCalls(deps.openUrl);
    const state = new URL(
      vi.mocked(deps.openUrl).mock.calls[0]![0],
    ).searchParams.get("state")!;
    listener.emit(`http://127.0.0.1:9999/?state=${state}&code=auth-code`);

    await expect(signInPromise).rejects.toMatchObject({
      code: "no_refresh_token",
    });
    expect(session.status()).toBe("signed_out");
  });

  it("rejects a concurrent second signIn() with sign_in_in_progress", async () => {
    const listener = createFakeListener();
    const deps = baseDeps({ listener });
    const session = createAuthSession(deps);

    const first = session.signIn();
    await expect(session.signIn()).rejects.toMatchObject({
      code: "sign_in_in_progress",
    });

    // Clean up the first call so it doesn't dangle past the test.
    await waitForCalls(deps.openUrl);
    const state = new URL(
      vi.mocked(deps.openUrl).mock.calls[0]![0],
    ).searchParams.get("state")!;
    listener.emit(`http://127.0.0.1:9999/?state=${state}&code=auth-code`);
    await first;
  });

  it("allows a new signIn() after the previous one finished", async () => {
    const listener = createFakeListener();
    const deps = baseDeps({ listener, signInTimeoutMs: 10 });
    const session = createAuthSession(deps);

    await expect(session.signIn()).rejects.toMatchObject({ code: "timeout" });

    const listener2 = createFakeListener();
    vi.mocked(deps.startLoopbackListener).mockResolvedValue(listener2);
    const second = session.signIn();
    await waitForCalls(deps.openUrl, 2);
    const state = new URL(
      vi.mocked(deps.openUrl).mock.calls[1]![0],
    ).searchParams.get("state")!;
    listener2.emit(`http://127.0.0.1:9999/?state=${state}&code=auth-code`);
    await second;
    expect(session.status()).toBe("signed_in");
  });
});

describe("signIn cancellation", () => {
  it("rejects immediately with cancelled when the signal is already aborted, without starting a listener", async () => {
    const deps = baseDeps();
    const session = createAuthSession(deps);
    const controller = new AbortController();
    controller.abort();

    await expect(
      session.signIn({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(deps.startLoopbackListener).not.toHaveBeenCalled();
    expect(session.status()).toBe("signed_out");
  });

  it("aborting while waiting for the redirect closes the listener, rejects with cancelled, stores no tokens, and frees signIn() to start again", async () => {
    const listener = createFakeListener();
    const secrets = createTestSecretStore();
    const deps = baseDeps({ listener, secrets });
    const session = createAuthSession(deps);
    const controller = new AbortController();

    const first = session.signIn({ signal: controller.signal });
    await waitForCalls(deps.openUrl);

    controller.abort();

    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    expect(listener.closeCalls()).toBe(1);
    expect(session.status()).toBe("signed_out");
    await expect(secrets.get("google_refresh_token")).resolves.toBeNull();

    // signInInFlight must have been cleared: a new signIn() starts right away.
    const listener2 = createFakeListener();
    vi.mocked(deps.startLoopbackListener).mockResolvedValue(listener2);
    const second = session.signIn();
    await waitForCalls(deps.openUrl, 2);
    const state = new URL(
      vi.mocked(deps.openUrl).mock.calls[1]![0],
    ).searchParams.get("state")!;
    listener2.emit(`http://127.0.0.1:9999/?state=${state}&code=auth-code`);
    await second;
    expect(session.status()).toBe("signed_in");
  });

  it("a redirect that arrives after cancel does not sign in", async () => {
    const listener = createFakeListener();
    const secrets = createTestSecretStore();
    const deps = baseDeps({ listener, secrets });
    const session = createAuthSession(deps);
    const controller = new AbortController();

    const first = session.signIn({ signal: controller.signal });
    await waitForCalls(deps.openUrl);
    const state = new URL(
      vi.mocked(deps.openUrl).mock.calls[0]![0],
    ).searchParams.get("state")!;

    controller.abort();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });

    // The redirect shows up late, after the user already cancelled.
    listener.emit(`http://127.0.0.1:9999/?state=${state}&code=auth-code`);
    // Let the orphaned background flow (parseRedirect -> exchangeCode) run
    // to completion; its result must not be applied to the session.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.status()).toBe("signed_out");
    await expect(secrets.get("google_refresh_token")).resolves.toBeNull();
  });
});

describe("restore", () => {
  it("goes signed_in without a network call when a refresh token is stored", async () => {
    const secrets = createTestSecretStore();
    await secrets.set("google_refresh_token", "refresh-1");
    const { fetch } = createFakeFetch({});
    const deps = baseDeps({ secrets, fetch });
    const session = createAuthSession(deps);

    await expect(session.restore()).resolves.toBe(true);
    expect(session.status()).toBe("signed_in");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stays signed_out when no refresh token is stored", async () => {
    const session = createAuthSession(baseDeps());
    await expect(session.restore()).resolves.toBe(false);
    expect(session.status()).toBe("signed_out");
  });
});

describe("getAccessToken", () => {
  it("throws not_signed_in while signed out", async () => {
    const session = createAuthSession(baseDeps());
    await expect(session.getAccessToken()).rejects.toMatchObject({
      code: "not_signed_in",
    });
  });

  it("refreshes when there's no cached token yet, then reuses it", async () => {
    const secrets = createTestSecretStore();
    await secrets.set("google_refresh_token", "refresh-1");
    const { fetch, tokenCalls } = createFakeFetch({});
    const session = createAuthSession(baseDeps({ secrets, fetch }));
    await session.restore();

    await expect(session.getAccessToken()).resolves.toBe("access-1");
    await expect(session.getAccessToken()).resolves.toBe("access-1");
    expect(tokenCalls()).toBe(1);
  });

  it("refreshes again once the cached token is within 60s of expiry", async () => {
    const secrets = createTestSecretStore();
    await secrets.set("google_refresh_token", "refresh-1");
    let clock = NOW;
    const { fetch, tokenCalls } = createFakeFetch({});
    const session = createAuthSession(
      baseDeps({ secrets, fetch, now: () => clock }),
    );
    await session.restore();

    await session.getAccessToken();
    expect(tokenCalls()).toBe(1);

    // 3600s expiry, now 3599s later: within the 60s buffer.
    clock += 3599 * 1000;
    await session.getAccessToken();
    expect(tokenCalls()).toBe(2);
  });

  it("single-flights concurrent refreshes into one request", async () => {
    const secrets = createTestSecretStore();
    await secrets.set("google_refresh_token", "refresh-1");
    const { fetch, tokenCalls } = createFakeFetch({});
    const session = createAuthSession(baseDeps({ secrets, fetch }));
    await session.restore();

    const [a, b] = await Promise.all([
      session.getAccessToken(),
      session.getAccessToken(),
    ]);
    expect(a).toBe("access-1");
    expect(b).toBe("access-1");
    expect(tokenCalls()).toBe(1);
  });

  it("on invalid_grant, deletes the stored token and goes signed_out", async () => {
    const secrets = createTestSecretStore();
    await secrets.set("google_refresh_token", "stale");
    const { fetch } = createFakeFetch({
      token: () =>
        jsonResponse(400, {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        }),
    });
    const session = createAuthSession(baseDeps({ secrets, fetch }));
    await session.restore();

    await expect(session.getAccessToken()).rejects.toMatchObject({
      code: "invalid_grant",
    });
    expect(session.status()).toBe("signed_out");
    await expect(secrets.get("google_refresh_token")).resolves.toBeNull();
  });

  it("stores a rotated refresh_token when the refresh response includes one", async () => {
    const secrets = createTestSecretStore();
    await secrets.set("google_refresh_token", "old-refresh");
    const { fetch } = createFakeFetch({
      token: () =>
        jsonResponse(200, tokenBody({ refresh_token: "rotated-refresh" })),
    });
    const session = createAuthSession(baseDeps({ secrets, fetch }));
    await session.restore();

    await expect(session.getAccessToken()).resolves.toBe("access-1");
    await expect(secrets.get("google_refresh_token")).resolves.toBe(
      "rotated-refresh",
    );
  });

  it("discards a refresh that resolves after signOut(): rejects not_signed_in and caches nothing", async () => {
    const secrets = createTestSecretStore();
    await secrets.set("google_refresh_token", "refresh-1");
    const { fetch, resolveToken } = createDeferredTokenFetch();
    const session = createAuthSession(baseDeps({ secrets, fetch }));
    await session.restore();

    const pendingAccessToken = session.getAccessToken();

    await session.signOut();
    expect(session.status()).toBe("signed_out");

    // The refresh's fetch only resolves now, after signOut() already ran.
    resolveToken(tokenBody());

    await expect(pendingAccessToken).rejects.toMatchObject({
      code: "not_signed_in",
    });
    expect(session.status()).toBe("signed_out");
    await expect(secrets.get("google_refresh_token")).resolves.toBeNull();

    // No token was cached from the stale refresh: a fresh call still needs
    // a real sign-in, not just a network round trip.
    await expect(session.getAccessToken()).rejects.toMatchObject({
      code: "not_signed_in",
    });
  });

  it("invalidateAccessToken forces the next call to refresh", async () => {
    const secrets = createTestSecretStore();
    await secrets.set("google_refresh_token", "refresh-1");
    const { fetch, tokenCalls } = createFakeFetch({});
    const session = createAuthSession(baseDeps({ secrets, fetch }));
    await session.restore();

    await session.getAccessToken();
    expect(tokenCalls()).toBe(1);

    session.invalidateAccessToken();
    await session.getAccessToken();
    expect(tokenCalls()).toBe(2);
  });
});

describe("signOut", () => {
  it("revokes the refresh token, deletes it, and goes signed_out", async () => {
    const secrets = createTestSecretStore();
    await secrets.set("google_refresh_token", "refresh-1");
    let revokeCalls = 0;
    const { fetch } = createFakeFetch({
      revoke: () => {
        revokeCalls += 1;
        return new Response(null, { status: 200 });
      },
    });
    const session = createAuthSession(baseDeps({ secrets, fetch }));
    await session.restore();

    await session.signOut();

    expect(revokeCalls).toBe(1);
    expect(session.status()).toBe("signed_out");
    await expect(secrets.get("google_refresh_token")).resolves.toBeNull();
  });

  it("still clears local state when the revoke request fails (offline)", async () => {
    const secrets = createTestSecretStore();
    await secrets.set("google_refresh_token", "refresh-1");
    const fetch = vi
      .fn()
      .mockRejectedValue(
        new Error("offline"),
      ) as unknown as typeof globalThis.fetch;
    const session = createAuthSession(baseDeps({ secrets, fetch }));
    await session.restore();

    await expect(session.signOut()).resolves.toBeUndefined();
    expect(session.status()).toBe("signed_out");
    await expect(secrets.get("google_refresh_token")).resolves.toBeNull();
  });

  it("is a no-op-ish clear when already signed out (no refresh token to revoke)", async () => {
    const { fetch } = createFakeFetch({});
    const session = createAuthSession(baseDeps({ fetch }));

    await expect(session.signOut()).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(session.status()).toBe("signed_out");
  });
});
