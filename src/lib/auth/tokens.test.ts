import { describe, expect, it, vi } from "vitest";
import {
  GMAIL_SCOPE,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  OAuthError,
} from "./google";
import { exchangeCode, refreshAccessToken, revokeToken } from "./tokens";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeFetch(response: Response): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue(response) as typeof globalThis.fetch;
}

const NOW = 1_700_000_000_000;
const now = () => NOW;

describe("exchangeCode", () => {
  it("POSTs the authorization_code grant, form-encoded, and returns a TokenSet", async () => {
    const fetch = fakeFetch(
      jsonResponse(200, {
        access_token: "access-1",
        expires_in: 3600,
        refresh_token: "refresh-1",
        scope: GMAIL_SCOPE,
      }),
    );

    const result = await exchangeCode({
      fetch,
      now,
      clientId: "client-1",
      clientSecret: "secret-1",
      code: "code-1",
      codeVerifier: "verifier-1",
      redirectUri: "http://127.0.0.1:5555",
    });

    expect(result).toEqual({
      accessToken: "access-1",
      expiresAt: NOW + 3_600_000,
      refreshToken: "refresh-1",
      scope: GMAIL_SCOPE,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(
      Object.fromEntries(new URLSearchParams(init?.body as string)),
    ).toEqual({
      grant_type: "authorization_code",
      client_id: "client-1",
      client_secret: "secret-1",
      code: "code-1",
      code_verifier: "verifier-1",
      redirect_uri: "http://127.0.0.1:5555",
    });
  });

  it("throws OAuthError('insufficient_scope') when the granted scope omits GMAIL_SCOPE", async () => {
    const fetch = fakeFetch(
      jsonResponse(200, {
        access_token: "access-1",
        expires_in: 3600,
        refresh_token: "refresh-1",
        scope: "https://www.googleapis.com/auth/userinfo.email",
      }),
    );

    await expect(
      exchangeCode({
        fetch,
        now,
        clientId: "c",
        clientSecret: "s",
        code: "code",
        codeVerifier: "verifier",
        redirectUri: "http://127.0.0.1:5555",
      }),
    ).rejects.toMatchObject({ code: "insufficient_scope" });
  });

  it("throws OAuthError('insufficient_scope') when the authorization_code response omits scope entirely", async () => {
    const fetch = fakeFetch(
      jsonResponse(200, {
        access_token: "access-1",
        expires_in: 3600,
        refresh_token: "refresh-1",
        // no `scope` field at all
      }),
    );

    await expect(
      exchangeCode({
        fetch,
        now,
        clientId: "c",
        clientSecret: "s",
        code: "code",
        codeVerifier: "verifier",
        redirectUri: "http://127.0.0.1:5555",
      }),
    ).rejects.toMatchObject({ code: "insufficient_scope" });
  });

  it("throws when the response is missing access_token or expires_in", async () => {
    const fetch = fakeFetch(jsonResponse(200, { scope: GMAIL_SCOPE }));

    await expect(
      exchangeCode({
        fetch,
        now,
        clientId: "c",
        clientSecret: "s",
        code: "code",
        codeVerifier: "verifier",
        redirectUri: "http://127.0.0.1:5555",
      }),
    ).rejects.toThrow(OAuthError);
  });

  it("propagates network failures", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(new Error("network down")) as typeof globalThis.fetch;

    await expect(
      exchangeCode({
        fetch,
        now,
        clientId: "c",
        clientSecret: "s",
        code: "code",
        codeVerifier: "verifier",
        redirectUri: "http://127.0.0.1:5555",
      }),
    ).rejects.toThrow("network down");
  });

  const errorCases: {
    name: string;
    response: Response;
    expected: { code: string; description?: string };
  }[] = [
    {
      name: "JSON error body maps to OAuthError(error, error_description)",
      response: jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Bad grant",
      }),
      expected: { code: "invalid_grant", description: "Bad grant" },
    },
    {
      name: "non-JSON error body maps to OAuthError(http_<status>)",
      response: new Response("<html>502</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
      expected: { code: "http_502" },
    },
  ];

  it.each(errorCases)("$name", async ({ response, expected }) => {
    const fetch = fakeFetch(response);
    try {
      await exchangeCode({
        fetch,
        now,
        clientId: "c",
        clientSecret: "s",
        code: "code",
        codeVerifier: "verifier",
        redirectUri: "http://127.0.0.1:5555",
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).code).toBe(expected.code);
      if (expected.description) {
        expect((err as OAuthError).description).toBe(expected.description);
      }
    }
  });
});

