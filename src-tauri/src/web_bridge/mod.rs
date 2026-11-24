// Web bridge: an HTTP + WebSocket server inside the desktop app process that
// lets a normal browser run the real frontend against the real backend.
//
// The plugin backends (chat, VRM, STT, ...) are Rust dylibs loaded by this
// process, so the website has to be served from here. A browser page connects
// to `/__bridge/ws` and speaks the Tauri IPC contract (the polyfill in
// app/src/web/bridge.ts installs `window.__TAURI_INTERNALS__` before anything
// else loads); dispatch.rs routes every invoke to the same functions the
// webviews use.
//
// URLs: http://127.0.0.1:{port}/app (pet) and /app/settings (settings).
// Port: user-settable in Settings, persisted in {app_data}/web-bridge.json;
// default 1421, with COMPANION_WEB_PORT still overriding the setting.
// Env: COMPANION_WEB=0 disables, COMPANION_WEB_LAN=1 binds 0.0.0.0.
//
// Security: localhost binds are unauthenticated (same-machine callers already
// have full user access); LAN connections demand the access password on the
// WebSocket and the asset route — a user-settable password persisted in
// {app_data}/web-bridge.json, generated on first run, clearable to null for
// open access. Frontend files are public by design. Window-mutating commands
// are no-ops for web clients (dispatch.rs), so a browser can never disturb the
// desktop windows.

pub mod dispatch;
pub mod http_fetch;
pub mod shortcut;

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Listener, Manager};
use tokio::sync::mpsc;

/// Frames the server sends to a web client. `cb` mirrors the runtime's
/// runCallback(id, data): invoke responses, events and channel messages all
/// ride it (see bridge.ts / @tauri-apps/api core.js).
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerFrame {
    Resp {
        id: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Cb {
        id: u32,
        data: Value,
    },
}

/// Frames a web client sends: one per `invoke`.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    Invoke {
        id: u64,
        cmd: String,
        #[serde(default)]
        payload: Option<Value>,
        /// Raw request body (base64), used by `plugin_import_archive` —
        /// the desktop webview sends these bytes as the raw IPC body.
        #[serde(rename = "bodyB64", default)]
        body_b64: Option<String>,
    },
}

/// Shared across all web clients: app handle + plugin:http fetch registry.
pub struct ServerState {
    pub app: tauri::AppHandle,
    pub fetch: http_fetch::Registry,
}

/// Access password for the WebSocket + asset routes. `None` = open access
/// (no password). User-managed via the settings section and persisted in
/// `{app_data}/web-bridge.json`; read live, so changes apply to new
/// connections without a server restart.
static PASSWORD: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

fn current_password() -> Option<String> {
    PASSWORD.read().unwrap().clone()
}

/// One connected browser tab. Events/shortcuts registered by the client are
/// tracked per connection so a disconnect tears them down.
pub struct ConnCtx {
    tx: mpsc::UnboundedSender<ServerFrame>,
    /// Bridge event ids handed to `plugin:event|listen` (per connection).
    next_event_id: AtomicU32,
    listeners: Mutex<Vec<ListenerEntry>>,
    /// Shortcut strings this client registered (for cleanup on disconnect).
    shortcuts: Mutex<Vec<String>>,
}

struct ListenerEntry {
    tauri_id: u32,
    #[allow(dead_code)]
    event: String,
}

/// Configuration of a running bridge server (web_status / settings UI).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeConfig {
    /// COMPANION_WEB=0: hard-disabled for this app run, no toggle offered.
    pub env_disabled: bool,
    pub port: u16,
    pub lan: bool,
}

