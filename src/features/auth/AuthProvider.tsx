import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { getServices } from "@/app/services";
import { AuthContext, NO_CONFIG_VALUE, type AuthContextValue } from "./context";

/**
 * Provides the app's `AuthSession`/`GmailClient` (via `getServices()`) to
 * `useAuth()`, re-rendering subscribers whenever the session's status
 * changes (`useSyncExternalStore`). Restores a previously signed-in session
 * on mount; if that fails (e.g. the OS keychain is unavailable) the error
 * is kept in state and exposed as `restoreError` rather than left as an
 * unhandled rejection, so the signed-out screen can explain it.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const services = useMemo(() => getServices(), []);
  const [restoreError, setRestoreError] = useState<unknown>(null);

  const status = useSyncExternalStore(
    (onStoreChange) =>
      services ? services.auth.subscribe(onStoreChange) : () => {},
    () => (services ? services.auth.status() : "no_config"),
  );

  useEffect(() => {
    if (!services) {
      return;
    }
    services.auth.restore().catch((err: unknown) => {
      console.error("Failed to restore auth session:", err);
      setRestoreError(err);
    });
  }, [services]);

  const value = useMemo<AuthContextValue>(() => {
    if (!services) {
      return NO_CONFIG_VALUE;
    }
    return { status, auth: services.auth, gmail: services.gmail, restoreError };
  }, [services, status, restoreError]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
