/**
 * App-level (non-secret-store) configuration: the Google OAuth client
 * credentials, read from build-time env vars (`VITE_GOOGLE_CLIENT_ID`/
 * `VITE_GOOGLE_CLIENT_SECRET` in `.env.local`, typed in `src/vite-env.d.ts`).
 * See "Google Cloud setup" in the README.
 */

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Returns the Google OAuth client config, or `null` if either env var is
 * unset — the UI shows a setup screen in that case instead of a sign-in
 * button that can't work.
 */
export function getGoogleConfig(): GoogleConfig | null {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  const clientSecret = import.meta.env.VITE_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}