/// The live server instance (or its disabled marker) — replaced wholesale by
/// `set_lan`'s restart, read by `status`.
struct BridgeHandle {
    config: BridgeConfig,
    /// Dropping the serve future via this signal frees the port + connections.
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

static BRIDGE: std::sync::Mutex<Option<BridgeHandle>> = std::sync::Mutex::new(None);

const DEFAULT_PORT: u16 = 1421;
const PASSWORD_FILE: &str = "web-bridge.json";

/// Heartbeat: the writer pings every PING_SECS and the reader closes a
/// connection that has been silent longer than STALE_MILLIS after having
/// seen at least one frame. Without it a half-open socket (laptop sleep,
/// Wi-Fi change) is never noticed — pending invokes hang until an OS-level
/// failure, and the user sees actions "land" seconds later after the
/// client's reconnect backoff.
const PING_SECS: u64 = 5;
const STALE_MILLIS: i64 = 15_000;

/// User-set port from the settings file (None = default). Read live by
/// `effective_port`, so a `set_port` save is visible even mid-restart.
static USER_PORT: std::sync::RwLock<Option<u16>> = std::sync::RwLock::new(None);

pub fn start(app: tauri::AppHandle) {
    load_or_init_config(&app);
    let config = planned_config();
    if config.env_disabled {
        *BRIDGE.lock().unwrap() = Some(BridgeHandle { config, shutdown: None });
        return;
    }
    match spawn_bridge(app, config) {
        Ok(handle) => *BRIDGE.lock().unwrap() = Some(handle),
        Err(e) => eprintln!("[web] bridge failed to start: {e}"),
    }
}

/// The persisted settings: access password + user-set port. Absent fields
/// fall back to their defaults (generated password on first run, 1421).
#[derive(Serialize, Deserialize, Default)]
struct BridgeSettingsFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
}

/// Parse the settings file body into (password, user-set port).
fn parse_settings(text: &str) -> (Option<String>, Option<u16>) {
    match serde_json::from_str::<BridgeSettingsFile>(text) {
        Ok(file) => (file.password, file.port.filter(|p| (1..=65535).contains(p))),
        Err(_) => (None, None),
    }
}

/// Load the persisted settings; on the very first run, generate a password
/// and persist it (secure default — the user can clear it in Settings for
/// open access, which then persists as an explicit null).
fn load_or_init_config(app: &tauri::AppHandle) {
    let mut password = PASSWORD.write().unwrap();
    let mut port = USER_PORT.write().unwrap();
    if password.is_some() {
        return;
    }
    let dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("[web] app data dir unavailable, settings not persisted: {e}");
            return;
        }
    };
    if let Ok(text) = std::fs::read_to_string(&dir.join(PASSWORD_FILE)) {
        let (loaded_password, loaded_port) = parse_settings(&text);
        *password = loaded_password;
        *port = loaded_port;
        return;
    }
    let generated = gen_password();
    *password = Some(generated.clone());
    if let Err(e) = persist_config_to(&dir, Some(&generated), None) {
        eprintln!("[web] password persist failed: {e}");
    }
}

fn persist_config_to(dir: &std::path::Path, password: Option<&str>, port: Option<u16>) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = BridgeSettingsFile {
        password: password.map(str::to_string),
        port,
    };
    let body = serde_json::to_string(&file).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(PASSWORD_FILE), body).map_err(|e| e.to_string())
}

fn config_from_env() -> BridgeConfig {
    let env_disabled = std::env::var("COMPANION_WEB").is_ok_and(|v| v == "0");
    let lan = std::env::var("COMPANION_WEB_LAN").is_ok_and(|v| v == "1");
    let port = std::env::var("COMPANION_WEB_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    BridgeConfig { env_disabled, lan, port }
}

/// COMPANION_WEB_PORT explicitly overrides the port (the Settings field is
/// then locked and shown as such).
fn port_locked() -> bool {
    std::env::var("COMPANION_WEB_PORT")
        .ok()
        .is_some_and(|v| v.parse::<u16>().is_ok())
}

/// The port a new bridge server would bind: env override > user setting >
/// default.
fn effective_port() -> u16 {
    std::env::var("COMPANION_WEB_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .or(*USER_PORT.read().unwrap())
        .unwrap_or(DEFAULT_PORT)
}

/// The config a new bridge server would run with (start + restarts).
fn planned_config() -> BridgeConfig {
    BridgeConfig { port: effective_port(), ..config_from_env() }
}

/// Launch a bridge server on its own runtime and return its handle. Blocks
/// briefly on the bind: during a live restart the old server's port frees a
/// moment after the shutdown signal, so the bind retries. Called from async
/// contexts (restart dispatches) — the retry loop may block a worker up to
/// a few seconds worst-case, which is fine for a deliberate toggle.
fn spawn_bridge(app: tauri::AppHandle, config: BridgeConfig) -> Result<BridgeHandle, String> {
    let addr = std::net::SocketAddr::new(
        if config.lan {
            std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED)
        } else {
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
        },
        config.port,
    );
    let mut std_listener = None;
    for _ in 0..60 {
        match std::net::TcpListener::bind(addr) {
            Ok(l) => {
                std_listener = Some(l);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(format!("bind {addr} failed: {e}")),
        }
    }
    let std_listener =
        std_listener.ok_or_else(|| format!("could not bind {addr} (port stayed busy)"))?;
    std_listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    println!("[web] web app available at {}", display_url(&config));
    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                eprintln!("[web] bridge runtime failed: {e}");
                return;
            }
        };
        if let Err(e) = runtime.block_on(serve(app, std_listener, shutdown_rx)) {
            eprintln!("[web] bridge server failed: {e}");
        }
    });
    Ok(BridgeHandle { config, shutdown: Some(shutdown_tx) })
}

