#[cfg(not(target_arch = "wasm32"))]
use futures_util::FutureExt;
use futures_util::lock::Mutex;
use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayMap, RelayUrl,
    endpoint::{
        Connection, ConnectionError, QuicTransportConfig, RecvStream, RelayMode, SendStream,
        presets,
    },
};
use n0_future::time::{Duration, timeout};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;
#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug)]
pub struct JsError(String);
#[cfg(not(target_arch = "wasm32"))]
impl JsError {
    fn new(message: &str) -> Self {
        Self(message.into())
    }
}
#[cfg(not(target_arch = "wasm32"))]
impl std::fmt::Display for JsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
#[cfg(not(target_arch = "wasm32"))]
impl std::error::Error for JsError {}

const ALPN: &[u8] = b"anagram/call/1";
const LANES_ALPN: &[u8] = b"anagram/call/2";
const MAX_FRAME: usize = 1_048_576;

fn js_error(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// An ephemeral identity. Never shared between calls or persisted.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct CallEndpoint {
    endpoint: Endpoint,
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
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
        for url in &urls {
            let parsed: RelayUrl = url.parse().map_err(js_error)?;
            let url = &*parsed;
            if url.scheme() != "https"
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(JsError::new("Invalid HTTPS relay URL"));
            }
        }
        let relays = urls
            .iter()
            .map(|url| url.parse::<RelayUrl>())
            .collect::<Result<Vec<_>, _>>()
            .map_err(js_error)?;
        // Nostr supplies authenticated addresses; never publish or resolve call IDs publicly.
        let builder = Endpoint::builder(presets::Minimal);
        // Browser WASM has no IP transports; native clients explicitly remove them.
        #[cfg(not(target_arch = "wasm32"))]
        let builder = builder.clear_ip_transports();
        #[cfg(all(not(target_arch = "wasm32"), not(target_os = "android")))]
        let builder = builder.ca_tls_config(iroh_relay::tls::CaTlsConfig::system());
        let endpoint = builder
            .transport_config(
                QuicTransportConfig::builder()
                    .datagram_send_buffer_size(2200)
                    .datagram_receive_buffer_size(Some(8800))
                    .build(),
            )
            .alpns(vec![ALPN.to_vec(), LANES_ALPN.to_vec()])
            .relay_mode(RelayMode::Custom(RelayMap::from_iter(relays)))
            .bind()
            .await
            .map_err(js_error)?;
        Ok(Self { endpoint })
    }

    pub fn audio_datagrams(&self) -> bool {
        true
    }
    pub async fn online(&self) -> Result<(), JsError> {
        timeout(Duration::from_secs(15), self.endpoint.online())
            .await
            .map_err(js_error)?;
        Ok(())
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
        self.connect_inner(peer_id, relay_url, call_id, false).await
    }
    pub async fn connect_lanes(
        &self,
        peer_id: String,
        relay_url: String,
        call_id: String,
    ) -> Result<CallConnection, JsError> {
        self.connect_inner(peer_id, relay_url, call_id, true).await
    }
    pub async fn accept(
        &self,
        peer_id: String,
        call_id: String,
    ) -> Result<CallConnection, JsError> {
        self.accept_inner(peer_id, call_id, false).await
    }
    pub async fn accept_lanes(
        &self,
        peer_id: String,
        call_id: String,
    ) -> Result<CallConnection, JsError> {
        self.accept_inner(peer_id, call_id, true).await
    }

    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

impl CallEndpoint {
    async fn connect_inner(
        &self,
        peer_id: String,
        relay_url: String,
        call_id: String,
        lanes: bool,
    ) -> Result<CallConnection, JsError> {
        validate_call_id(&call_id)?;
        let id: EndpointId = peer_id.parse().map_err(js_error)?;
        let addr = EndpointAddr::new(id).with_relay_url(relay_url.parse().map_err(js_error)?);
        let conn = self
            .endpoint
            .connect(addr, if lanes { LANES_ALPN } else { ALPN })
            .await
            .map_err(js_error)?;
        let result = timeout(Duration::from_secs(10), async {
            let mut sends = Vec::new();
            let mut recvs = Vec::new();
            for lane in 0..if lanes { 4 } else { 1 } {
                let (mut send, mut recv) = conn.open_bi().await.map_err(js_error)?;
                send.set_priority(4 - lane).map_err(js_error)?;
                send.write_all(call_id.as_bytes()).await.map_err(js_error)?;
                let mut confirmation = vec![0; call_id.len()];
                recv.read_exact(&mut confirmation).await.map_err(js_error)?;
                if confirmation != call_id.as_bytes() {
                    return Err(JsError::new("Call confirmation failed"));
                }
                sends.push(Mutex::new(send));
                recvs.push(Mutex::new(recv));
            }
            Ok((sends, recvs))
        })
        .await;
        match result {
            Ok(Ok((send, recv))) => Ok(CallConnection { conn, send, recv }),
            _ => {
                conn.close(1u8.into(), b"handshake failed");
                Err(JsError::new("Call handshake failed"))
            }
        }
    }
    async fn accept_inner(
        &self,
        peer_id: String,
        call_id: String,
        lanes: bool,
    ) -> Result<CallConnection, JsError> {
        validate_call_id(&call_id)?;
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
            if conn.remote_id() != expected || conn.alpn() != if lanes { LANES_ALPN } else { ALPN }
            {
                conn.close(1u8.into(), b"unexpected peer or protocol");
                continue;
            }
            let result = timeout(Duration::from_secs(10), async {
                let mut sends = Vec::new();
                let mut recvs = Vec::new();
                for lane in 0..if lanes { 4 } else { 1 } {
                    let (mut send, mut recv) = conn.accept_bi().await.map_err(js_error)?;
                    send.set_priority(4 - lane).map_err(js_error)?;
                    let mut confirmation = vec![0; call_id.len()];
                    recv.read_exact(&mut confirmation).await.map_err(js_error)?;
                    if confirmation != call_id.as_bytes() {
                        return Err(JsError::new("Wrong call"));
                    }
                    send.write_all(call_id.as_bytes()).await.map_err(js_error)?;
                    sends.push(Mutex::new(send));
                    recvs.push(Mutex::new(recv));
                }
                Ok((sends, recvs))
            })
            .await;
            if let Ok(Ok((send, recv))) = result {
                return Ok(CallConnection { conn, send, recv });
            }
            conn.close(1u8.into(), b"handshake failed");
        }
    }
}

