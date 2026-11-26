use serde_json::Value;
use tauri::State;

use super::{PluginHostState, PluginInfo, PluginToolInfo};

/// All discovered plugins with their status.
#[tauri::command(rename_all = "snake_case")]
pub fn plugin_list(state: State<'_, PluginHostState>) -> Vec<PluginInfo> {
    state.list()
}

/// Route a request to a plugin backend. Runs on the blocking pool: plugin
/// code may take as long as it wants. `payload` is optional so raw invoke
/// sites (which legitimately call payload-less methods like
/// `vrm.get_active_model`) don't have to synthesize an argument — a missing
/// key would otherwise reject the whole command.
#[tauri::command(rename_all = "snake_case")]
pub async fn plugin_call(
    state: State<'_, PluginHostState>,
    plugin_id: String,
    method: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    let payload = payload.unwrap_or(Value::Null);
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.call(&plugin_id, &method, &payload))
        .await
        .map_err(|e| format!("plugin task failed: {e}"))?
}

/// Backend tools of all enabled plugins (merged into the chat tool list).
/// Runs on the blocking pool: each backend is queried live, and plugin code
/// may take as long as it wants.
#[tauri::command(rename_all = "snake_case")]
pub async fn plugin_list_tools(
    state: State<'_, PluginHostState>,
) -> Result<Vec<PluginToolInfo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || Ok(state.list_tools()))
        .await
        .map_err(|e| format!("plugin task failed: {e}"))?
}

/// Route a capability call to the backend that published it — the frontend
/// consume path for backend-owned capabilities (`ctx.capabilities.
/// callCapability`). The Rust SDK reaches the same routing through
/// `host_call("capabilities", "call", …)`. Runs on the blocking pool like
/// `plugin_call`: the owner's backend mutex serializes its own calls.
#[tauri::command(rename_all = "snake_case")]
pub async fn plugin_capability_call(
    state: State<'_, PluginHostState>,
    capability: String,
    method: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.call_capability(&capability, &method, &payload.unwrap_or(Value::Null))
    })
    .await
    .map_err(|e| format!("plugin task failed: {e}"))?
}

/// Snapshot of backend-published capabilities (`ctx.capabilities.listRemote`).
#[tauri::command(rename_all = "snake_case")]
pub fn plugin_capability_list(state: State<'_, PluginHostState>) -> Vec<(String, String)> {
    state.capabilities_list()
}

/// Persist the enabled flag and broadcast `plugins-changed`.
#[tauri::command(rename_all = "snake_case")]
pub async fn plugin_set_enabled(
    state: State<'_, PluginHostState>,
    plugin_id: String,
    enabled: bool,
) -> Result<Vec<PluginInfo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.set_enabled(&plugin_id, enabled))
        .await
        .map_err(|e| format!("plugin task failed: {e}"))?
}

/// Base64 frontend bundle of a plugin, imported by the webview as a blob URL.
/// Runs on the blocking pool: reads the bundle from disk and base64-encodes it.
#[tauri::command(rename_all = "snake_case")]
pub async fn plugin_read_frontend(
    state: State<'_, PluginHostState>,
    plugin_id: String,
) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.read_frontend(&plugin_id))
        .await
        .map_err(|e| format!("plugin task failed: {e}"))?
}

/// Import a plugin from a raw zip byte payload picked by the user. The bytes
/// travel as the IPC request body (`application/octet-stream`) rather than a
/// base64 JSON string: a ~400 MB plugin package would blow up several times
/// over through the JSON/base64 path and OOM the webview.
/// The heavy work (zip extraction, backend load) runs on a background thread:
/// the command returns immediately and the `plugins-changed` event signals
/// completion (or failure). Long-running commands lose their IPC responses on
/// macOS while the webview's scheme task stays open — the same wedge quit_app
/// works around.
#[tauri::command(rename_all = "snake_case")]
pub fn plugin_import_archive(
    state: State<'_, PluginHostState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(archive_bytes) = request.body() else {
        return Err("expected a raw byte payload".into());
    };
    spawn_import(state.inner().clone(), archive_bytes.to_vec());
    Ok(())
}

/// The import worker shared by the `plugin_import_archive` command and the
/// web bridge (`plugin_import_archive` rides base64 frames from browsers):
/// fire-and-forget import + `plugins-changed` broadcast on completion.
pub(crate) fn spawn_import(state: PluginHostState, archive_bytes: Vec<u8>) {
    std::thread::spawn(move || {
        if let Err(e) = state.import_archive(&archive_bytes) {
            eprintln!("[plugins] import failed: {e}");
        }
        state.notify_changed();
    });
}

/// Delete a plugin entirely (removes its files from disk).
#[tauri::command(rename_all = "snake_case")]
pub async fn plugin_delete(
    state: State<'_, PluginHostState>,
    plugin_id: String,
) -> Result<Vec<PluginInfo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.delete(&plugin_id))
        .await
        .map_err(|e| format!("plugin task failed: {e}"))?
}

/// Reinstall every bundled feature the user uninstalled (clears tombstones,
/// copies the packages back, reloads them). The heavy work runs on a
/// background thread: the command returns immediately and the
/// `plugins-changed` event signals completion (or failure). Long-running
/// commands lose their IPC responses on macOS while the webview's scheme
/// task stays open — the same wedge quit_app works around.
#[tauri::command(rename_all = "snake_case")]
pub fn plugin_restore_bundled(state: State<'_, PluginHostState>) -> Result<(), String> {
    let state = state.inner().clone();
    std::thread::spawn(move || {
        let result = state.restore_bundled();
        if let Err(e) = &result {
            eprintln!("[plugins] restore bundled failed: {e}");
        }
        state.notify_changed();
    });
    Ok(())
}

/// Namespaced per-plugin key/value storage.
#[tauri::command(rename_all = "snake_case")]
pub fn plugin_storage_get(
    state: State<'_, PluginHostState>,
    plugin_id: String,
    key: String,
) -> Option<Value> {
    state.storage_get(&plugin_id, &key)
}

#[tauri::command(rename_all = "snake_case")]
pub fn plugin_storage_set(
    state: State<'_, PluginHostState>,
    plugin_id: String,
    key: String,
    value: Value,
) -> Result<(), String> {
    state.storage_set(&plugin_id, &key, &value)
}
