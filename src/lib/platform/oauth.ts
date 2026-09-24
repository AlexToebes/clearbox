import { cancel, onUrl, start } from "@fabianlars/tauri-plugin-oauth";
import type { LoopbackListener } from "@/lib/auth/types";

/**
 * Shown in the browser tab after Google redirects back to the loopback
 * server, so the user knows they can stop looking at it.
 */
const RESPONSE_HTML =
  "<html><body>You can close this tab and return to Clearbox.</body></html>";

/**
 * Starts a one-shot local HTTP server (via `tauri-plugin-oauth`) to receive
 * the Google OAuth redirect, implementing `LoopbackListener`
 * (`lib/auth/types.ts`).
 *
 * Verified from the plugin's Rust source (`tauri-plugin-oauth` 2.1.0,
 * `src/lib.rs`): the server always binds `127.0.0.1` (never `0.0.0.0` or
 * `::1`) on a system-assigned port, and — since we don't pass a
 * `redirect_uri` in `OauthConfig` — the URL delivered to `onUrl` is the full
 * URL the browser navigated to (`window.location.href`, captured by a small
 * inline script in the response page and posted back to the server), i.e.
 * `http://127.0.0.1:<port>/?code=...&state=...`, not just the path.
 */
export async function startLoopbackListener(): Promise<LoopbackListener> {
  let deliverNext: ((url: string) => void) | null = null;
  const undelivered: string[] = [];

  const unlisten = await onUrl((url) => {
    if (deliverNext) {
      const deliver = deliverNext;
      deliverNext = null;
      deliver(url);
    } else {
      undelivered.push(url);
    }
  });

  const port = await start({ response: RESPONSE_HTML });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    unlisten();
    await cancel(port);
  };

  return {
    redirectUri: `http://127.0.0.1:${port}`,
    nextRedirect: () =>
      new Promise<string>((resolve) => {
        const queued = undelivered.shift();
        if (queued !== undefined) {
          resolve(queued);
        } else {
          deliverNext = resolve;
        }
      }),
    close,
  };
}
