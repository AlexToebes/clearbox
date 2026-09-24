/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Google OAuth "Desktop app" client ID. See README.md. */
  readonly VITE_GOOGLE_CLIENT_ID: string;
  /** Google OAuth "Desktop app" client secret (not confidential for a
   * desktop client — see README.md). */
  readonly VITE_GOOGLE_CLIENT_SECRET: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
