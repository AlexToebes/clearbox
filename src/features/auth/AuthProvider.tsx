import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { getServices } from "@/app/services";
import { AuthContext, NO_CONFIG_VALUE, type AuthContextValue } from "./context";

/**
 * Provides the app's `AuthSession`/`GmailClient` (via `getServices()`) to
 * `useAuth()`, re-rendering subscribers whenever the session's status
 * changes (`useSyncExternalStore`). Restores a previously signed-in session
 * on mount.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const services = useMemo(() => getServices(), []);

  const status = useSyncExternalStore(
    (onStoreChange) =>
      services ? services.auth.subscribe(onStoreChange) : () => {},
    () => (services ? services.auth.status() : "no_config"),
  );

  useEffect(() => {
    if (!services) {
      return;
    }
    void services.auth.restore();
  }, [services]);

  const value = useMemo<AuthContextValue>(() => {
    if (!services) {
      return NO_CONFIG_VALUE;
    }
    return { status, auth: services.auth, gmail: services.gmail };
  }, [services, status]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
