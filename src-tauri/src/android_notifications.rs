use std::{collections::HashMap, sync::Mutex};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    plugin::{PluginHandle, TauriPlugin},
    Emitter, Manager, Wry,
};
struct NativeEvent {
    channel: Channel<serde_json::Value>,
    registered: bool,
}
struct AndroidNotifications {
    plugin: PluginHandle<Wry>,
    listeners: Mutex<HashMap<String, NativeEvent>>,
}
pub fn plugin() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::new("android-relay-notifications")
        .setup(|app, api| {
            app.manage(AndroidNotifications {
                plugin: api.register_android_plugin(
                    "com.nostr.anagram",
                    "AndroidRelayNotificationsPlugin",
                )?,
                listeners: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .build()
}
pub fn call(
    app: &tauri::AppHandle,
    method: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AndroidNotifications>();
    if method == "startListener" {
        let event = args.get("event").and_then(|v| v.as_str()).unwrap_or("");
        if !matches!(
            event,
            "notificationActionPerformed" | "pendingEventsAvailable"
        ) {
            return Err("Unknown notification event".into());
        }
        // Tauri's mobile channel registry retains channels. Allocate only these two
        // for the process; UI mounts use ordinary removable Tauri event listeners.
        let mut listeners = state
            .listeners
            .lock()
            .map_err(|_| "Notification listener unavailable")?;
        let listener = listeners.entry(event.to_owned()).or_insert_with(|| {
            let app = app.clone();
            let name = format!("android-relay-{event}");
            NativeEvent {
                channel: Channel::new(move |body| {
                    if let InvokeResponseBody::Json(json) = body {
                        app.emit_to(
                            "main",
                            &name,
                            serde_json::from_str::<serde_json::Value>(&json)?,
                        )?;
                    }
                    Ok(())
                }),
                registered: false,
            }
        });
        if !listener.registered {
            let _: serde_json::Value = state
                .plugin
                .run_mobile_plugin(
                    "registerListener",
                    serde_json::json!({"event": event, "handler": listener.channel}),
                )
                .map_err(|_| "Notification listener unavailable".to_string())?;
            listener.registered = true;
        }
        return Ok(serde_json::Value::Null);
    }
    if !matches!(
        method,
        "checkPermissions"
            | "requestPermissions"
            | "configure"
            | "stop"
            | "setStartOnBoot"
            | "getState"
            | "getPendingEvents"
            | "acknowledgePendingEvents"
            | "clearDeliveredNotifications"
            | "takeNotificationAction"
            | "getCallNotificationState"
            | "claimCallAnswer"
            | "syncCallState"
    ) {
        return Err("Unknown notification operation".into());
    }
    state
        .plugin
        .run_mobile_plugin(method, args)
        .map_err(|_| "Android notification operation failed".to_string())
}