fn validate_call_id(id: &str) -> Result<(), JsError> {
    if id.len() != 36
        || !id.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
    {
        return Err(JsError::new("Invalid call ID"));
    }
    Ok(())
}

fn frame_lane(kind: u8) -> usize {
    match kind {
        0 | 4 | 9 => 1,
        3 | 5 => 2,
        6 | 7 => 3,
        _ => 0,
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct CallConnection {
    conn: Connection,
    send: Vec<Mutex<SendStream>>,
    recv: Vec<Mutex<RecvStream>>,
}

#[cfg(not(target_arch = "wasm32"))]
impl CallConnection {
    // Amortize native WebView IPC latency without discarding ordinary bursts.
    // Datagram reads are cancellation-safe; stream reads must never use this.
    pub async fn recv_audio_batch(&self) -> Result<Vec<u8>, JsError> {
        let mut packets = std::collections::VecDeque::from([self.recv_audio().await?]);
        for _ in 1..4 {
            let Some(next) = self.conn.read_datagram().now_or_never() else {
                break;
            };
            let data = next.map_err(js_error)?;
            if data.len() > 14 && data.len() <= 1100 && data[0] == 9 && data[1] == 1 {
                packets.push_back(data.to_vec());
            }
        }
        let mut bytes = Vec::with_capacity(4408);
        for packet in packets {
            bytes.extend_from_slice(&(packet.len() as u16).to_be_bytes());
            bytes.extend_from_slice(&packet);
        }
        Ok(bytes)
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl CallConnection {
    pub fn stats_json(&self) -> String {
        let paths = self.conn.paths();
        let relay_only = paths.iter().all(|path| path.is_relay());
        let rtt = paths
            .iter()
            .find(|path| path.is_selected())
            .map(|path| path.rtt().as_millis())
            .unwrap_or(0);
        format!(
            r#"{{"relayOnly":{},"rttMs":{},"paths":{}}}"#,
            relay_only,
            rtt,
            paths.len()
        )
    }
    // Datagram buffers are bounded by Iroh; never enqueue stale speech behind
    // video retransmissions. Relay TCP stalls can still delay the underlying path.
    pub fn send_audio(&self, data: Vec<u8>) -> Result<(), JsError> {
        if data.len() <= 14 || data.len() > 1100 || data[0] != 9 || data[1] != 1 {
            return Err(JsError::new("Invalid audio packet"));
        }
        self.conn.send_datagram(data.into()).map_err(js_error)
    }
    pub async fn recv_audio(&self) -> Result<Vec<u8>, JsError> {
        loop {
            let data = self.conn.read_datagram().await.map_err(js_error)?;
            if data.len() > 14 && data.len() <= 1100 && data[0] == 9 && data[1] == 1 {
                return Ok(data.to_vec());
            }
        }
    }

    pub async fn send(&self, data: Vec<u8>) -> Result<(), JsError> {
        if data.is_empty() || data.len() > MAX_FRAME {
            return Err(JsError::new("Invalid call frame size"));
        }
        let lane = if self.send.len() == 1 {
            0
        } else {
            frame_lane(data[0])
        };
        let mut stream = self.send[lane].lock().await;
        stream
            .write_all(&(data.len() as u32).to_be_bytes())
            .await
            .map_err(js_error)?;
        stream.write_all(&data).await.map_err(js_error)?;
        Ok(())
    }
    pub async fn recv(&self) -> Result<Vec<u8>, JsError> {
        self.recv_lane(0).await
    }
    pub async fn recv_lane(&self, lane: usize) -> Result<Vec<u8>, JsError> {
        let mut stream = self
            .recv
            .get(lane)
            .ok_or_else(|| JsError::new("Invalid lane"))?
            .lock()
            .await;
        let mut header = [0; 4];
        stream.read_exact(&mut header).await.map_err(js_error)?;
        let size = u32::from_be_bytes(header) as usize;
        if size == 0 || size > MAX_FRAME {
            self.close(Some("failed".into()));
            return Err(JsError::new("Invalid call frame size"));
        }
        let mut data = vec![0; size];
        stream.read_exact(&mut data).await.map_err(js_error)?;
        if self.recv.len() > 1 && frame_lane(data[0]) != lane {
            self.conn.close(1u8.into(), b"wrong media lane");
            return Err(JsError::new("Wrong media lane"));
        }
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
