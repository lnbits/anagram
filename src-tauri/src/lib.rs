#[cfg(desktop)]
use std::sync::atomic::AtomicUsize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
#[cfg(target_os = "android")]
mod android_notifications;
#[cfg(any(target_os = "android", test))]
mod call_notifications;
mod secure_storage;
use tauri::Manager;
#[cfg(desktop)]
static PRESENTATION_ID: AtomicUsize = AtomicUsize::new(0);

// Native secrets are available only to the bundled main webview. Presentation
// windows and remotely navigated pages must never inherit keychain access.
fn trusted_app_url(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    ((((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some("tauri.localhost")))
        && url.port().is_none())
        || dev_url.is_some_and(|dev| dev.origin() == url.origin()))
        && url.username().is_empty()
        && url.password().is_none()
}
fn trusted_key_context(label: &str, url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    label == "main" && trusted_app_url(url, dev_url)
}
fn authorize_key_access(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "Private key access denied")?;
    let config = window.app_handle().config();
    let dev_url = if cfg!(debug_assertions) {
        config.build.dev_url.as_ref()
    } else {
        None
    };
    if trusted_key_context(window.label(), &url, dev_url) {
        Ok(())
    } else {
        Err("Private key access denied".into())
    }
}

#[tauri::command]
async fn read_private_key(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    authorize_key_access(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || secure_storage::read(&app))
        .await
        .map_err(|_| "Secure storage operation failed".to_string())?
}
#[tauri::command]
async fn write_private_key(
    window: tauri::WebviewWindow,
    private_key_hex: String,
) -> Result<(), String> {
    authorize_key_access(&window)?;
    if private_key_hex.len() != 64 || !private_key_hex.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid private key".into());
    }
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || secure_storage::write(&app, &private_key_hex))
        .await
        .map_err(|_| "Secure storage operation failed".to_string())?
}
#[tauri::command]
async fn remove_private_key(window: tauri::WebviewWindow) -> Result<(), String> {
    authorize_key_access(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || secure_storage::remove(&app))
        .await
        .map_err(|_| "Secure storage operation failed".to_string())?
}
#[tauri::command]
async fn android_notification_command(
    window: tauri::WebviewWindow,
    method: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    authorize_key_access(&window)?;
    #[cfg(target_os = "android")]
    {
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn_blocking(move || {
            android_notifications::call(&app, &method, args)
        })
        .await
        .map_err(|_| "Android notification operation failed".to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (method, args);
        Err("Android notifications are unavailable on this platform".into())
    }
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(secure_storage::android_plugin())
        .plugin(android_notifications::plugin());
    builder
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(desktop)]
            let handle = app.handle().clone();
            let dev_origin = if cfg!(debug_assertions) {
                app.config().build.dev_url.clone()
            } else {
                None
            };
            let navigation_origin = dev_origin.clone();
            let capture_origin_trusted = Arc::new(AtomicBool::new(false));
            let navigation_capture_trusted = capture_origin_trusted.clone();
            let loaded_capture_trusted = capture_origin_trusted.clone();
            let builder =
                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                    .on_navigation(move |url| {
                        let allowed = trusted_app_url(url, navigation_origin.as_ref());
                        if allowed {
                            // A new document must finish loading before it can capture.
                            navigation_capture_trusted.store(false, Ordering::Relaxed);
                        }
                        allowed
                    })
                    .on_page_load(move |_, payload| {
                        loaded_capture_trusted.store(
                            matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                                && trusted_app_url(payload.url(), dev_origin.as_ref()),
                            Ordering::Relaxed,
                        );
                    })
                    .on_permission_request(move |_, kind| {
                        use tauri::webview::{PermissionKind, PermissionResponse};
                        // Android invokes this on its UI thread. Querying webview.url()
                        // here waits for that same thread and panics when the delayed
                        // reply reaches a dropped receiver. Track the loaded origin from
                        // navigation/page-load events instead; deny until a trusted
                        // document finishes loading. The navigation guard stays in force.
                        if !capture_origin_trusted.load(Ordering::Relaxed) {
                            return PermissionResponse::Deny;
                        }
                        // Capture is requested by the call's user-gesture controls. OS
                        // permission prompts and the system display picker still apply.
                        match kind {
                            PermissionKind::Microphone
                            | PermissionKind::Camera
                            | PermissionKind::DisplayCapture => PermissionResponse::Allow,
                            _ => PermissionResponse::Default,
                        }
                    });
            #[cfg(desktop)]
            let builder = builder.on_new_window(move |url, features| {
                // The presentation contains mirrored decoded frames only. Do not
                // allow arbitrary sites or additional privileged app windows.
                if url.as_str() != "about:blank" {
                    return tauri::webview::NewWindowResponse::Deny;
                }
                let label = format!(
                    "call-presentation-{}",
                    PRESENTATION_ID.fetch_add(1, Ordering::Relaxed)
                );
                let result = tauri::WebviewWindowBuilder::new(
                    &handle,
                    label,
                    tauri::WebviewUrl::External(url),
                )
                .window_features(features)
                .title("Anagram · Presentation")
                .on_navigation(|url| url.as_str() == "about:blank")
                .build();
                match result {
                    Ok(window) => tauri::webview::NewWindowResponse::Create { window },
                    Err(_) => tauri::webview::NewWindowResponse::Deny,
                }
            });
            builder.build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                for (label, presentation) in window.app_handle().webview_windows() {
                    if label.starts_with("call-presentation-") {
                        let _ = presentation.close();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_private_key,
            write_private_key,
            remove_private_key,
            android_notification_command
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Anagram");
}

#[cfg(test)]
mod security_tests {
    use super::{trusted_app_url, trusted_key_context};
    #[test]
    fn only_app_origins_are_trusted_in_release() {
        for url in [
            "tauri://localhost/chats",
            "http://tauri.localhost/chats",
            "https://tauri.localhost/",
        ] {
            assert!(trusted_app_url(&url.parse().unwrap(), None));
        }
        for url in [
            "https://evil.example/",
            "https://tauri.localhost.evil.example/",
            "https://tauri.localhost@evil.example/",
            "https://user@tauri.localhost/",
            "about:blank",
            "data:text/html,hello",
            "file:///tmp/index.html",
            "http://127.0.0.1:5173/",
        ] {
            assert!(!trusted_app_url(&url.parse().unwrap(), None));
        }
    }
    #[test]
    fn presentation_windows_have_no_keychain_access() {
        let app = "tauri://localhost/".parse().unwrap();
        assert!(trusted_key_context("main", &app, None));
        assert!(!trusted_key_context("call-presentation-0", &app, None));
        assert!(!trusted_key_context("other", &app, None));
        assert!(!trusted_key_context(
            "main",
            &"https://tauri.localhost:8443/".parse().unwrap(),
            None
        ));
    }
    #[test]
    fn development_origin_must_match_exactly() {
        let dev = "http://127.0.0.1:5173/".parse().unwrap();
        assert!(trusted_app_url(
            &"http://127.0.0.1:5173/chats".parse().unwrap(),
            Some(&dev)
        ));
        assert!(!trusted_app_url(
            &"http://127.0.0.1:5174/".parse().unwrap(),
            Some(&dev)
        ));
        assert!(!trusted_app_url(
            &"https://127.0.0.1:5173/".parse().unwrap(),
            Some(&dev)
        ));
    }
}
