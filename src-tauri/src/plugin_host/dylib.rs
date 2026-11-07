//! Dynamic-library plugin backend loading.
//!
//! Each backend is a `cdylib` exporting the C ABI from
//! `companion-plugin-sdk` (`export_plugin!`). The host resolves the symbol
//! set once, checks the ABI version, then routes calls through the vtable.
//! Backends are never unloaded once loaded (safe: `dlclose` on Rust dylibs
//! is leaky); a disabled backend is simply never called again.

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use companion_plugin_sdk::{HostBridge, RawBuffer, ABI_VERSION};
use libloading::Library;
use serde_json::Value;

use super::bridge;

type AbiFn = extern "C" fn() -> u32;
type CreateFn = extern "C" fn(bridge: HostBridge) -> *mut c_void;
type HandleFn = extern "C" fn(
    instance: *mut c_void,
    method: *const u8,
    method_len: usize,
    payload: *const u8,
    payload_len: usize,
) -> RawBuffer;
type ToolsFn = extern "C" fn(instance: *mut c_void) -> RawBuffer;
type DestroyFn = extern "C" fn(instance: *mut c_void);
type FreeFn = extern "C" fn(buffer: RawBuffer);

/// Raw instance pointer wrapper: calls are serialized behind the host's
/// `Mutex`, so the pointer is only ever dereferenced by one thread at a time.
#[derive(Clone, Copy)]
struct InstancePtr(*mut c_void);
unsafe impl Send for InstancePtr {}
unsafe impl Sync for InstancePtr {}

/// A loaded plugin backend: the library (kept alive), its resolved vtable,
/// the live instance, and the host bridge (kept alive).
pub struct BackendInstance {
    _lib: Library,
    vtable: VTable,
    instance: InstancePtr,
    _bridge: super::bridge::BridgeHandle,
}

struct VTable {
    handle: HandleFn,
    tools: ToolsFn,
    destroy: DestroyFn,
    free_buffer: FreeFn,
}

impl Drop for BackendInstance {
    fn drop(&mut self) {
        // Called at process teardown (backends are never unloaded while the
        // app runs). Giving shutdown a chance is best-effort.
        (self.vtable.destroy)(self.instance.0);
    }
}

/// Resolve the library file to load. Prefers the manifest's named path; if it
/// doesn't exist, tries platform-appropriate names derived from `plugin_id`.
/// This keeps manifests portable across macOS/Linux/Windows.
fn resolve_library_path(primary: &Path, plugin_id: &str) -> Result<PathBuf, String> {
    if primary.exists() {
        return primary
            .canonicalize()
            .map_err(|e| format!("canonicalize: {e}"));
    }
    let dir = primary.parent().unwrap_or_else(|| Path::new("."));
    // Platform-default candidates, most specific first.
    let ext = std::env::consts::DLL_EXTENSION;
    let prefix = std::env::consts::DLL_PREFIX;
    let mut candidates: Vec<String> = vec![
        format!("{prefix}{}_backend.{}", plugin_id, ext),
        format!("{}_backend.{}", plugin_id, ext),
    ];
    // Cross-platform fallbacks (in case a manifest ships a macOS name on
    // Windows/Linux or vice versa).
    for (p, e) in [("lib", "dylib"), ("lib", "so"), ("", "dll")] {
        let name = format!("{}{}_backend.{}", p, plugin_id, e);
        if !candidates.contains(&name) {
            candidates.push(name);
        }
    }
    for c in &candidates {
        let p = dir.join(c);
        if p.exists() {
            return p
                .canonicalize()
                .map_err(|e| format!("canonicalize: {e}"));
        }
    }
    Err(format!("no library found in {}", dir.display()))
}

