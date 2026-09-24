import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { GmailProfile } from "@/lib/gmail/types";
import { useAuth } from "./context";

type ProfileState =
  | { kind: "loading" }
  | { kind: "loaded"; profile: GmailProfile }
  | { kind: "error"; message: string };

/**
 * Shown while signed in: the account's address and message count from
 * `getProfile()`, and a sign-out button. Placeholder for the dashboard
 * (issue #6).
 */
export function SignedInCard() {
  const { auth, gmail } = useAuth();
  const [profileState, setProfileState] = useState<ProfileState>({
    kind: "loading",
  });
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!gmail) {
      return;
    }
    let cancelled = false;

    async function loadProfile(client: NonNullable<typeof gmail>) {
      setProfileState({ kind: "loading" });
      try {
        const profile = await client.getProfile();
        if (!cancelled) {
          setProfileState({ kind: "loaded", profile });
        }
      } catch (err) {
        if (!cancelled) {
          setProfileState({
            kind: "error",
            message:
              err instanceof Error
                ? err.message
                : "Failed to load your Gmail profile.",
          });
        }
      }
    }

    void loadProfile(gmail);

    return () => {
      cancelled = true;
    };
  }, [gmail]);

  async function handleSignOut(): Promise<void> {
    if (!auth) {
      return;
    }
    setSigningOut(true);
    try {
      await auth.signOut();
      toast("Signed out.");
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-2xl">Clearbox</CardTitle>
        <CardDescription>
          {profileState.kind === "loaded"
            ? profileState.profile.emailAddress
            : "Connected to Gmail"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {profileState.kind === "loading" && (
          <p className="text-muted-foreground text-sm">Loading your mailbox…</p>
        )}
        {profileState.kind === "error" && (
          <p className="text-destructive text-sm">{profileState.message}</p>
        )}
        {profileState.kind === "loaded" && (
          <Badge variant="secondary" className="w-fit">
            {profileState.profile.messagesTotal.toLocaleString()} messages
          </Badge>
        )}
        <Separator />
        <p className="text-muted-foreground text-xs">
          The dashboard for cleaning up your mailbox lands with issue #6.
        </p>
      </CardContent>
      <CardFooter>
        <Button
          variant="outline"
          className="w-full"
          disabled={signingOut}
          onClick={() => void handleSignOut()}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </Button>
      </CardFooter>
    </Card>
  );
}
