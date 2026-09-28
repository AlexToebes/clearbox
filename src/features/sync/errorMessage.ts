import { GmailApiError } from "@/lib/gmail/client";

/** Maps a failed scan's error to friendly, user-facing text (see
 * `ScanPanel`'s error state). */
export function describeScanError(err: unknown): string {
  if (err instanceof GmailApiError && err.status === 403) {
    return "Gmail refused the request (403). Check that the Gmail API is enabled for your Google Cloud project.";
  }
  if (err instanceof TypeError) {
    return "Couldn't reach Gmail. Check your connection.";
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "Something went wrong while scanning your mailbox.";
}
