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
import { describeAuthError } from "./errorMessage";

/**
 * Shown while signed out: the "Connect Gmail" entry point, with an inline
 * error message on failure. "Cancel" is a UI-level abort only — it stops
 * showing the waiting state and ignores whatever `signIn()` eventually
 * does; it doesn't close the browser tab or the loopback listener early.
 */
export function SignedOutCard() {
  const { auth } = useAuth();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  async function handleConnect(): Promise<void> {
    if (!auth) {
      return;
    }
    cancelledRef.current = false;
    setSigningIn(true);
    setError(null);
    try {
      await auth.signIn();
      if (!cancelledRef.current) {
        toast.success("Connected to Gmail.");
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setError(describeAuthError(err));
      }
    } finally {
      if (!cancelledRef.current) {
        setSigningIn(false);
      }
    }
  }

  function handleCancel(): void {
    cancelledRef.current = true;
    setSigningIn(false);
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
      </CardContent>
    </Card>
  );
}
