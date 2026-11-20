//! Host capability dispatch behind the ABI-3 `host_call` bridge.
//!
//! A backend calls `PluginCtx::host_call(capability, method, payload)` and
//! this module turns that into a concrete host action, permission-gated by
//! the plugin's manifest (the permission snapshot lives in `BridgeState`,
//! captured at load — dispatch must never re-take the plugin-host state
//! lock: it can run on a thread already inside the host's call path).
//!
//! Capabilities:
//! - `plugins`    (permission `"plugins"`)    — list/info/enable/disable
//! - `window`     (permission `"window"`)     — main-window layout control
//! - `app`        (permission `"app"`)        — resolved config, name, version
//! - `shortcuts`  (permission `"shortcuts"`)  — global shortcut registration
//!
//! Everything returns `Result<Value, String>`; `bridge.rs` wraps it into
//! the `{"ok":…}` envelope the SDK parses.

use serde_json::{json, Value};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager};

use super::bridge::BridgeState;
use super::PluginHostState;

/// Capability → required manifest permission. A capability not listed here
/// must not exist in `dispatch`'s match.
const CAPABILITIES: &[(&str, &str)] = &[
    ("plugins", "plugins"),
    ("window", "window"),
    ("app", "app"),
    ("shortcuts", "shortcuts"),
];

pub fn dispatch(
    state: &BridgeState,
    capability: &str,
    method: &str,
    payload: &Value,
) -> Result<Value, String> {
    let Some((_, permission)) = CAPABILITIES.iter().find(|(cap, _)| *cap == capability) else {
        let names = CAPABILITIES
            .iter()
            .map(|(cap, _)| *cap)
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "unknown capability: {capability} (available: {names})"
        ));
    };
    if !state.allowed(permission) {
        return Err(format!(
            "permission \"{permission}\" not granted to plugin {}",
            state.plugin_id
        ));
    }
    match capability {
        "plugins" => plugins(state, method, payload),
        "window" => window(state, method, payload),
        "app" => app(state, method, payload),
        "shortcuts" => shortcuts(state, method, payload),
        _ => unreachable!("capability gated by CAPABILITIES above"),
    }
}

// ---------------------------------------------------------------------------
// plugins — plugin management
// ---------------------------------------------------------------------------

fn plugins(state: &BridgeState, method: &str, payload: &Value) -> Result<Value, String> {
    // The plugin-host state is not managed yet while the initial discovery
    // loads backends (`init_state` runs before `app.manage`), so a backend
    // calling into `plugins` during startup init gets a clean error instead
    // of a panic.
    let Some(host) = state.app.try_state::<PluginHostState>() else {
        return Err("plugin host is not ready yet (backend still loading)".into());
    };
    match method {
        "list" => serde_json::to_value(host.list()).map_err(|e| e.to_string()),
        "info" => {
            let id = payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or(&state.plugin_id);
            Ok(host
                .list()
                .into_iter()
                .find(|p| p.id == id)
                .map(|p| serde_json::to_value(p).unwrap_or(Value::Null))
                .unwrap_or(Value::Null))
        }
        "is_enabled" => {
            let id = payload
                .get("id")
                .and_then(Value::as_str)
                .ok_or("payload must be {\"id\": \"…\"}")?;
            Ok(json!(host
                .list()
                .into_iter()
                .find(|p| p.id == id)
                .map(|p| p.enabled)
                .unwrap_or(false)))
        }
        "set_enabled" => {
            let id = payload
                .get("id")
                .and_then(Value::as_str)
                .ok_or("payload must be {\"id\": \"…\", \"enabled\": bool}")?;
            let enabled = payload
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or("payload must be {\"id\": \"…\", \"enabled\": bool}")?;
            if id == state.plugin_id {
                // Disabling ourselves would strand the in-flight call; enabling
                // ourselves would re-enter `init` while this call owns the
                // backend. The user manages this from Settings instead.
                return Err(format!(
                    "plugin {id} cannot change its own enabled state at runtime"
                ));
            }
            host.set_enabled(id, enabled).map(|_| Value::Null)
        }
        other => Err(format!("unknown plugins method: {other}")),
    }
}

// ---------------------------------------------------------------------------
// window — main-window layout control
// ---------------------------------------------------------------------------

