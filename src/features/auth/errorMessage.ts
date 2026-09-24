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
      default:
        return err.description ?? "Something went wrong signing in.";
    }
  }
  return "Something went wrong signing in.";
}
