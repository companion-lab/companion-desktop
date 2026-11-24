// Bridge invoke dispatch: routes every browser `invoke` to the same functions
// the desktop webviews reach through Tauri's command system.
//
// `#[tauri::command]` keeps the original fn callable, so the app's own
// commands are called directly with `app.state::<PluginHostState>()` /
// `AppHandle` — the browser gets byte-identical behavior. Tauri plugin
// commands (`plugin:event|*`, `plugin:http|*`, `plugin:global-shortcut|*`,
// `plugin:app|*`, `plugin:window|*`) are re-implemented here against public
// APIs: the event system via `listen_any`, HTTP via reqwest, shortcuts via
// GlobalShortcutExt.
//
// Web clients use a virtual window label ("web"): window mutations are no-ops
// so a browser tab can never move, resize or click-through-mute the real
// desktop windows; reads resolve against the real windows with safe defaults
// for the virtual label.

use base64::Engine as _;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Emitter, Listener, Manager};

use super::http_fetch::FetchConfig;
use super::shortcut;
use super::{ConnCtx, ServerState};

pub async fn invoke(
    st: &ServerState,
    conn: &ConnCtx,
    cmd: &str,
    payload: Option<Value>,
    body_b64: Option<String>,
) -> Result<Value, String> {
    match cmd {
        // --- plugin host commands -------------------------------------------
        "plugin_list" => {
            let state = st.app.state::<crate::plugin_host::PluginHostState>();
            Ok(json!(crate::plugin_host::commands::plugin_list(state)))
        }
        "plugin_call" => {
            let a: PluginCallArgs = args(payload, cmd)?;
            let state = st.app.state::<crate::plugin_host::PluginHostState>();
            let v = crate::plugin_host::commands::plugin_call(
                state,
                a.plugin_id,
                a.method,
                a.payload,
            )
            .await?;
            serde_json::to_value(v).map_err(|e| e.to_string())
        }
        "plugin_list_tools" => {
            let state = st.app.state::<crate::plugin_host::PluginHostState>();
            let v = crate::plugin_host::commands::plugin_list_tools(state).await?;
            serde_json::to_value(v).map_err(|e| e.to_string())
        }
        "plugin_set_enabled" => {
            let a: PluginIdEnabledArgs = args(payload, cmd)?;
            let state = st.app.state::<crate::plugin_host::PluginHostState>();
            let v =
                crate::plugin_host::commands::plugin_set_enabled(state, a.plugin_id, a.enabled)
                    .await?;
            serde_json::to_value(v).map_err(|e| e.to_string())
        }
        "plugin_read_frontend" => {
            let a: PluginIdArgs = args(payload, cmd)?;
            let state = st.app.state::<crate::plugin_host::PluginHostState>();
            let b64 = crate::plugin_host::commands::plugin_read_frontend(state, a.plugin_id).await?;
            Ok(json!(b64))
        }
        "plugin_import_archive" => {
            // The desktop command takes the raw IPC body; the browser sends
            // the same bytes base64 in the bridge frame.
            let bytes = body_b64
                .as_deref()
                .map(|b| base64::engine::general_purpose::STANDARD.decode(b))
                .transpose()
                .map_err(|e| format!("invalid bodyB64: {e}"))?
                .ok_or_else(|| "expected a raw byte payload (bodyB64)".to_string())?;
            let state = st.app.state::<crate::plugin_host::PluginHostState>();
            crate::plugin_host::commands::spawn_import(state.inner().clone(), bytes);
            Ok(Value::Null)
        }
        "plugin_delete" => {
            let a: PluginIdArgs = args(payload, cmd)?;
            let state = st.app.state::<crate::plugin_host::PluginHostState>();
            let v = crate::plugin_host::commands::plugin_delete(state, a.plugin_id).await?;
            serde_json::to_value(v).map_err(|e| e.to_string())
        }
        "plugin_restore_bundled" => {
            let state = st.app.state::<crate::plugin_host::PluginHostState>();
            crate::plugin_host::commands::plugin_restore_bundled(state)?;
            Ok(Value::Null)
        }
        "plugin_storage_get" => {
            let a: StorageKeyArgs = args(payload, cmd)?;
            let state = st.app.state::<crate::plugin_host::PluginHostState>().inner().clone();
            // Disk I/O (read + JSON parse) must not occupy a bridge worker —
            // these ride the same runtime as the per-connection writer task.
            blocking(move || {
                Ok(state.storage_get(&a.plugin_id, &a.key).unwrap_or(Value::Null))
            })
            .await
        }
        "plugin_storage_set" => {
            let a: StorageKeyValueArgs = args(payload, cmd)?;
            let state = st.app.state::<crate::plugin_host::PluginHostState>().inner().clone();
            blocking(move || {
                state.storage_set(&a.plugin_id, &a.key, &a.value.unwrap_or(Value::Null))?;
                Ok(Value::Null)
            })
            .await
        }
        "plugin_check_updates" => {
            let state = st.app.state::<crate::plugin_host::PluginHostState>();
            let v = crate::plugin_host::update::plugin_check_updates(state).await?;
            serde_json::to_value(v).map_err(|e| e.to_string())
        }
        "plugin_update" => {
            let a: PluginUpdateArgs = args(payload, cmd)?;
            let state = st.app.state::<crate::plugin_host::PluginHostState>();
            crate::plugin_host::update::plugin_update(state, a.plugin_id, a.latest_version)?;
            Ok(Value::Null)
        }

        // --- updater / shell --------------------------------------------------
        "check_for_update" => {
            let v = crate::updater::check_for_update(st.app.clone()).await?;
            serde_json::to_value(v).map_err(|e| e.to_string())
        }
        "download_update" => {
            let a: DownloadUpdateArgs = args(payload, cmd)?;
            crate::updater::download_update(st.app.clone(), a.download_url, a.tag_name)?;
            Ok(Value::Null)
        }
        "open_update_installer" => {
            let a: SingleStringArgs = args(payload, cmd)?;
            crate::updater::open_update_installer(st.app.clone(), a.value)?;
            Ok(Value::Null)
        }
        "open_url" => {
            let a: SingleStringArgs = args(payload, cmd)?;
            crate::updater::open_url(st.app.clone(), a.value)?;
            Ok(Value::Null)
        }
        "open_settings" => {
            crate::open_settings(st.app.clone())?;
            Ok(Value::Null)
        }
        "restart_app" => {
            crate::restart_app(st.app.clone());
            Ok(Value::Null)
        }
        "quit_app" => {
            crate::quit_app(st.app.clone());
            Ok(Value::Null)
        }
        "open_devtools" => {
            let win = st
                .app
                .get_webview_window("main")
                .ok_or_else(|| "no main window".to_string())?;
            crate::open_devtools(win)?;
            Ok(Value::Null)
        }
        "secret_set" => {
            let a: SecretArgs = args(payload, cmd)?;
            blocking(move || {
                crate::secret_set(a.value.unwrap_or_default(), a.name)?;
                Ok(Value::Null)
            })
            .await
        }
        "secret_get" => {
            let a: SecretArgs = args(payload, cmd)?;
            blocking(move || {
                let v = crate::secret_get(a.name)?;
                serde_json::to_value(v).map_err(|e| e.to_string())
            })
            .await
        }
        "secret_delete" => {
            let a: SecretArgs = args(payload, cmd)?;
            blocking(move || {
                crate::secret_delete(a.name)?;
                Ok(Value::Null)
            })
            .await
        }
        "window_set_follow_spaces" => {
            // The web page's startup effect would apply ITS OWN localStorage
            // prefs to the real window — window behavior stays desktop-local
            // (the desktop settings window toggles it for real).
            let _ = args::<JoinArg>(payload, cmd)?;
            Ok(Value::Null)
        }
        "cursor_window_local" => {
            let v = crate::cursor_window_local(st.app.clone());
            serde_json::to_value(v).map_err(|e| e.to_string())
        }
        "cursor_global" => {
            let v = crate::cursor_global(st.app.clone());
            serde_json::to_value(v).map_err(|e| e.to_string())
        }
        "windowing_backend" => Ok(json!(crate::click_through::windowing_backend())),
        "web_status" => {
            serde_json::to_value(crate::web_bridge::status()).map_err(|e| e.to_string())
        }
        "web_set_enabled" => {
            let a: EnabledArg = args(payload, cmd)?;
            let app = st.app.clone();
            let v = tauri::async_runtime::spawn_blocking(move || {
                crate::web_bridge::set_enabled(app, a.enabled)
            })
            .await
            .map_err(|e| format!("web toggle failed: {e}"))??;
            serde_json::to_value(v).map_err(|e| e.to_string())
        }
        "web_set_lan" => {
            let a: EnabledArg = args(payload, cmd)?;
            let app = st.app.clone();
            let v = tauri::async_runtime::spawn_blocking(move || {
                crate::web_bridge::set_lan(app, a.enabled)
            })
            .await
            .map_err(|e| format!("web toggle failed: {e}"))??;
            serde_json::to_value(v).map_err(|e| e.to_string())
        }
        "web_set_password" => {
            let a: PasswordArg = args(payload, cmd)?;
            let v = crate::web_bridge::web_set_password(st.app.clone(), a.password)?;
            serde_json::to_value(v).map_err(|e| e.to_string())
        }
        "web_set_port" => {
            let a: PortArg = args(payload, cmd)?;
            let app = st.app.clone();
            let v = tauri::async_runtime::spawn_blocking(move || {
                crate::web_bridge::set_port(app, a.port)
            })
            .await
            .map_err(|e| format!("web port change failed: {e}"))??;
            serde_json::to_value(v).map_err(|e| e.to_string())
        }
        "set_click_through_exclusions" => {
            // Desktop-only: mutating the real window's input region from a
            // browser tab (whose mouse position is not the pet window's)
            // would be wrong, so the bridge declines this one instead of
            // calling it.
            let _ = (payload, body_b64);
            Ok(Value::Null)
        }

        // --- tauri core plugin: events ----------------------------------------
        "plugin:event|listen" => event_listen(st, conn, payload, cmd).await,
        "plugin:event|unlisten" => event_unlisten(st, conn, payload, cmd),
        "plugin:event|emit" => {
            let a: EmitArgs = args(payload, cmd)?;
            st.app.emit(&a.event, a.payload).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "plugin:event|emit_to" => {
            let a: EmitToArgs = args(payload, cmd)?;
            st.app
                .emit_to(a.target, &a.event, a.payload)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }

        // --- tauri plugin: http -------------------------------------------------
        "plugin:http|fetch" => {
            let a: FetchArgs = args(payload, cmd)?;
            let rid = st.fetch.create_request(a.client_config)?;
            Ok(json!(rid))
        }
        "plugin:http|fetch_send" => {
            let a: RidArgs = args(payload, cmd)?;
            st.fetch.send(a.rid).await
        }
        "plugin:http|fetch_read_body" => {
            let a: RidArgs = args(payload, cmd)?;
            let bytes = st.fetch.read_body(a.rid).await?;
            Ok(Value::Array(bytes.into_iter().map(|b| json!(b)).collect()))
        }
        "plugin:http|fetch_cancel" => {
            let a: RidArgs = args(payload, cmd)?;
            st.fetch.cancel(a.rid);
            Ok(Value::Null)
        }
        "plugin:http|fetch_cancel_body" => {
            let a: RidArgs = args(payload, cmd)?;
            st.fetch.cancel_body(a.rid);
            Ok(Value::Null)
        }

        // --- tauri plugin: global shortcut ----------------------------------------
        "plugin:global-shortcut|register" => shortcut::register(st, conn, payload).await,
        "plugin:global-shortcut|unregister" => shortcut::unregister(st, conn, payload).await,

        // --- tauri plugin: app ------------------------------------------------------
        "plugin:app|version" => Ok(json!(st.app.package_info().version.to_string())),
        "plugin:app|name" => Ok(json!(
            st.app
                .config()
                .product_name
                .clone()
                .unwrap_or_else(|| st.app.package_info().name.clone())
        )),
        "plugin:app|identifier" => Ok(json!(st.app.config().identifier.clone())),

        // --- tauri plugin: window -----------------------------------------------------
        "plugin:window|get_all_windows" => {
            let mut labels: Vec<String> = st.app.webview_windows().keys().cloned().collect();
            labels.sort();
            Ok(json!(labels))
        }
        cmd if cmd.starts_with("plugin:window|") => window_read(st, payload, cmd).await,

        // Unknown commands fail loudly (desktop webviews would fail too).
        _ => Err(format!("web bridge: unsupported command {cmd}")),
    }
}

/// Window reads for a browser client. The label picks a real window ("main"
/// or "settings"); the virtual "web" label and unknown labels get safe
/// defaults (or Null where the real command would also return Option).
async fn window_read(st: &ServerState, payload: Option<Value>, cmd: &str) -> Result<Value, String> {
    let suffix = cmd
        .strip_prefix("plugin:window|")
        .unwrap_or(cmd)
        .to_string();
    let a: WindowLabelArgs = args(payload, cmd)?;
    let win = st.app.get_webview_window(&a.label);

    match suffix.as_str() {
        "scale_factor" => Ok(json!(win.as_ref().and_then(|w| w.scale_factor().ok()).unwrap_or(1.0))),
        "inner_position" => Ok(position_value(win.as_ref().and_then(|w| w.inner_position().ok()))),
        "outer_position" => Ok(position_value(win.as_ref().and_then(|w| w.outer_position().ok()))),
        "inner_size" => Ok(size_value(win.as_ref().and_then(|w| w.inner_size().ok()))),
        "outer_size" => Ok(size_value(win.as_ref().and_then(|w| w.outer_size().ok()))),
        "title" => match &win {
            Some(w) => Ok(json!(w.title().map_err(|e| e.to_string())?)),
            None => Ok(json!("")),
        },
        "theme" => match &win {
            Some(w) => Ok(json!(w.theme().map_err(|e| e.to_string())?)),
            None => Ok(Value::Null),
        },
        "is_fullscreen" => Ok(json!(bool_read(win.as_ref(), |w| w.is_fullscreen()))),
        "is_minimized" => Ok(json!(bool_read(win.as_ref(), |w| w.is_minimized()))),
        "is_maximized" => Ok(json!(bool_read(win.as_ref(), |w| w.is_maximized()))),
        "is_focused" => Ok(json!(bool_read(win.as_ref(), |w| w.is_focused()))),
        "is_decorated" => Ok(json!(bool_read(win.as_ref(), |w| w.is_decorated()))),
        "is_resizable" => Ok(json!(bool_read(win.as_ref(), |w| w.is_resizable()))),
        "is_maximizable" => Ok(json!(bool_read(win.as_ref(), |w| w.is_maximizable()))),
        "is_minimizable" => Ok(json!(bool_read(win.as_ref(), |w| w.is_minimizable()))),
        "is_closable" => Ok(json!(bool_read(win.as_ref(), |w| w.is_closable()))),
        "is_visible" => Ok(json!(bool_read(win.as_ref(), |w| w.is_visible()))),
        "is_enabled" => Ok(json!(bool_read(win.as_ref(), |w| w.is_enabled()))),
        "is_always_on_top" => Ok(json!(bool_read(win.as_ref(), |w| w.is_always_on_top()))),
        "current_monitor" => {
            let monitor = win.as_ref().and_then(|w| w.current_monitor().ok()).flatten();
            Ok(monitor.map(monitor_json).unwrap_or(Value::Null))
        }
        "primary_monitor" => {
            let monitor = st.app.primary_monitor().map_err(|e| e.to_string())?;
            Ok(monitor.map(monitor_json).unwrap_or(Value::Null))
        }
        "available_monitors" => {
            let monitors = st.app.available_monitors().map_err(|e| e.to_string())?;
            Ok(json!(monitors.into_iter().map(monitor_json).collect::<Vec<_>>()))
        }
        "cursor_position" => Err("web bridge: cursor_position is desktop-only".into()),
        // Everything else is a mutation (set_*, start_dragging, show, ...)
        // or an unused getter: no-op so web clients never disturb the real
        // desktop windows.
        _ => Ok(Value::Null),
    }
}

fn bool_read(win: Option<&tauri::WebviewWindow>, f: impl Fn(&tauri::WebviewWindow) -> tauri::Result<bool>) -> bool {
    win.and_then(|w| f(w).ok()).unwrap_or(false)
}

fn position_value(p: Option<tauri::PhysicalPosition<i32>>) -> Value {
    match p {
        Some(p) => json!({ "x": p.x, "y": p.y }),
        None => json!({ "x": 0, "y": 0 }),
    }
}

fn size_value(s: Option<tauri::PhysicalSize<u32>>) -> Value {
    match s {
        Some(s) => json!({ "width": s.width, "height": s.height }),
        None => json!({ "width": 0, "height": 0 }),
    }
}

fn monitor_json(m: tauri::Monitor) -> Value {
    let position = m.position();
    let size = m.size();
    let work = m.work_area();
    json!({
        "name": m.name().cloned(),
        "scaleFactor": m.scale_factor(),
        "position": { "x": position.x, "y": position.y },
        "size": { "width": size.width, "height": size.height },
        "workArea": {
            "position": { "x": work.position.x, "y": work.position.y },
            "size": { "width": work.size.width, "height": work.size.height },
        },
    })
}

async fn event_listen(
    st: &ServerState,
    conn: &ConnCtx,
    payload: Option<Value>,
    cmd: &str,
) -> Result<Value, String> {
    let a: EventListenArgs = args(payload, cmd)?;
    // Window-targeted listeners for the virtual web window would never fire
    // (the page's own tauri://move / tauri://resize subscriptions): hand back
    // a dummy id without registering anything on the app.
    if event_target_is_virtual(st, a.target.as_ref()) {
        let id = conn.next_event_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        return Ok(json!(id));
    }
    let bridge_id = conn.next_event_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let event_name = a.event.clone();
    let handler_cb = a.handler;
    let tx = conn.tx.clone();
    let tauri_id = st
        .app
        .listen_any(event_name.clone(), move |e| {
            let payload: Value = serde_json::from_str(e.payload()).unwrap_or(Value::Null);
            let data = json!({ "event": event_name, "id": bridge_id, "payload": payload });
            let _ = tx.send(super::ServerFrame::Cb { id: handler_cb, data });
        });
    conn.listeners.lock().unwrap().push(super::ListenerEntry {
        tauri_id,
        event: a.event,
    });
    Ok(json!(bridge_id))
}

fn event_unlisten(
    st: &ServerState,
    conn: &ConnCtx,
    payload: Option<Value>,
    cmd: &str,
) -> Result<Value, String> {
    let a: EventUnlistenArgs = args(payload, cmd)?;
    let mut listeners = conn.listeners.lock().unwrap();
    if let Some(pos) = listeners.iter().position(|l| l.tauri_id == a.event_id) {
        listeners.remove(pos);
        st.app.unlisten(a.event_id);
    }
    Ok(Value::Null)
}

/// True when a listener targets the virtual web window (a label no real
/// window has), so deliveries could never match anyway.
fn event_target_is_virtual(st: &ServerState, target: Option<&Value>) -> bool {
    let Some(target) = target else { return false };
    let kind = target.get("kind").and_then(Value::as_str);
    let label = target.get("label").and_then(Value::as_str);
    matches!(kind, Some("Window") | Some("Webview") | Some("WebviewWindow"))
        && label.is_some_and(|l| st.app.get_webview_window(l).is_none())
}

/// Run a blocking body (keyring reads/writes) off the async workers.
async fn blocking<F>(f: F) -> Result<Value, String>
where
    F: FnOnce() -> Result<Value, String> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("bridge task failed: {e}"))?
}

