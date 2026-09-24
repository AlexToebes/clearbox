import { fetch } from "@tauri-apps/plugin-http";

/**
 * Drop-in replacement for the global `fetch`, routed through
 * `tauri-plugin-http` so requests are made from Rust (bypassing the
 * webview's CORS restrictions) and are constrained to the URLs allow-listed
 * in `src-tauri/capabilities/default.json`.
 */
export const httpFetch: typeof globalThis.fetch = fetch;
