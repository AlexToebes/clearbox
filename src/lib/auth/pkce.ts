/**
 * PKCE (RFC 7636) helpers for the Google OAuth loopback flow (see
 * `lib/auth/google.ts` and "Authentication" in `docs/ARCHITECTURE.md`).
 *
 * These use the global Web Crypto API (`crypto.getRandomValues`,
 * `crypto.subtle`), available in both the Tauri webview and Node 22 (for
 * Vitest), so nothing here needs to live under `lib/platform/`.
 */

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Generates a PKCE code verifier: 32 random bytes, base64url-encoded
 * (no padding) to a 43-character string, per RFC 7636 §4.1.
 */
export function generateCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64UrlEncode(bytes);
}

/**
 * Computes the S256 PKCE code challenge for a verifier: `BASE64URL(SHA256(verifier))`,
 * per RFC 7636 §4.2.
 */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Generates a random `state` value to guard the OAuth redirect against CSRF
 * (RFC 6749 §10.12): 16 random bytes, base64url-encoded (no padding).
 */
export function generateState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return base64UrlEncode(bytes);
}
