import { describe, expect, it } from "vitest";
import {
  buildAuthUrl,
  GMAIL_SCOPE,
  GOOGLE_AUTH_ENDPOINT,
  OAuthError,
  parseRedirect,
} from "./google";

describe("buildAuthUrl", () => {
  it("sets every required PKCE + installed-app param", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: "client-123",
        redirectUri: "http://127.0.0.1:5555",
        codeChallenge: "challenge-abc",
        state: "state-xyz",
      }),
    );

    expect(url.origin + url.pathname).toBe(GOOGLE_AUTH_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-123",
      redirect_uri: "http://127.0.0.1:5555",
      scope: GMAIL_SCOPE,
      state: "state-xyz",
      code_challenge: "challenge-abc",
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });
  });

  it("accepts a custom scope", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: "client-123",
        redirectUri: "http://127.0.0.1:5555",
        codeChallenge: "challenge-abc",
        state: "state-xyz",
        scope: "custom-scope",
      }),
    );
    expect(url.searchParams.get("scope")).toBe("custom-scope");
  });
});

describe("parseRedirect", () => {
  it("extracts the code when state matches", () => {
    const result = parseRedirect(
      "http://127.0.0.1:5555/?state=abc&code=the-code",
      "abc",
    );
    expect(result).toEqual({ code: "the-code" });
  });

  it("throws OAuthError('access_denied') when Google reports an error", () => {
    expect(() =>
      parseRedirect(
        "http://127.0.0.1:5555/?state=abc&error=access_denied&error_description=User+denied",
        "abc",
      ),
    ).toThrow(OAuthError);

    try {
      parseRedirect(
        "http://127.0.0.1:5555/?state=abc&error=access_denied&error_description=User+denied",
        "abc",
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).code).toBe("access_denied");
      expect((err as OAuthError).description).toBe("User denied");
    }
  });

  it("throws OAuthError('state_mismatch') when state doesn't match", () => {
    try {
      parseRedirect("http://127.0.0.1:5555/?state=wrong&code=c", "expected");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).code).toBe("state_mismatch");
    }
  });

  it("throws OAuthError('missing_code') when there's no code", () => {
    try {
      parseRedirect("http://127.0.0.1:5555/?state=abc", "abc");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).code).toBe("missing_code");
    }
  });
});
