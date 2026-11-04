//! Native and browser calls use the same relay-only transport implementation.
//! Handles are confined to the trusted main WebView and never persisted.
use anagram_iroh_calls::{CallConnection, CallEndpoint};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    State, WebviewWindow,
};

#[derive(Default)]
struct Handles {
    session: String,
    endpoints: HashMap<u64, Arc<CallEndpoint>>,
    connections: HashMap<u64, (u64, Arc<CallConnection>)>,
}
#[derive(Default)]
pub struct Calls {
    pub trusted_origin: Arc<AtomicBool>,
    handles: Mutex<Handles>,
    next: AtomicU64,
}
impl Calls {
    fn authorized(&self, label: &str) -> bool {
        label == "main" && self.trusted_origin.load(Ordering::Relaxed)
    }
    pub fn close_all(&self) {
        if let Ok(mut handles) = self.handles.lock() {
            close_handles(&mut handles);
        }
    }
}
fn close_handles(handles: &mut Handles) {
    for (_, (_, connection)) in handles.connections.drain() {
        connection.close(Some("cancelled".into()));
    }
    for (_, endpoint) in handles.endpoints.drain() {
        tauri::async_runtime::spawn(async move {
            endpoint.close().await;
        });
    }
}
fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| s.len() <= 1024)
        .ok_or_else(|| format!("Invalid {key}"))
}
fn number(args: &Value, key: &str) -> Result<u64, String> {
    args.get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("Invalid {key}"))
}
fn response(value: Value) -> Response {
    Response::new(value.to_string())
}

fn call_frame(body: &InvokeBody, audio: bool) -> Result<Vec<u8>, String> {
    let limit = if audio { 1100 } else { 1_048_576 };
    let size = match body {
        InvokeBody::Raw(bytes) => bytes.len(),
        // Android's postMessage IPC serializes typed arrays as JSON arrays.
        InvokeBody::Json(Value::Array(bytes)) => bytes.len(),
        _ => return Err("Expected call frame bytes".into()),
    };
    if size == 0 || size > limit {
        return Err("Invalid call frame size".into());
    }
    match body {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(Value::Array(bytes)) => bytes
            .iter()
            .map(|byte| {
                byte.as_u64()
                    .and_then(|n| u8::try_from(n).ok())
                    .ok_or_else(|| "Invalid call frame byte".into())
            })
            .collect(),
        _ => unreachable!(),
    }
}

