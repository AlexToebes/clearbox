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