async fn serve(
    app: tauri::AppHandle,
    std_listener: std::net::TcpListener,
    shutdown_rx: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), Box<dyn std::error::Error>> {
    // from_std registers the fd with the reactor — must run inside this
    // thread's runtime context (spawn_bridge may be called from plain setup
    // code where no runtime exists).
    let listener = tokio::net::TcpListener::from_std(std_listener)?;
    let state = Arc::new(ServerState {
        app,
        fetch: http_fetch::Registry::new(),
    });

    let router = Router::new()
        .route("/", get(index_page))
        .route("/app", get(index_page))
        .route("/settings", get(settings_page))
        .route("/app/settings", get(settings_page))
        .route("/assets/{*path}", get(dist_asset))
        .route("/__bridge/asset", get(bridge_asset))
        .route("/__bridge/auth", get(auth_check))
        .route("/__bridge/ws", get(ws_upgrade))
        .fallback(fallback_asset)
        .with_state(state.clone());

    // Dropping the serve future on the shutdown signal frees the port and
    // kills open connections (a graceful drain would hang forever on
    // long-lived WebSockets); web clients reconnect on their own.
    tokio::select! {
        result = axum::serve(listener, router) => { result?; }
        _ = async { let _ = shutdown_rx.await; } => {}
    }
    Ok(())
}

fn display_url(config: &BridgeConfig) -> String {
    let host = if config.lan {
        lan_ips().first().cloned().unwrap_or_else(|| "0.0.0.0".into())
    } else {
        "127.0.0.1".into()
    };
    let mut url = format!("http://{host}:{}/app", config.port);
    if let Some(password) = current_password() {
        url.push_str(&format!("?password={password}"));
    }
    url
}

/// All non-loopback IPv4 interface addresses (the LAN URL candidates — a
/// machine with a VPN shows both its LAN and tunnel IPs; the user picks the
/// one their other device can reach). Empty on probe failure.
fn lan_ips() -> Vec<String> {
    let mut ips: Vec<String> = if_addrs::get_if_addrs()
        .map(|ifaces| {
            ifaces
                .into_iter()
                .filter_map(|i| match i.addr {
                    if_addrs::IfAddr::V4(a) => Some(a.ip.to_string()),
                    _ => None,
                })
                .filter(|ip| !ip.starts_with("127."))
                .collect()
        })
        .unwrap_or_default();
    ips.sort();
    ips.dedup();
    if ips.is_empty() {
        // Fall back to the default-route probe.
        if let Some(ip) = lan_ip_via_route() {
            ips.push(ip);
        }
    }
    ips
}

/// Primary non-loopback interface IP (std-only UDP route probe — no packet
/// leaves the machine).
fn lan_ip_via_route() -> Option<String> {
    use std::net::UdpSocket;
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_loopback() { None } else { Some(ip.to_string()) }
}

/// Current bridge state for the settings UI and the bridge dispatch.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WebStatus {
    pub enabled: bool,
    pub env_disabled: bool,
    pub lan: bool,
    pub port: u16,
    /// COMPANION_WEB_PORT is overriding the port (Settings field locked).
    pub port_locked: bool,
    /// Access password; None = open access (no password required).
    pub password: Option<String>,
    pub lan_ips: Vec<String>,
}