#[tauri::command]
pub async fn iroh_call_send(
    window: WebviewWindow,
    state: State<'_, Calls>,
    request: Request<'_>,
) -> Result<(), String> {
    if !state.authorized(window.label()) {
        return Err("Call transport access denied".into());
    }
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .ok_or("Invalid call headers")
    };
    let session = header("x-call-session")?;
    let id: u64 = header("x-call-connection")?
        .parse()
        .map_err(|_| "Invalid connection")?;
    let audio = match header("x-call-audio")? {
        "0" => false,
        "1" => true,
        _ => return Err("Invalid audio flag".into()),
    };
    let connection = {
        let handles = state.handles.lock().map_err(|_| "Call state unavailable")?;
        if session.len() != 36 || handles.session != session {
            return Err("Expired call client session".into());
        }
        handles
            .connections
            .get(&id)
            .map(|(_, c)| c.clone())
            .ok_or("Unknown call connection")?
    };
    let data = call_frame(request.body(), audio)?;
    if audio {
        connection
            .send_audio(data)
            .map_err(|e| e.to_string())
    } else {
        connection
            .send(data)
            .await
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn iroh_call(
    window: WebviewWindow,
    state: State<'_, Calls>,
    operation: String,
    session: String,
    args: Value,
) -> Result<Response, String> {
    // Navigation/page-load events maintain the same origin guard as call capture.
    // Reading window.url() here adds a UI-thread round trip to every media packet.
    // Tauri's local main-window capability also checks each invocation's origin.
    if !state.authorized(window.label()) {
        return Err("Call transport access denied".into());
    }
    if session.len() != 36 {
        return Err("Invalid call client session".into());
    }
    {
        let mut handles = state.handles.lock().map_err(|_| "Call state unavailable")?;
        if handles.session != session {
            if operation != "create" {
                return Err("Expired call client session".into());
            }
            close_handles(&mut handles);
            handles.session = session.clone();
        }
    }
    if operation == "create" {
        {
            let handles = state.handles.lock().map_err(|_| "Call state unavailable")?;
            if handles.endpoints.len() >= 32 {
                return Err("Too many call endpoints".into());
            }
        }
        let relays: Vec<String> =
            serde_json::from_value(args["relays"].clone()).map_err(|_| "Invalid relays")?;
        let endpoint = Arc::new(
            CallEndpoint::create_with_relays(relays)
                .await
                .map_err(|e| e.to_string())?,
        );
        let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
        let mut handles = state.handles.lock().map_err(|_| "Call state unavailable")?;
        if handles.session != session || handles.endpoints.len() >= 32 {
            tauri::async_runtime::spawn(async move {
                endpoint.close().await;
            });
            return Err("Expired or full call client session".into());
        }
        handles.endpoints.insert(id, endpoint.clone());
        return Ok(response(json!({ "handle": id, "id": endpoint.id() })));
    }
    if matches!(
        operation.as_str(),
        "online" | "connect" | "accept" | "closeEndpoint"
    ) {
        let id = number(&args, "endpoint")?;
        let endpoint = {
            let handles = state.handles.lock().map_err(|_| "Call state unavailable")?;
            handles
                .endpoints
                .get(&id)
                .cloned()
                .ok_or("Unknown call endpoint")?
        };
        match operation.as_str() {
            "online" => {
                endpoint.online().await.map_err(|e| e.to_string())?;
                return Ok(response(
                    json!({ "relay": endpoint.relay_url().map_err(|e| e.to_string())? }),
                ));
            }
            "closeEndpoint" => {
                {
                    let mut handles = state.handles.lock().map_err(|_| "Call state unavailable")?;
                    handles.endpoints.remove(&id);
                    handles.connections.retain(|_, (owner, connection)| {
                        if *owner == id {
                            connection.close(Some("cancelled".into()));
                            false
                        } else {
                            true
                        }
                    });
                }
                endpoint.close().await;
                return Ok(response(Value::Null));
            }
            _ => {}
        }
        let peer = text(&args, "peer")?.to_owned();
        let call = text(&args, "call")?.to_owned();
        let lanes = args["lanes"].as_bool().unwrap_or(false);
        let connection = if operation == "connect" {
            let relay = text(&args, "relay")?.to_owned();
            if lanes {
                endpoint.connect_lanes(peer, relay, call).await
            } else {
                endpoint.connect(peer, relay, call).await
            }
        } else if lanes {
            endpoint.accept_lanes(peer, call).await
        } else {
            endpoint.accept(peer, call).await
        }
        .map_err(|e| e.to_string())?;
        let connection_id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
        let mut handles = state.handles.lock().map_err(|_| "Call state unavailable")?;
        if handles.session != session
            || !handles.endpoints.contains_key(&id)
            || handles.connections.len() >= 32
        {
            connection.close(Some("cancelled".into()));
            return Err("Expired or full call endpoint".into());
        }
        handles
            .connections
            .insert(connection_id, (id, Arc::new(connection)));
        return Ok(response(json!({ "handle": connection_id })));
    }
    let id = number(&args, "connection")?;
    let connection = {
        let handles = state.handles.lock().map_err(|_| "Call state unavailable")?;
        handles
            .connections
            .get(&id)
            .map(|(_, c)| c.clone())
            .ok_or("Unknown call connection")?
    };
    match operation.as_str() {
        "recv" => {
            return connection
                .recv_lane(number(&args, "lane")? as usize)
                .await
                .map(Response::new)
                .map_err(|e| e.to_string())
        }
        "recvAudio" => {
            return connection
                .recv_audio_batch()
                .await
                .map(Response::new)
                .map_err(|e| e.to_string())
        }
        "stats" => return Ok(Response::new(connection.stats_json())),
        "reason" => return Ok(response(json!(connection.end_reason()))),
        "close" => {
            connection.close(Some(text(&args, "reason")?.to_owned()));
            state
                .handles
                .lock()
                .map_err(|_| "Call state unavailable")?
                .connections
                .remove(&id);
        }
        _ => return Err("Invalid call operation".into()),
    }
    Ok(response(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_frames_accept_both_ipc_encodings_with_the_same_limits() {
        for audio in [false, true] {
            let limit = if audio { 1100 } else { 1_048_576 };
            for size in [0, 1, limit, limit + 1] {
                let bytes = vec![255u8; size];
                for body in [InvokeBody::Raw(bytes.clone()), InvokeBody::Json(json!(bytes))] {
                    let result = call_frame(&body, audio);
                    if size > 0 && size <= limit {
                        assert_eq!(result.unwrap(), bytes);
                    } else {
                        assert!(result.is_err());
                    }
                }
            }
        }
        for invalid in [
            json!([256]), json!([-1]), json!([1.5]), json!([null]),
            json!(["1"]), json!([true]), json!([[1]]), json!({"0": 1}), json!(null),
        ] {
            assert!(call_frame(&InvokeBody::Json(invalid), false).is_err());
        }
    }

    #[test]
    fn transport_requires_a_loaded_trusted_main_window() {
        let calls = Calls::default();
        assert!(!calls.authorized("main"));
        calls.trusted_origin.store(true, Ordering::Relaxed);
        assert!(calls.authorized("main"));
        assert!(!calls.authorized("call-presentation-1"));
        assert!(!calls.authorized("other"));
        calls.trusted_origin.store(false, Ordering::Relaxed);
        assert!(!calls.authorized("main"));
    }
}
