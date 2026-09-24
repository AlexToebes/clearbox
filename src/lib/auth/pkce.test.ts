import { describe, expect, it } from "vitest";
import {
  computeCodeChallenge,
  generateCodeVerifier,
  generateState,
} from "./pkce";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("computeCodeChallenge", () => {
  // RFC 7636 Appendix B test vector.
  it("matches the RFC 7636 Appendix B test vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    await expect(computeCodeChallenge(verifier)).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("is deterministic for a given verifier", async () => {
    const verifier = generateCodeVerifier();
    const a = await computeCodeChallenge(verifier);
    const b = await computeCodeChallenge(verifier);
    expect(a).toBe(b);
  });
});

describe("generateCodeVerifier", () => {
  it("produces a 43-character base64url string (32 random bytes, no padding)", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(BASE64URL);
  });

  it("is not the same across calls", () => {
    const verifiers = new Set(
      Array.from({ length: 20 }, () => generateCodeVerifier()),
    );
    expect(verifiers.size).toBe(20);
  });
});

describe("generateState", () => {
  it("produces a base64url string with no padding", () => {
    const state = generateState();
    expect(state).toMatch(BASE64URL);
    // 16 random bytes, base64url-encoded, is at least 22 characters.
    expect(state.length).toBeGreaterThanOrEqual(22);
  });

  it("is not the same across calls", () => {
    const states = new Set(Array.from({ length: 20 }, () => generateState()));
    expect(states.size).toBe(20);
  });
});