pub fn status() -> WebStatus {
    let guard = BRIDGE.lock().unwrap();
    match guard.as_ref() {
        Some(handle) => WebStatus {
            enabled: true,
            env_disabled: handle.config.env_disabled,
            lan: handle.config.lan,
            port: handle.config.port,
            port_locked: port_locked(),
            password: current_password(),
            lan_ips: lan_ips(),
        },
        None => WebStatus {
            // Mid-restart window: report the configured state, not defaults.
            enabled: false,
            env_disabled: false,
            lan: false,
            port: effective_port(),
            port_locked: port_locked(),
            password: current_password(),
            lan_ips: lan_ips(),
        },
    }
}

/// Replace the running bridge server with one running `change(config)`.
/// Shared by the LAN toggle and the port setting: the replacement binds
/// first (its bind loop waits out the old listener), the old one is then
/// signalled down from a detached thread — that ordering lets the toggle's
/// response flush over the old socket before it dies. Open browser
/// connections drop and the frontend polyfill reconnects automatically.
fn restart_bridge(
    app: tauri::AppHandle,
    change: impl FnOnce(&mut BridgeConfig),
) -> Result<WebStatus, String> {
    let old = {
        let mut guard = BRIDGE.lock().unwrap();
        match guard.take() {
            Some(handle) => {
                if handle.config.env_disabled {
                    *guard = Some(handle);
                    return Err("web app is disabled by COMPANION_WEB=0".into());
                }
                handle
            }
            None => return Err("bridge is restarting — try again in a moment".into()),
        }
    };
    let mut config = old.config.clone();
    change(&mut config);
    if config == old.config {
        // No-op (same value already running): keep the server up.
        *BRIDGE.lock().unwrap() = Some(old);
        return Ok(status());
    }
    match spawn_bridge(app, config) {
        Ok(handle) => *BRIDGE.lock().unwrap() = Some(handle),
        // Bind failure (busy/privileged port): the old server keeps running —
        // its shutdown signal is still alive, and the handle is restored.
        Err(e) => {
            *BRIDGE.lock().unwrap() = Some(old);
            return Err(e);
        }
    }
    std::thread::spawn(move || {
        // Small delay so the setting's response frame flushes first.
        std::thread::sleep(std::time::Duration::from_millis(300));
        if let Some(tx) = old.shutdown {
            let _ = tx.send(());
        }
    });
    Ok(status())
}

/// Toggle LAN mode with a live server restart.
pub fn set_lan(app: tauri::AppHandle, enabled: bool) -> Result<WebStatus, String> {
    restart_bridge(app, |config| config.lan = enabled)
}

/// Set the port (requires 1..=65535) with a live server restart, and persist
/// it. COMPANION_WEB_PORT set? Then it stays locked and this refuses.
pub fn set_port(app: tauri::AppHandle, port: u16) -> Result<WebStatus, String> {
    if port == 0 {
        return Err("port must be between 1 and 65535".into());
    }
    if port_locked() {
        return Err("port is overridden by the COMPANION_WEB_PORT env var".into());
    }
    let previous = *USER_PORT.read().unwrap();
    *USER_PORT.write().unwrap() = Some(port);
    let result = restart_bridge(app.clone(), |config| config.port = port);
    if result.is_err() {
        // Restart failed: roll the setting back so it matches the live server.
        *USER_PORT.write().unwrap() = previous;
    } else if let Ok(dir) = app.path().app_data_dir() {
        if let Err(e) = persist_config_to(&dir, current_password().as_deref(), Some(port)) {
            eprintln!("[web] port persist failed: {e}");
        }
    }
    result
}

#[tauri::command(rename_all = "snake_case")]
pub fn web_status() -> WebStatus {
    status()
}

#[tauri::command(rename_all = "snake_case")]
pub async fn web_set_lan(app: tauri::AppHandle, enabled: bool) -> Result<WebStatus, String> {
    tauri::async_runtime::spawn_blocking(move || set_lan(app, enabled))
        .await
        .map_err(|e| format!("web toggle failed: {e}"))?
}

/// Frontend files: served through tauri's asset resolver, which reads
/// `frontendDist` from disk in dev and the embedded assets in release builds.
/// `file` must be an asset key without a leading slash.
fn resolve_dist(st: &ServerState, file: &str) -> Option<tauri::Asset> {
    st.app.asset_resolver().get(file.to_string())
}