describe("refreshAccessToken", () => {
  it("POSTs the refresh_token grant, form-encoded, and returns a TokenSet", async () => {
    const fetch = fakeFetch(
      jsonResponse(200, {
        access_token: "access-2",
        expires_in: 1800,
        scope: GMAIL_SCOPE,
      }),
    );

    const result = await refreshAccessToken({
      fetch,
      now,
      clientId: "client-1",
      clientSecret: "secret-1",
      refreshToken: "refresh-1",
    });

    expect(result).toEqual({
      accessToken: "access-2",
      expiresAt: NOW + 1_800_000,
      refreshToken: undefined,
      scope: GMAIL_SCOPE,
    });

    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(
      Object.fromEntries(new URLSearchParams(init?.body as string)),
    ).toEqual({
      grant_type: "refresh_token",
      client_id: "client-1",
      client_secret: "secret-1",
      refresh_token: "refresh-1",
    });
  });

  it("accepts a refresh response that omits scope entirely (Google routinely does this)", async () => {
    const fetch = fakeFetch(
      jsonResponse(200, {
        access_token: "access-2",
        expires_in: 1800,
        // no `scope` field — must not be treated as insufficient_scope.
      }),
    );

    const result = await refreshAccessToken({
      fetch,
      now,
      clientId: "c",
      clientSecret: "s",
      refreshToken: "refresh-1",
    });

    expect(result).toEqual({
      accessToken: "access-2",
      expiresAt: NOW + 1_800_000,
      refreshToken: undefined,
      scope: undefined,
    });
  });

  it("still enforces GMAIL_SCOPE when a refresh response does include scope", async () => {
    const fetch = fakeFetch(
      jsonResponse(200, {
        access_token: "access-2",
        expires_in: 1800,
        scope: "https://www.googleapis.com/auth/userinfo.email",
      }),
    );

    await expect(
      refreshAccessToken({
        fetch,
        now,
        clientId: "c",
        clientSecret: "s",
        refreshToken: "refresh-1",
      }),
    ).rejects.toMatchObject({ code: "insufficient_scope" });
  });

  it("throws OAuthError('invalid_grant') for a revoked/expired refresh token", async () => {
    const fetch = fakeFetch(
      jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      }),
    );

    await expect(
      refreshAccessToken({
        fetch,
        now,
        clientId: "c",
        clientSecret: "s",
        refreshToken: "stale",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });
});

describe("revokeToken", () => {
  it("POSTs token=<token>, form-encoded", async () => {
    const fetch = fakeFetch(new Response(null, { status: 200 }));

    await revokeToken({ fetch, token: "refresh-1" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(GOOGLE_REVOKE_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(
      Object.fromEntries(new URLSearchParams(init?.body as string)),
    ).toEqual({
      token: "refresh-1",
    });
  });

  it("treats a 400 invalid_token as success (already revoked)", async () => {
    const fetch = fakeFetch(jsonResponse(400, { error: "invalid_token" }));
    await expect(
      revokeToken({ fetch, token: "already-gone" }),
    ).resolves.toBeUndefined();
  });

  it("throws on other error statuses", async () => {
    const fetch = fakeFetch(jsonResponse(500, { error: "server_error" }));
    await expect(revokeToken({ fetch, token: "t" })).rejects.toMatchObject({
      code: "server_error",
    });
  });
});
