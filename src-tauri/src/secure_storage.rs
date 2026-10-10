// The webview-facing commands authorize the caller before entering this module.
#[cfg(not(target_os = "android"))]
fn credential() -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.nostr.anagram", "active-private-key")
        .map_err(|_| "Secure storage operation failed".to_string())
}

#[cfg(not(target_os = "android"))]
pub fn read(_: &tauri::AppHandle) -> Result<Option<String>, String> {
    match credential()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Secure storage operation failed".into()),
    }
}
#[cfg(not(target_os = "android"))]
pub fn write(_: &tauri::AppHandle, value: &str) -> Result<(), String> {
    credential()?
        .set_password(value)
        .map_err(|_| "Secure storage operation failed".into())
}
#[cfg(not(target_os = "android"))]
pub fn remove(_: &tauri::AppHandle) -> Result<(), String> {
    match credential()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Secure storage operation failed".into()),
    }
}

#[cfg(target_os = "android")]
mod android {
    use tauri::{
        plugin::{PluginHandle, TauriPlugin},
        Manager, Wry,
    };
    struct SecureStorage(PluginHandle<Wry>);
    pub fn android_plugin() -> TauriPlugin<Wry> {
        tauri::plugin::Builder::new("secure-keys")
            .setup(|app, api| {
                app.manage(SecureStorage(api.register_android_plugin(
                    "com.nostr.anagram",
                    "SecureKeysPlugin",
                )?));
                Ok(())
            })
            .build()
    }
    fn call(
        app: &tauri::AppHandle,
        command: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        app.state::<SecureStorage>()
            .0
            .run_mobile_plugin(command, args)
            .map_err(|_| "Secure storage operation failed".into())
    }
    pub fn read(app: &tauri::AppHandle) -> Result<Option<String>, String> {
        let result = call(app, "read", serde_json::json!({}))?;
        match result.get("value") {
            Some(serde_json::Value::Null) => Ok(None),
            Some(serde_json::Value::String(value)) => Ok(Some(value.clone())),
            _ => Err("Secure storage operation failed".into()),
        }
    }
    pub fn write(app: &tauri::AppHandle, value: &str) -> Result<(), String> {
        call(app, "write", serde_json::json!({"value": value})).map(|_| ())
    }
    pub fn remove(app: &tauri::AppHandle) -> Result<(), String> {
        call(app, "remove", serde_json::json!({})).map(|_| ())
    }
}
#[cfg(target_os = "android")]
pub use android::*;