fn args<T: DeserializeOwned>(payload: Option<Value>, cmd: &str) -> Result<T, String> {
    serde_json::from_value(payload.unwrap_or(Value::Null))
        .map_err(|e| format!("invalid args for {cmd}: {e}"))
}

// --- arg shapes (snake_case keys, as the JS side sends them) ------------------

#[derive(Deserialize)]
struct PluginCallArgs {
    plugin_id: String,
    method: String,
    #[serde(default)]
    payload: Option<Value>,
}

#[derive(Deserialize)]
struct PluginIdArgs {
    plugin_id: String,
}

#[derive(Deserialize)]
struct PluginIdEnabledArgs {
    plugin_id: String,
    enabled: bool,
}

#[derive(Deserialize)]
struct StorageKeyArgs {
    plugin_id: String,
    key: String,
}

#[derive(Deserialize)]
struct StorageKeyValueArgs {
    plugin_id: String,
    key: String,
    #[serde(default)]
    value: Option<Value>,
}

#[derive(Deserialize)]
struct PluginUpdateArgs {
    plugin_id: String,
    latest_version: String,
}

#[derive(Deserialize)]
struct DownloadUpdateArgs {
    download_url: String,
    tag_name: String,
}

/// Single-string commands (open_update_installer's path, open_url's url).
#[derive(Deserialize)]
struct SingleStringArgs {
    #[serde(alias = "path", alias = "url")]
    value: String,
}

