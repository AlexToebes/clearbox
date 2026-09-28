import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DashboardPlaceholder } from "@/features/dashboard/DashboardPlaceholder";
import { useAuth } from "@/features/auth/context";
import { ScanPanel } from "@/features/sync/ScanPanel";

/**
 * The signed-in app shell: a slim top bar (wordmark, account email, sign
 * out) over a full-width main area with the mailbox scan panel and (once
 * there's anything cached) the dashboard placeholder. Replaces the old
 * `SignedInCard`.
 */
export function AppShell() {
  const { gmail, signOutAndClear } = useAuth();
  const [email, setEmail] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!gmail) {
      return;
    }
    let cancelled = false;
    gmail
      .getProfile()
      .then((profile) => {
        if (!cancelled) {
          setEmail(profile.emailAddress);
        }
      })
      .catch(() => {
        // The top bar just omits the address; ScanPanel surfaces getProfile
        // failures where it matters.
      });
    return () => {
      cancelled = true;
    };
  }, [gmail]);

  async function handleSignOut(): Promise<void> {
    setSigningOut(true);
    try {
      await signOutAndClear();
      toast("Signed out. Local mail data removed from this computer.");
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <span className="text-lg font-semibold">Clearbox</span>
          <div className="flex items-center gap-3">
            {email && (
              <span className="text-muted-foreground text-sm">{email}</span>
            )}
            <Button
              variant="ghost"
              disabled={signingOut}
              onClick={() => void handleSignOut()}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6">
        <ScanPanel />
        <DashboardPlaceholder />
      </main>
    </div>
  );
}
