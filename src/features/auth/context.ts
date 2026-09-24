import { createContext, useContext } from "react";
import type { AuthSession, AuthStatus } from "@/lib/auth/session";
import type { GmailClient } from "@/lib/gmail/client";

/** `AuthStatus` plus `"no_config"`: the Google OAuth client credentials
 * (`.env.local`) are missing, so there's no `AuthSession` to be in either
 * status. */
export type AuthScreenStatus = AuthStatus | "no_config";

export interface AuthContextValue {
  status: AuthScreenStatus;
  /** `null` when `status === "no_config"`. */
  auth: AuthSession | null;
  /** `null` when `status === "no_config"`. */
  gmail: GmailClient | null;
}

export const NO_CONFIG_VALUE: AuthContextValue = {
  status: "no_config",
  auth: null,
  gmail: null,
};

export const AuthContext = createContext<AuthContextValue | null>(null);

/** Reads the current auth status and (when configured) the `AuthSession`/
 * `GmailClient` pair. Must be used within an `AuthProvider`. */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return value;
}
