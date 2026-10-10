use futures_util::lock::Mutex;
use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayMap, RelayUrl,
    endpoint::{Connection, ConnectionError, RecvStream, RelayMode, SendStream, presets},
};
use n0_future::time::{Duration, timeout};
use wasm_bindgen::prelude::*;

const ALPN: &[u8] = b"anagram/call/1";
const MAX_FRAME: usize = 1_048_576;

fn js_error(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// An ephemeral identity. Never shared between calls or persisted.
#[wasm_bindgen]
pub struct CallEndpoint {
    endpoint: Endpoint,
}

#[wasm_bindgen]
impl CallEndpoint {
    pub async fn create(relay_url: Option<String>) -> Result<CallEndpoint, JsError> {
        let urls = match relay_url {
            Some(url) => vec![url],
            None => vec![
                "https://iroh.nostr.com/".into(),
                "https://use1-1.relay.n0.iroh.link/".into(),
                "https://usw1-1.relay.n0.iroh.link/".into(),
                "https://euc1-1.relay.n0.iroh.link/".into(),
                "https://aps1-1.relay.n0.iroh.link/".into(),
            ],
        };
        Self::create_with_relays(urls).await
    }

    pub async fn create_with_relays(urls: Vec<String>) -> Result<CallEndpoint, JsError> {
        if urls.is_empty() || urls.len() > 21 {
            return Err(JsError::new("Configure between 1 and 21 Iroh relays"));
        }
        let relays = urls
            .iter()
            .map(|url| url.parse::<RelayUrl>())
            .collect::<Result<Vec<_>, _>>()
            .map_err(js_error)?;
        // Nostr supplies authenticated addresses; never publish or resolve call IDs publicly.
        let endpoint = Endpoint::builder(presets::Minimal)
            .alpns(vec![ALPN.to_vec()])
            .relay_mode(RelayMode::Custom(RelayMap::from_iter(relays)))
            .bind()
            .await
            .map_err(js_error)?;
        Ok(Self { endpoint })
    }

    pub async fn online(&self) {
        self.endpoint.online().await;
    }
    pub fn id(&self) -> String {
        self.endpoint.id().to_string()
    }
    pub fn relay_url(&self) -> Result<String, JsError> {
        self.endpoint
            .addr()
            .relay_urls()
            .next()
            .map(ToString::to_string)
            .ok_or_else(|| JsError::new("Iroh relay is unavailable"))
    }

    pub async fn connect(
        &self,
        peer_id: String,
        relay_url: String,
        call_id: String,
    ) -> Result<CallConnection, JsError> {
        let id: EndpointId = peer_id.parse().map_err(js_error)?;
        let addr = EndpointAddr::new(id).with_relay_url(relay_url.parse().map_err(js_error)?);
        let conn = self.endpoint.connect(addr, ALPN).await.map_err(js_error)?;
        let (mut send, mut recv) = conn.open_bi().await.map_err(js_error)?;
        send.write_all(call_id.as_bytes()).await.map_err(js_error)?;
        let mut confirmation = vec![0; call_id.len()];
        recv.read_exact(&mut confirmation).await.map_err(js_error)?;
        if confirmation != call_id.as_bytes() {
            conn.close(1u8.into(), b"wrong call");
            return Err(JsError::new("Call confirmation failed"));
        }
        Ok(CallConnection {
            conn,
            send: Mutex::new(send),
            recv: Mutex::new(recv),
        })
    }

    pub async fn accept(
        &self,
        peer_id: String,
        call_id: String,
    ) -> Result<CallConnection, JsError> {
        let expected: EndpointId = peer_id.parse().map_err(js_error)?;
        loop {
            let incoming = self
                .endpoint
                .accept()
                .await
                .ok_or_else(|| JsError::new("Endpoint closed"))?;
            let Ok(Ok(conn)) = timeout(Duration::from_secs(5), incoming).await else {
                continue;
            };
            if conn.remote_id() != expected {
                conn.close(1u8.into(), b"unexpected peer");
                continue;
            }
            let Ok(Ok((mut send, mut recv))) =
                timeout(Duration::from_secs(5), conn.accept_bi()).await
            else {
                conn.close(1u8.into(), b"handshake timeout");
                continue;
            };
            let mut confirmation = vec![0; call_id.len()];
            if !matches!(
                timeout(Duration::from_secs(5), recv.read_exact(&mut confirmation)).await,
                Ok(Ok(()))
            ) {
                conn.close(1u8.into(), b"handshake timeout");
                continue;
            }
            if confirmation != call_id.as_bytes() {
                conn.close(1u8.into(), b"wrong call");
                continue;
            }
            send.write_all(call_id.as_bytes()).await.map_err(js_error)?;
            return Ok(CallConnection {
                conn,
                send: Mutex::new(send),
                recv: Mutex::new(recv),
            });
        }
    }

    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

#[wasm_bindgen]
pub struct CallConnection {
    conn: Connection,
    send: Mutex<SendStream>,
    recv: Mutex<RecvStream>,
}

#[wasm_bindgen]
impl CallConnection {
    pub async fn send(&self, data: Vec<u8>) -> Result<(), JsError> {
        if data.is_empty() || data.len() > MAX_FRAME {
            return Err(JsError::new("Invalid call frame size"));
        }
        let mut stream = self.send.lock().await;
        stream
            .write_all(&(data.len() as u32).to_be_bytes())
            .await
            .map_err(js_error)?;
        stream.write_all(&data).await.map_err(js_error)?;
        Ok(())
    }
    pub async fn recv(&self) -> Result<Vec<u8>, JsError> {
        let mut stream = self.recv.lock().await;
        let mut header = [0; 4];
        stream.read_exact(&mut header).await.map_err(js_error)?;
        let size = u32::from_be_bytes(header) as usize;
        if size == 0 || size > MAX_FRAME {
            self.close(Some("failed".into()));
            return Err(JsError::new("Invalid call frame size"));
        }
        let mut data = vec![0; size];
        stream.read_exact(&mut data).await.map_err(js_error)?;
        Ok(data)
    }
    pub fn close(&self, reason: Option<String>) {
        let reason = reason.unwrap_or_else(|| "hangup".into());
        self.conn.close(0u8.into(), reason.as_bytes());
    }
    pub fn end_reason(&self) -> Option<String> {
        match self.conn.close_reason() {
            Some(ConnectionError::ApplicationClosed(error)) if error.error_code == 0u8.into() => {
                String::from_utf8(error.reason.to_vec()).ok()
            }
            _ => None,
        }
    }
}