#[derive(Deserialize)]
struct SecretArgs {
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
#[allow(dead_code)] // parsed to validate the args shape; the value is ignored
struct JoinArg {
    join: bool,
}

#[derive(Deserialize)]
struct EventListenArgs {
    event: String,
    #[serde(default)]
    target: Option<Value>,
    #[serde(default)]
    handler: u32,
}

#[derive(Deserialize)]
struct EventUnlistenArgs {
    #[serde(rename = "eventId")]
    event_id: u32,
}

#[derive(Deserialize)]
struct EmitArgs {
    event: String,
    #[serde(default)]
    payload: Option<Value>,
}

#[derive(Deserialize)]
struct EmitToArgs {
    target: tauri::EventTarget,
    event: String,
    #[serde(default)]
    payload: Option<Value>,
}

#[derive(Deserialize)]
struct RidArgs {
    rid: u64,
}

#[derive(Deserialize)]
struct WindowLabelArgs {
    #[serde(default)]
    label: String,
}

#[derive(Deserialize)]
struct EnabledArg {
    enabled: bool,
}

#[derive(Deserialize)]
struct PasswordArg {
    #[serde(default)]
    password: Option<String>,
}

#[derive(Deserialize)]
struct PortArg {
    port: u16,
}

/// plugin:http|fetch rides `{ clientConfig }` like the vendored fetch.ts.
#[derive(Deserialize)]
struct FetchArgs {
    #[serde(rename = "clientConfig")]
    client_config: FetchConfig,
}