fn missing_dist_response() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "frontend dist not found — run `pnpm build` in app/ (or use the vite dev server at :1420 with ?web=1)",
    )
        .into_response()
}

fn asset_response(asset: tauri::Asset) -> Response {
    (
        [
            (header::CONTENT_TYPE, asset.mime_type().to_string()),
            (header::CACHE_CONTROL, "no-cache".to_string()),
        ],
        asset.bytes,
    )
        .into_response()
}

async fn index_page(State(st): State<Arc<ServerState>>) -> Response {
    serve_html(&st, "index.html")
}

async fn settings_page(State(st): State<Arc<ServerState>>) -> Response {
    serve_html(&st, "settings.html")
}

fn serve_html(st: &ServerState, file: &str) -> Response {
    let Some(asset) = resolve_dist(st, file) else {
        return missing_dist_response();
    };
    let html = String::from_utf8_lossy(&asset.bytes).into_owned();
    let html = inject_web_flag(&html);
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8".to_string()),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        html,
    )
        .into_response()
}

/// Inject the web-mode flag before any module script runs: the polyfill needs
/// a synchronous signal that this page is the web variant (otherwise a plain
/// vite/plain-serve run keeps its degraded no-backend behavior). Deliberately
/// does NOT carry the password — anyone who can load a page could read it;
/// the polyfill gates on /__bridge/auth and asks the user instead.
fn inject_web_flag(html: &str) -> String {
    let script = "<script>window.__COMPANION_WEB__=true;</script>".to_string();
    match html.find("<head>") {
        Some(idx) => {
            let after = idx + "<head>".len();
            let mut out = String::with_capacity(html.len() + script.len());
            out.push_str(&html[..after]);
            out.push_str(&script);
            out.push_str(&html[after..]);
            out
        }
        None => format!("{script}{html}"),
    }
}

async fn dist_asset(
    State(st): State<Arc<ServerState>>,
    axum::extract::Path(path): axum::extract::Path<String>,
) -> Response {
    // The wildcard captures what follows /assets/; the asset key includes it.
    serve_dist_path(&st, &format!("assets/{path}"))
}

async fn fallback_asset(State(st): State<Arc<ServerState>>, req: axum::http::Request<axum::body::Body>) -> Response {
    let path = req.uri().path().trim_start_matches('/').to_string();
    if path.is_empty() || path.starts_with("__bridge") {
        return StatusCode::NOT_FOUND.into_response();
    }
    serve_dist_path(&st, &path)
}

/// Serve a frontendDist file through the asset resolver. Rejects `..` segments
/// (the resolver's dev fallback joins the path onto the dist directory).
fn serve_dist_path(st: &ServerState, path: &str) -> Response {
    if path.split(['/', '\\']).any(|seg| seg == "..") {
        return StatusCode::NOT_FOUND.into_response();
    }
    match resolve_dist(st, path) {
        Some(asset) => asset_response(asset),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Deserialize)]
struct AssetQuery {
    path: String,
    password: Option<String>,
}

