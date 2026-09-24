import { OAuthError } from "@/lib/auth/google";

/** Maps a sign-in failure to friendly, user-facing text. */
export function describeAuthError(err: unknown): string {
  if (err instanceof OAuthError) {
    switch (err.code) {
      case "access_denied":
        return "Sign-in was cancelled.";
      case "insufficient_scope":
        return "Clearbox needs Gmail access — please tick the Gmail checkbox.";
      case "timeout":
        return "Google didn't respond in time. Please try again.";
      case "invalid_grant":
        return "Session expired, please reconnect.";
      case "sign_in_in_progress":
        return "A sign-in is already in progress.";
      case "cancelled":
        return "Sign-in was cancelled.";
      default:
        return err.description ?? "Something went wrong signing in.";
    }
  }
  return "Something went wrong signing in.";
}

/**
 * True for the `OAuthError("cancelled")` a user-initiated `signIn({ signal
 * })` abort rejects with (`lib/auth/session.ts`). Callers use this to skip
 * showing an error for a cancellation the user asked for themselves.
 */
export function isCancelledAuthError(err: unknown): boolean {
  return err instanceof OAuthError && err.code === "cancelled";
}

/**
 * Renders the raw error text from a failed `AuthSession.restore()` — shown
 * as a small, muted detail line underneath the friendlier explanation in
 * `SignedOutCard`.
 */
export function describeRestoreError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
