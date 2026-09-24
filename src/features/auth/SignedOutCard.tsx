import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAuth } from "./context";
import {
  describeAuthError,
  describeRestoreError,
  isCancelledAuthError,
} from "./errorMessage";

/**
 * Shown while signed out: the "Connect Gmail" entry point, with an inline
 * error message on failure. "Cancel" aborts the in-progress `signIn()` via
 * an `AbortController` — the session closes the loopback listener right
 * away and stores no tokens (see `AuthSession.signIn` in
 * `lib/auth/session.ts`); the resulting `OAuthError("cancelled")` isn't
 * shown as an error since the user asked for it.
 *
 * Also surfaces `restoreError` (set by `AuthProvider` when
 * `AuthSession.restore()` rejected, e.g. an unavailable OS keychain) so the
 * user isn't just left looking at a plain signed-out screen with no
 * explanation. The Connect button stays enabled either way — retrying is
 * fine.
 */
export function SignedOutCard() {
  const { auth, restoreError } = useAuth();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  async function handleConnect(): Promise<void> {
    if (!auth) {
      return;
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setSigningIn(true);
    setError(null);
    try {
      await auth.signIn({ signal: controller.signal });
      toast.success("Connected to Gmail.");
    } catch (err) {
      if (!isCancelledAuthError(err)) {
        setError(describeAuthError(err));
      }
    } finally {
      abortControllerRef.current = null;
      setSigningIn(false);
    }
  }

  function handleCancel(): void {
    abortControllerRef.current?.abort();
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-2xl">Clearbox</CardTitle>
        <CardDescription>Clean up your Gmail, locally.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {signingIn ? (
          <div className="flex flex-col gap-2">
            <Button className="w-full" disabled>
              Waiting for Google…
            </Button>
            <Button variant="ghost" className="w-full" onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button className="w-full" onClick={() => void handleConnect()}>
            Connect Gmail
          </Button>
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}
        {restoreError !== null && (
          <div className="text-sm">
            <p>
              Clearbox couldn't access your system keychain, which it uses to
              store your Google sign-in securely.
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              {describeRestoreError(restoreError)}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              If you're on Linux, make sure a Secret Service provider such as
              GNOME Keyring or KWallet is running.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
