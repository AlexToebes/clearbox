import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Opens `url` in the system's default browser, via `tauri-plugin-opener`.
 * Used to send the user to Google's consent screen — restricted, per
 * `src-tauri/capabilities/default.json`, to `https://accounts.google.com/*`.
 */
export async function openExternalUrl(url: string): Promise<void> {
  await openUrl(url);
}
