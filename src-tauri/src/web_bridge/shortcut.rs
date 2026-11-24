// plugin:global-shortcut|register/unregister for web clients.
//
// Mirrors what the desktop plugin does for its JS guests: the handler rides
// an IPC channel serialized as "__CHANNEL__:<callbackId>" (the stt plugin's
// vendored bridge passes exactly that string and reads the
// `{ message: { shortcut, id, state } }` envelope). Implemented on the same
// GlobalShortcutExt manager the desktop webviews use, so desktop- and
// browser-registered hotkeys share one registry — a second registration of
// the same shortcut (from the other client) fails, which surfaces as a
// mic-shortcut-status error in the UI, same as desktop double-registration.

use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use super::{ConnCtx, ServerFrame, ServerState};

pub async fn register(
    st: &ServerState,
    conn: &ConnCtx,
    payload: Option<Value>,
) -> Result<Value, String> {
    let a: RegisterArgs =
        serde_json::from_value(payload.unwrap_or(Value::Null)).map_err(|e| e.to_string())?;
    let channel = a
        .handler
        .as_deref()
        .and_then(super::parse_channel_id);
    for shortcut_string in a.shortcuts {
        let tx = conn.tx.clone();
        let name = shortcut_string.clone();
        let index = AtomicU64::new(0);
        st.app
            .global_shortcut()
            .on_shortcut(shortcut_string.as_str(), move |_app, shortcut, event| {
                let Some(channel) = channel else { return };
                let state = match event.state {
                    ShortcutState::Pressed => "Pressed",
                    ShortcutState::Released => "Released",
                };
                let data = json!({
                    "message": {
                        "shortcut": shortcut.into_string(),
                        "id": event.id,
                        "state": state,
                    },
                    "index": index.fetch_add(1, Ordering::SeqCst),
                });
                let _ = tx.send(ServerFrame::Cb { id: channel, data });
            })
            .map_err(|e| e.to_string())?;
        conn.shortcuts.lock().unwrap().push(name);
    }
    Ok(Value::Null)
}

pub async fn unregister(
    st: &ServerState,
    conn: &ConnCtx,
    payload: Option<Value>,
) -> Result<Value, String> {
    let a: UnregisterArgs =
        serde_json::from_value(payload.unwrap_or(Value::Null)).map_err(|e| e.to_string())?;
    for shortcut_string in a.shortcuts {
        unregister_shortcut(&st.app, &shortcut_string)?;
        conn.shortcuts
            .lock()
            .unwrap()
            .retain(|s| s != &shortcut_string);
    }
    Ok(Value::Null)
}

/// Shared with connection cleanup (a disconnect releases the client's
/// hotkeys so they don't linger as "registered but nobody listening").
pub(crate) fn unregister_shortcut(app: &AppHandle, shortcut_string: &str) -> Result<(), String> {
    app.global_shortcut()
        .unregister(shortcut_string)
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct RegisterArgs {
    shortcuts: Vec<String>,
    #[serde(default)]
    handler: Option<String>,
}

#[derive(Deserialize)]
struct UnregisterArgs {
    shortcuts: Vec<String>,
}
