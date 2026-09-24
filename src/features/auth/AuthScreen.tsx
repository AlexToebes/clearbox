import { useAuth } from "./context";
import { MissingConfigCard } from "./MissingConfigCard";
import { SignedInCard } from "./SignedInCard";
import { SignedOutCard } from "./SignedOutCard";

/** Picks the right card for the current auth status. */
export function AuthScreen() {
  const { status } = useAuth();

  switch (status) {
    case "no_config":
      return <MissingConfigCard />;
    case "signed_in":
      return <SignedInCard />;
    case "signed_out":
      return <SignedOutCard />;
  }
}
