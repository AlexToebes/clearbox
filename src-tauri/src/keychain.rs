//! OS keychain access, exposed to the frontend as three Tauri commands. Used
//! to store the Google OAuth refresh token (see "Authentication" in
//! `docs/ARCHITECTURE.md`); the TypeScript side only ever sees the
//! `SecretStore` interface in `src/lib/auth/types.ts`, implemented against
//! these commands by `src/lib/platform/keychain.ts`.
//!
//! `keyring` calls are blocking (they talk to the platform keychain
//! service), so each command runs its call on the blocking thread pool via
//! `tauri::async_runtime::spawn_blocking` rather than blocking an async
//! worker.

use keyring::Entry;

/// The keychain service name every secret is stored under, alongside a
/// caller-provided key (e.g. `"google_refresh_token"`).
const SERVICE: &str = "com.clearbox.app";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|err| err.to_string())
}

/// Reads a secret from the OS keychain. Returns `Ok(None)` if no value is
/// stored for `key` (not an error).
#[tauri::command]
pub async fn secret_get(key: String) -> Result<Option<String>, String> {
    if key.is_empty() {
        return Err("key must not be empty".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let entry = entry(&key)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Writes (or overwrites) a secret in the OS keychain.
#[tauri::command]
pub async fn secret_set(key: String, value: String) -> Result<(), String> {
    if key.is_empty() {
        return Err("key must not be empty".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let entry = entry(&key)?;
        entry.set_password(&value).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Deletes a secret from the OS keychain. A missing entry is treated as
/// success (deleting is idempotent).
#[tauri::command]
pub async fn secret_delete(key: String) -> Result<(), String> {
    if key.is_empty() {
        return Err("key must not be empty".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let entry = entry(&key)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A key unlikely to collide with another run of this test (or a real
    /// secret), so it's safe to run against a real OS keychain.
    fn unique_test_key() -> String {
        let pid = std::process::id();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is before the epoch")
            .as_nanos();
        format!("clearbox_keychain_test_{pid}_{now}")
    }

    /// Round-trips a secret through the real OS keychain via the three
    /// Tauri commands. Needs a working Secret Service (Linux), Keychain
    /// (macOS), or Credential Manager (Windows) — run with `--ignored`, and
    /// on Linux inside a D-Bus session with a keyring unlocked, e.g.:
    ///
    /// ```sh
    /// dbus-run-session -- bash -c \
    ///   "printf '' | gnome-keyring-daemon --unlock --components=secrets >/dev/null; \
    ///    cargo test keychain -- --include-ignored"
    /// ```
    #[test]
    #[ignore = "needs an OS keychain (run with --ignored)"]
    fn round_trips_a_secret_through_the_os_keychain() {
        let key = unique_test_key();

        assert_eq!(
            tauri::async_runtime::block_on(secret_get(key.clone())),
            Ok(None),
            "no value should be stored yet",
        );

        assert_eq!(
            tauri::async_runtime::block_on(secret_set(key.clone(), "value".to_string())),
            Ok(()),
        );

        assert_eq!(
            tauri::async_runtime::block_on(secret_get(key.clone())),
            Ok(Some("value".to_string())),
        );

        assert_eq!(
            tauri::async_runtime::block_on(secret_delete(key.clone())),
            Ok(()),
        );

        assert_eq!(
            tauri::async_runtime::block_on(secret_get(key.clone())),
            Ok(None),
            "value should be gone after delete",
        );

        // Deleting an already-absent entry is idempotent, not an error.
        assert_eq!(tauri::async_runtime::block_on(secret_delete(key)), Ok(()));
    }

    /// Doesn't touch the OS keychain, so it runs by default (not
    /// `#[ignore]`d) along with the rest of the suite.
    #[test]
    fn rejects_an_empty_key() {
        let empty = String::new();

        assert_eq!(
            tauri::async_runtime::block_on(secret_get(empty.clone())),
            Err("key must not be empty".to_string()),
        );
        assert_eq!(
            tauri::async_runtime::block_on(secret_set(empty.clone(), "value".to_string())),
            Err("key must not be empty".to_string()),
        );
        assert_eq!(
            tauri::async_runtime::block_on(secret_delete(empty)),
            Err("key must not be empty".to_string()),
        );
    }
}