/// Plugin files (L2D model assets etc.) for the browser's `convertFileSrc` —
/// the same scope the Tauri asset protocol allows: $APPDATA/plugins/** and
/// $APPDATA/plugins-data/**.
async fn bridge_asset(
    State(st): State<Arc<ServerState>>,
    Query(q): Query<AssetQuery>,
) -> Response {
    if !authorized(q.password.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let app_data = match st.app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let roots = [
        app_data.join("plugins"),
        app_data.join("plugins-data"),
    ];
    let Ok(path) = std::fs::canonicalize(&q.path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !roots.iter().any(|root| path.starts_with(root)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mime = mime_for_path(&path);
            (
                [
                    (header::CONTENT_TYPE, mime),
                    (header::CACHE_CONTROL, "no-cache".to_string()),
                ],
                bytes,
            )
                .into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// WS/asset access check against the live password: None = open access.
fn authorized(provided: Option<&str>) -> bool {
    match current_password() {
        None => true,
        Some(password) => provided.is_some_and(|p| p == password),
    }
}

fn mime_for_path(path: &std::path::Path) -> String {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase) {
        Some(ext) => match ext.as_str() {
            "html" => "text/html".into(),
            "js" | "mjs" => "text/javascript".into(),
            "css" => "text/css".into(),
            "json" => "application/json".into(),
            "png" => "image/png".into(),
            "jpg" | "jpeg" => "image/jpeg".into(),
            "webp" => "image/webp".into(),
            "gif" => "image/gif".into(),
            "svg" => "image/svg+xml".into(),
            "ico" => "image/x-icon".into(),
            "mp3" => "audio/mpeg".into(),
            "wav" => "audio/wav".into(),
            "ogg" => "audio/ogg".into(),
            "mp4" => "video/mp4".into(),
            "webm" => "video/webm".into(),
            "wasm" => "application/wasm".into(),
            "vrm" | "vrma" | "gltf" | "glb" | "model3.json" => "application/octet-stream".into(),
            "motion3.json" | "physics3.json" => "application/json".into(),
            _ => "application/octet-stream".into(),
        },
        None => "application/octet-stream".into(),
    }
}

async fn ws_upgrade(
    State(st): State<Arc<ServerState>>,
    Query(q): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    if !authorized(q.get("password").map(String::as_str)) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| session(socket, st))
}

/// Password probe for the polyfill's gate: 200 = accepted (or open access),
/// 401 = wrong/missing password. Public by design — it leaks nothing but
/// accept/reject.
async fn auth_check(Query(q): Query<HashMap<String, String>>) -> Response {
    if authorized(q.get("password").map(String::as_str)) {
        StatusCode::OK.into_response()
    } else {
        StatusCode::UNAUTHORIZED.into_response()
    }
}

/// One browser tab: a writer draining `tx` into the socket (pinging on an
/// interval), a reader turning invoke frames into spawned dispatch tasks
/// (watching for staleness so half-open sockets get closed), and
/// per-connection registries.
async fn session(socket: WebSocket, st: Arc<ServerState>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerFrame>();
    let conn = Arc::new(ConnCtx {
        tx: tx.clone(),
        next_event_id: AtomicU32::new(1),
        listeners: Mutex::new(Vec::new()),
        shortcuts: Mutex::new(Vec::new()),
    });
    let (mut sink, mut stream) = socket.split();
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(std::time::Duration::from_secs(PING_SECS));
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                frame = rx.recv() => {
                    let Some(frame) = frame else { break };
                    let Ok(text) = serde_json::to_string(&frame) else { continue };
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                _ = ping.tick() => {
                    // Browsers answer at the protocol level (background tabs
                    // are not throttled for this); the pong refreshes the
                    // reader's liveness stamp.
                    if sink.send(Message::Ping(Bytes::new())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    let started = std::time::Instant::now();
    let last_seen = Arc::new(AtomicI64::new(0));
    let mut watchdog = tokio::time::interval(std::time::Duration::from_secs(PING_SECS));
    watchdog.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            msg = stream.next() => {
                let Some(msg) = msg else { break };
                last_seen.store(started.elapsed().as_millis() as i64, Ordering::Relaxed);
                let text = match msg {
                    Ok(Message::Text(text)) => text,
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(_) => continue,
                };
                let Ok(ClientFrame::Invoke { id, cmd, payload, body_b64 }) = serde_json::from_str::<ClientFrame>(&text)
                else {
                    let _ = tx.send(ServerFrame::Resp {
                        id: 0,
                        ok: false,
                        value: None,
                        error: Some("unrecognized bridge frame".into()),
                    });
                    continue;
                };
                let st = st.clone();
                let conn = conn.clone();
                tokio::spawn(async move {
                    let result = dispatch::invoke(&st, &conn, &cmd, payload, body_b64).await;
                    let frame = match result {
                        Ok(value) => ServerFrame::Resp { id, ok: true, value: Some(value), error: None },
                        Err(error) => ServerFrame::Resp { id, ok: false, value: None, error: Some(error) },
                    };
                    let _ = conn.tx.send(frame);
                });
            }
            _ = watchdog.tick() => {
                let last = last_seen.load(Ordering::Relaxed);
                let now = started.elapsed().as_millis() as i64;
                if last > 0 && now - last > STALE_MILLIS {
                    // Nothing (not even pongs) for the stale window: the
                    // socket is half-open. Dropping both halves closes it —
                    // the client's onclose rejects pending invokes and
                    // reconnects.
                    break;
                }
            }
        }
    }

    conn.cleanup(&st);
    writer.abort();
}

impl ConnCtx {
    /// Drop every resource this connection registered on the desktop app.
    fn cleanup(self: &Arc<Self>, st: &ServerState) {
        for entry in self.listeners.lock().unwrap().drain(..) {
            st.app.unlisten(entry.tauri_id);
        }
        for shortcut in self.shortcuts.lock().unwrap().drain(..) {
            if let Err(e) = shortcut::unregister_shortcut(&st.app, &shortcut) {
                eprintln!("[web] shortcut cleanup failed: {e}");
            }
        }
    }
}

/// The callback registry a polyfill-side `transformCallback` produces; parses
/// the `__CHANNEL__:<id>` string that @tauri-apps/api Channel serialization
/// uses (the stt plugin's global-shortcut handler rides exactly that).
pub fn parse_channel_id(handler: &str) -> Option<u32> {
    handler
        .strip_prefix("__CHANNEL__:")
        .and_then(|rest| rest.parse().ok())
}

/// 24 chars from a 62-char alphabet: ~142 bits of entropy. Used for the
/// generated default password (the user can replace or clear it).
fn gen_password() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..24)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

/// Set the access password (None / empty = open access) and persist it.
/// Applies to new WS/asset connections immediately — no server restart.
#[tauri::command(rename_all = "snake_case")]
pub fn web_set_password(
    app: tauri::AppHandle,
    password: Option<String>,
) -> Result<WebStatus, String> {
    let password = password.filter(|p| !p.trim().is_empty());
    *PASSWORD.write().unwrap() = password.clone();
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir unavailable: {e}"))?;
    persist_config_to(&dir, password.as_deref(), *USER_PORT.read().unwrap())?;
    Ok(status())
}

/// Set the web port from the Settings UI: persists it and restarts the
/// server on the new port (open browser connections must reopen the new
/// URL — only the desktop webview survives the restart).
#[tauri::command(rename_all = "snake_case")]
pub async fn web_set_port(app: tauri::AppHandle, port: u16) -> Result<WebStatus, String> {
    tauri::async_runtime::spawn_blocking(move || set_port(app, port))
        .await
        .map_err(|e| format!("web port change failed: {e}"))?
}

// ---------------------------------------------------------------------------
// Manual (non-macro) tests for pure helpers.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inject_web_flag_inserts_after_head() {
        let html = "<html><head><meta charset=\"utf-8\"></head><body></body></html>";
        *PASSWORD.write().unwrap() = Some("secret".into());
        let out = inject_web_flag(html);
        // The password must NOT appear in served HTML.
        assert!(out.starts_with("<html><head><script>window.__COMPANION_WEB__=true;</script><meta"));
        assert!(!out.contains("secret"));
        *PASSWORD.write().unwrap() = None;
    }

    #[test]
    fn inject_web_flag_falls_back_to_prepend() {
        *PASSWORD.write().unwrap() = None;
        let out = inject_web_flag("<html></html>");
        assert!(out.starts_with("<script>window.__COMPANION_WEB__=true;</script>"));
    }

    #[test]
    fn parse_channel_id_works() {
        assert_eq!(parse_channel_id("__CHANNEL__:42"), Some(42));
        assert_eq!(parse_channel_id("__CHANNEL__:"), None);
        assert_eq!(parse_channel_id("callback"), None);
    }

    #[test]
    fn parse_settings_reads_password_and_port() {
        let (password, port) = parse_settings(r#"{"password":"abc","port":8080}"#);
        assert_eq!(password.as_deref(), Some("abc"));
        assert_eq!(port, Some(8080));
    }

    #[test]
    fn parse_settings_tolerates_legacy_file_and_bad_ports() {
        // Pre-port-setting file: only the password.
        let (password, port) = parse_settings(r#"{"password":null}"#);
        assert_eq!(password, None);
        assert_eq!(port, None);
        // Out-of-range ports never come out of the file.
        assert_eq!(parse_settings(r#"{"port":0}"#).1, None);
        assert_eq!(parse_settings(r#"{"port":70000}"#).1, None);
        // Garbage parses as empty settings, not an error.
        assert_eq!(parse_settings("not json"), (None, None));
    }
}
