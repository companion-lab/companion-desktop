// plugin:http|fetch re-implementation for web clients.
//
// Plugin bundles cannot import @tauri-apps/plugin-http; they carry a vendored
// port (plugin-repos/*/src/fetch.ts) whose protocol mirrors the real plugin:
//
//   1. fetch {clientConfig}                 -> rid        (request created)
//   2. fetch_send {rid}                     -> {status, statusText, url,
//                                              headers, rid: bodyRid}     (sent)
//   3. fetch_read_body {bodyRid}            -> number[]   (chunk ++ [0];
//                                              stream end = [1])
//   4. fetch_cancel {rid} / fetch_cancel_body {rid}        (abort)
//
// The trailing byte in read_body is the stream sentinel: chunks always end
// with 0, and a [1] read means "end, no data" (the JS drops the payload of a
// [1] read, so the two forms must never be mixed). Implemented on reqwest's
// async client with real streaming so chat SSE responses arrive incrementally
// exactly like they do on the desktop.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};

type BodyStream = std::pin::Pin<
    Box<dyn futures_util::Stream<Item = reqwest::Result<Bytes>> + Send>,
>;

pub struct Registry {
    next: AtomicU64,
    entries: Mutex<HashMap<u64, Entry>>,
}

enum Entry {
    Request(reqwest::RequestBuilder),
    Body(BodyEntry),
}

struct BodyEntry {
    stream: Arc<tokio::sync::Mutex<BodyState>>,
}

struct BodyState {
    stream: BodyStream,
    done: bool,
}

impl Registry {
    pub fn new() -> Self {
        Self {
            next: AtomicU64::new(1),
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// `plugin:http|fetch`: build the request, store it, return the rid.
    pub fn create_request(&self, config: FetchConfig) -> Result<u64, String> {
        let method: reqwest::Method = config
            .method
            .parse()
            .map_err(|e| format!("invalid method {:?}: {e}", config.method))?;
        let mut builder = client().request(method, config.url.as_str());
        for (name, value) in config.headers.iter().flatten() {
            builder = builder.header(name, value);
        }
        if let Some(data) = &config.data {
            builder = builder.body(data.clone());
        }
        if let Some(ms) = config.connect_timeout {
            builder = builder.timeout(Duration::from_millis(ms));
        }
        // maxRedirections/proxy/danger: reqwest follows redirects by default
        // (up to 10) and none of the plugins rely on the exotic knobs.
        let rid = self.next.fetch_add(1, Ordering::SeqCst);
        self.entries
            .lock()
            .unwrap()
            .insert(rid, Entry::Request(builder));
        Ok(rid)
    }

    /// `plugin:http|fetch_send`: actually send; register the body stream
    /// under a NEW rid (the JS destructures it as `rid: responseRid`).
    pub async fn send(&self, rid: u64) -> Result<Value, String> {
        let builder = match self.entries.lock().unwrap().remove(&rid) {
            Some(Entry::Request(builder)) => builder,
            Some(Entry::Body(_)) => return Err(format!("request {rid} already sent")),
            None => return Err(format!("invalid request id {rid} (cancelled?)")),
        };
        let response = builder.send().await.map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        // HTTP/2 has no reason phrase; the JS Response accepts "".
        let url = response.url().to_string();
        let headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();
        let body_rid = self.next.fetch_add(1, Ordering::SeqCst);
        self.entries.lock().unwrap().insert(
            body_rid,
            Entry::Body(BodyEntry {
                stream: Arc::new(tokio::sync::Mutex::new(BodyState {
                    stream: Box::pin(response.bytes_stream()),
                    done: false,
                })),
            }),
        );
        Ok(json!({
            "status": status,
            "statusText": "",
            "url": url,
            "headers": headers,
            "rid": body_rid,
        }))
    }

    /// `plugin:http|fetch_read_body`: one chunk per call, sentinel-coded.
    pub async fn read_body(&self, rid: u64) -> Result<Vec<u8>, String> {
        let entry = {
            let entries = self.entries.lock().unwrap();
            match entries.get(&rid) {
                Some(Entry::Body(entry)) => entry.stream.clone(),
                Some(Entry::Request(_)) => return Err(format!("request {rid} not sent yet")),
                None => return Err(format!("invalid body id {rid} (cancelled?)")),
            }
        };
        let mut state = entry.lock().await;
        if state.done {
            // Repeat reads after the end sentinel: report end again.
            return Ok(vec![1]);
        }
        match state.stream.next().await {
            Some(Ok(bytes)) => {
                let mut out = bytes.to_vec();
                out.push(0);
                Ok(out)
            }
            Some(Err(e)) => {
                state.done = true;
                self.entries.lock().unwrap().remove(&rid);
                Err(e.to_string())
            }
            None => {
                state.done = true;
                self.entries.lock().unwrap().remove(&rid);
                Ok(vec![1])
            }
        }
    }

    /// `plugin:http|fetch_cancel`: abort a request before/instead of sending.
    pub fn cancel(&self, rid: u64) {
        self.entries.lock().unwrap().remove(&rid);
    }

    /// `plugin:http|fetch_cancel_body`: drop a body stream mid-flight.
    pub fn cancel_body(&self, rid: u64) {
        // Removing the entry is enough: future reads fail with "invalid
        // body id"; an in-flight read just delivers its chunk, which the
        // errored JS stream ignores.
        self.entries.lock().unwrap().remove(&rid);
    }
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// clientConfig body, exactly as vendored fetch.ts serializes it.
#[derive(Deserialize)]
pub struct FetchConfig {
    method: String,
    url: String,
    #[serde(default)]
    headers: Option<Vec<(String, String)>>,
    /// Request body as a JSON number array (processIpcMessage encodes
    /// ArrayBuffer this way); null for bodyless requests.
    #[serde(default)]
    data: Option<Vec<u8>>,
    #[serde(default, rename = "maxRedirections")]
    _max_redirections: Option<u32>,
    /// Milliseconds (plugin-http JS convention).
    #[serde(default, rename = "connectTimeout")]
    connect_timeout: Option<u64>,
    #[serde(default)]
    _proxy: Option<Value>,
    #[serde(default)]
    _danger: Option<Value>,
}