fn window(state: &BridgeState, method: &str, payload: &Value) -> Result<Value, String> {
    let win = state
        .app
        .get_webview_window("main")
        .ok_or("main window not found")?;
    // Min inner size of the main window (tauri.conf.json: minWidth/minHeight).
    // Runtime windows expose no min-size getter in this tauri version, so
    // the clamp mirrors the config by hand.
    const MAIN_WINDOW_MIN: (f64, f64) = (240.0, 375.0);
    match method {
        "get_size" => {
            let scale = win.scale_factor().unwrap_or(1.0).max(1.0);
            let size = win.outer_size().map_err(|e| e.to_string())?;
            Ok(json!({
                "width": size.width as f64 / scale,
                "height": size.height as f64 / scale,
            }))
        }
        "set_size" => {
            let width = payload
                .get("width")
                .and_then(Value::as_f64)
                .ok_or("payload must be {\"width\": number, \"height\": number}")?;
            let height = payload
                .get("height")
                .and_then(Value::as_f64)
                .ok_or("payload must be {\"width\": number, \"height\": number}")?;
            // Same clamp the JS surface documents: the window's min size wins.
            let (width, height) = (
                width.max(MAIN_WINDOW_MIN.0),
                height.max(MAIN_WINDOW_MIN.1),
            );
            win.set_size(LogicalSize::new(width, height))
                .map_err(|e| e.to_string())
                .map(|_| Value::Null)
        }
        "get_position" => {
            let scale = win.scale_factor().unwrap_or(1.0).max(1.0);
            let pos = win.outer_position().map_err(|e| e.to_string())?;
            Ok(json!({
                "x": pos.x as f64 / scale,
                "y": pos.y as f64 / scale,
            }))
        }
        "set_position" => {
            if let Some(anchor) = payload.get("anchor").and_then(Value::as_str) {
                let anchor = anchor
                    .parse::<WindowAnchor>()
                    .map_err(|_| {
                        format!(
                            "unknown anchor: {anchor} (top-left, top-right, bottom-left, bottom-right, center)"
                        )
                    })?;
                snap_to_anchor(&win, anchor).map(|_| Value::Null)
            } else {
                let x = payload
                    .get("x")
                    .and_then(Value::as_f64)
                    .ok_or("payload must be {\"x\": number, \"y\": number} or {\"anchor\": …}")?;
                let y = payload
                    .get("y")
                    .and_then(Value::as_f64)
                    .ok_or("payload must be {\"x\": number, \"y\": number} or {\"anchor\": …}")?;
                win.set_position(LogicalPosition::new(x, y))
                    .map_err(|e| e.to_string())
                    .map(|_| Value::Null)
            }
        }
        "set_always_on_top" => {
            let on = payload.as_bool().ok_or("payload must be a boolean")?;
            win.set_always_on_top(on)
                .map_err(|e| e.to_string())
                .map(|_| Value::Null)
        }
        "set_click_through" => {
            let on = payload.as_bool().ok_or("payload must be a boolean")?;
            // Wayland routes click-through through the frontend's input-shape
            // exclusion flow (see click_through.rs); set_ignore_cursor_events
            // does not sync there.
            if cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some() {
                return Err(
                    "set_click_through is not supported under Wayland (use the frontend exclusion flow)"
                        .into(),
                );
            }
            win.set_ignore_cursor_events(on)
                .map_err(|e| e.to_string())
                .map(|_| Value::Null)
        }
        "set_follow_spaces" => {
            let join = payload.as_bool().ok_or("payload must be a boolean")?;
            super::super::set_main_follow_spaces(&state.app, join).map(|_| Value::Null)
        }
        other => Err(format!("unknown window method: {other}")),
    }
}

/// The `kebab-case` anchor presets of the SDK's `WindowAnchor`.
#[derive(Debug, Clone, Copy, PartialEq)]
enum WindowAnchor {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    Center,
}

impl std::str::FromStr for WindowAnchor {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "top-left" => Ok(WindowAnchor::TopLeft),
            "top-right" => Ok(WindowAnchor::TopRight),
            "bottom-left" => Ok(WindowAnchor::BottomLeft),
            "bottom-right" => Ok(WindowAnchor::BottomRight),
            "center" => Ok(WindowAnchor::Center),
            _ => Err(()),
        }
    }
}

/// Move the window to `anchor` of its current monitor's work area (mirrors
/// the JS `snapToAnchor`: same margin, same centering).
fn snap_to_anchor(win: &tauri::WebviewWindow, anchor: WindowAnchor) -> Result<(), String> {
    /// CSS-px gap between the window and the work-area edge.
    const SNAP_MARGIN: f64 = 16.0;
    let mon = win
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("no current monitor")?;
    let work = mon.work_area();
    let scale = win.scale_factor().unwrap_or(1.0).max(1.0);
    let size = win.outer_size().map_err(|e| e.to_string())?;
    let margin = (SNAP_MARGIN * scale).round() as i32;

    let x = if anchor == WindowAnchor::Center {
        work.position.x + ((work.size.width as i32 - size.width as i32) / 2)
    } else if anchor == WindowAnchor::TopLeft || anchor == WindowAnchor::BottomLeft {
        work.position.x + margin
    } else {
        work.position.x + work.size.width as i32 - size.width as i32 - margin
    };
    let y = if anchor == WindowAnchor::Center {
        work.position.y + ((work.size.height as i32 - size.height as i32) / 2)
    } else if anchor == WindowAnchor::TopLeft || anchor == WindowAnchor::TopRight {
        work.position.y + margin
    } else {
        work.position.y + work.size.height as i32 - size.height as i32 - margin
    };
    win.set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// app — read-only host app facts
// ---------------------------------------------------------------------------

fn app(state: &BridgeState, method: &str, _payload: &Value) -> Result<Value, String> {
    let config = state.app.config();
    match method {
        "config" => serde_json::to_value(config.clone()).map_err(|e| e.to_string()),
        "name" => Ok(json!(config
            .product_name
            .clone()
            .unwrap_or_else(|| config.identifier.clone()))),
        "version" => Ok(json!(state.app.package_info().version.to_string())),
        other => Err(format!("unknown app method: {other}")),
    }
}

// ---------------------------------------------------------------------------
// shortcuts — global shortcut registration
// ---------------------------------------------------------------------------

fn shortcuts(state: &BridgeState, method: &str, payload: &Value) -> Result<Value, String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let shortcut = payload
        .get("shortcut")
        .and_then(Value::as_str)
        .ok_or("payload must be {\"shortcut\": \"…\"}")?
        .to_string();
    let event_name = format!("plugin:{}:shortcut", state.plugin_id);
    let gs = state.app.global_shortcut();
    match method {
        "register" => {
            // Presses fan out as a namespaced event to every webview
            // (frontends can react; a backend reacts by having its frontend
            // call into it). Released is ignored: one event per press.
            let emitted = shortcut.clone();
            gs.on_shortcut(shortcut.as_str(), move |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = app.emit(&event_name, json!({ "shortcut": emitted }));
                }
            })
            .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "unregister" => {
            gs.unregister(shortcut.as_str()).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "is_registered" => Ok(json!(gs.is_registered(shortcut.as_str()))),
        other => Err(format!("unknown shortcuts method: {other}")),
    }
}
