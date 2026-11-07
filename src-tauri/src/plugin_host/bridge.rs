//! Host-side callbacks handed to plugin backends via `HostBridge`. One
//! `BridgeState` per plugin lives in an `Arc`; the raw pointer passed to the
//! plugin stays valid because backends are never unloaded while the app runs.

use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

pub struct BridgeState {
    app: AppHandle,
    plugin_id: String,
    /// Writable per-plugin directory (`{app_data}/plugins-data/{id}/`).
    data_dir: PathBuf,
    /// Read-only package directory (manifest, bundles, assets).
    plugin_dir: PathBuf,
}

impl BridgeState {
    pub fn new(app: AppHandle, plugin_id: &str, data_dir: PathBuf, plugin_dir: PathBuf) -> Self {
        BridgeState {
            app,
            plugin_id: plugin_id.to_string(),
            data_dir,
            plugin_dir,
        }
    }
}

/// `HostBridge::emit_event`: emit `plugin:{id}:{event}` to all windows.
pub extern "C" fn emit_event(
    user: *mut c_void,
    event: *const u8,
    event_len: usize,
    payload: *const u8,
    payload_len: usize,
) {
    if user.is_null() || event.is_null() {
        return;
    }
    let state = unsafe { &*(user as *const BridgeState) };
    let event = String::from_utf8_lossy(unsafe {
        std::slice::from_raw_parts(event, event_len)
    });
    let namespaced = format!("plugin:{}:{}", state.plugin_id, event);
    let payload: Value = if payload.is_null() || payload_len == 0 {
        Value::Null
    } else {
        let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };
        serde_json::from_slice(bytes).unwrap_or(Value::Null)
    };
    let _ = state.app.emit(&namespaced, payload);
}

/// `HostBridge::log`: route plugin logs through the host console.
pub extern "C" fn log(user: *mut c_void, level: u32, msg: *const u8, msg_len: usize) {
    if user.is_null() || msg.is_null() {
        return;
    }
    let state = unsafe { &*(user as *const BridgeState) };
    let msg = String::from_utf8_lossy(unsafe {
        std::slice::from_raw_parts(msg, msg_len)
    });
    match level {
        companion_plugin_sdk::LOG_WARN => eprintln!("[plugin:{}] {msg}", state.plugin_id),
        companion_plugin_sdk::LOG_ERROR => {
            eprintln!("[plugin:{}] ERROR: {msg}", state.plugin_id)
        }
        _ => println!("[plugin:{}] {msg}", state.plugin_id),
    }
}

/// `HostBridge::data_dir`: the plugin's writable data directory. Two-pass
/// protocol: called once with a null buffer to size, then again to copy.
pub extern "C" fn data_dir(user: *mut c_void, out: *mut u8, out_cap: usize) -> usize {
    let Some(state) = bridge_state(user) else {
        return 0;
    };
    copy_path(&state.data_dir.to_string_lossy(), out, out_cap)
}

/// `HostBridge::plugin_dir`: the read-only package directory.
pub extern "C" fn plugin_dir(user: *mut c_void, out: *mut u8, out_cap: usize) -> usize {
    let Some(state) = bridge_state(user) else {
        return 0;
    };
    copy_path(&state.plugin_dir.to_string_lossy(), out, out_cap)
}

fn bridge_state(user: *mut c_void) -> Option<&'static BridgeState> {
    if user.is_null() {
        return None;
    }
    Some(unsafe { &*(user as *const BridgeState) })
}

/// Copy a UTF-8 path into the caller's buffer. Returns the needed byte count
/// (which also applies when the buffer is too small or null — the caller
/// retries with a bigger allocation).
fn copy_path(path: &str, out: *mut u8, out_cap: usize) -> usize {
    let bytes = path.as_bytes();
    if out.is_null() || out_cap < bytes.len() {
        return bytes.len();
    }
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len()) };
    bytes.len()
}

/// Keep the `Arc<BridgeState>` alive for the plugin's lifetime: the backend
/// instance holds one of these so the raw pointer embedded in `HostBridge`
/// never dangles.
pub type BridgeHandle = Arc<BridgeState>;