impl BackendInstance {
    /// Load `library`, create the plugin instance with a host bridge bound to
    /// `plugin_id`, `data_dir`, and `plugin_dir`.
    pub fn load(
        app: &tauri::AppHandle,
        library_path: &Path,
        plugin_id: &str,
        data_dir: PathBuf,
        plugin_dir: PathBuf,
    ) -> Result<Self, String> {
        // Resolve the actual library file. Manifests may carry a canonical
        // (often macOS) filename; on other platforms fall back to the
        // platform-appropriate name so one manifest works everywhere.
        let path = resolve_library_path(library_path, plugin_id)
            .map_err(|e| format!("backend library not found: {}", e))?;
        let lib = unsafe { Library::new(&path) }.map_err(|e| format!("load failed: {e}"))?;

        let abi: libloading::Symbol<AbiFn> =
            unsafe { lib.get(b"companion_plugin_abi_version") }
                .map_err(|e| format!("missing companion_plugin_abi_version: {e}"))?;
        if abi() != ABI_VERSION {
            return Err(format!(
                "backend ABI {} does not match host ABI {} (rebuild the plugin)",
                abi(),
                ABI_VERSION
            ));
        }

        let create: libloading::Symbol<CreateFn> =
            unsafe { lib.get(b"companion_plugin_create") }
                .map_err(|e| format!("missing companion_plugin_create: {e}"))?;
        let handle: libloading::Symbol<HandleFn> =
            unsafe { lib.get(b"companion_plugin_handle") }
                .map_err(|e| format!("missing companion_plugin_handle: {e}"))?;
        let tools: libloading::Symbol<ToolsFn> =
            unsafe { lib.get(b"companion_plugin_tools") }
                .map_err(|e| format!("missing companion_plugin_tools: {e}"))?;
        let destroy: libloading::Symbol<DestroyFn> =
            unsafe { lib.get(b"companion_plugin_destroy") }
                .map_err(|e| format!("missing companion_plugin_destroy: {e}"))?;
        let free_buffer: libloading::Symbol<FreeFn> =
            unsafe { lib.get(b"companion_plugin_free_buffer") }
                .map_err(|e| format!("missing companion_plugin_free_buffer: {e}"))?;

        // The bridge state must outlive the instance; the backend holds the
        // Arc so the raw pointer embedded in `HostBridge` never dangles.
        let bridge_state = Arc::new(bridge::BridgeState::new(
            app.clone(),
            plugin_id,
            data_dir,
            plugin_dir,
        ));
        let native_bridge = HostBridge {
            user: Arc::as_ptr(&bridge_state) as *mut c_void,
            emit_event: bridge::emit_event,
            log: bridge::log,
            data_dir: bridge::data_dir,
            plugin_dir: bridge::plugin_dir,
        };

        let instance = create(native_bridge);
        if instance.is_null() {
            return Err("companion_plugin_create returned null".into());
        }

        let vtable = VTable {
            handle: *handle,
            tools: *tools,
            destroy: *destroy,
            free_buffer: *free_buffer,
        };
        Ok(BackendInstance {
            _lib: lib,
            vtable,
            instance: InstancePtr(instance),
            _bridge: bridge_state,
        })
    }

    /// Ask the backend for its current tool definitions. Queried live so
    /// dynamic tool sets (e.g. an MCP plugin whose servers connect or stop)
    /// stay current; runs serialized under the host's state mutex like
    /// `call`, so `&mut self` FFI safety holds.
    pub fn tools(&self) -> Vec<companion_plugin_sdk::ToolDef> {
        let raw = (self.vtable.tools)(self.instance.0);
        if raw.is_null() {
            return Vec::new();
        }
        let bytes =
            unsafe { std::slice::from_raw_parts(raw.ptr, raw.len) }.to_vec();
        (self.vtable.free_buffer)(raw);
        serde_json::from_slice(&bytes).unwrap_or_default()
    }

    /// Route one request. `payload_json` must be a JSON document (use
    /// `"null"` for no payload). Returns the `value` half of the plugin's
    /// result envelope.
    pub fn call(&self, method: &str, payload_json: &str) -> Result<Value, String> {
        let raw = (self.vtable.handle)(
            self.instance.0,
            method.as_ptr(),
            method.len(),
            payload_json.as_ptr(),
            payload_json.len(),
        );
        if raw.is_null() {
            return Err("plugin returned a null buffer".into());
        }
        let bytes =
            unsafe { std::slice::from_raw_parts(raw.ptr, raw.len) }.to_vec();
        (self.vtable.free_buffer)(raw);
        let envelope: Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("plugin returned invalid JSON envelope: {e}"))?;
        if envelope.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            Ok(envelope.get("value").cloned().unwrap_or(Value::Null))
        } else {
            Err(envelope
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown plugin error")
                .to_string())
        }
    }
}
