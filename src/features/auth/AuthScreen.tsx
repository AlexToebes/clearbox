import { AppShell } from "@/features/shell/AppShell";
import { useAuth } from "./context";
import { MissingConfigCard } from "./MissingConfigCard";
import { SignedOutCard } from "./SignedOutCard";

/**
 * Picks the right screen for the current auth status. Signed in gets the
 * full-width `AppShell`; the other two states are small cards that center
 * themselves on the page.
 */
export function AuthScreen() {
  const { status } = useAuth();

  switch (status) {
    case "no_config":
      return <MissingConfigCard />;
    case "signed_in":
      return <AppShell />;
    case "signed_out":
      return <SignedOutCard />;
  }
}
