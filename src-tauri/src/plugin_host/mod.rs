//! Plugin host: discovers plugin packages, loads dynamic-library backends,
//! persists the enabled/disabled map, provides per-plugin KV storage, and
//! routes `plugin_call` requests from the webviews.
//!
//! Plugin packages live in `{app_data_dir}/plugins/` and, in debug builds,
//! additionally in `{repo_root}/plugins/` (dev plugins). A package is a
//! directory with a `manifest.json` (see `manifest.rs`).
//!
//! Backends are loaded eagerly for enabled plugins and never unloaded (safe
//! `dlclose` is not a thing for Rust dylibs); a disabled backend simply stops
//! receiving calls. Frontend bundles are streamed to the webviews on demand
//! via `plugin_read_frontend` and imported as blob-URL modules.

pub mod bridge;
pub mod commands;
pub mod dylib;
pub mod manifest;

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use manifest::PluginManifest;

/// Cheaply cloneable so async commands can move it into `spawn_blocking`.
#[derive(Clone)]
pub struct PluginHostState {
    inner: Arc<HostInner>,
}

struct HostInner {
    app: AppHandle,
    app_data_dir: PathBuf,
    /// Bundled feature packages shipped with the app (release builds). None
    /// in dev builds, where the repo `plugins/` dir plays that role.
    bundled_dir: Option<PathBuf>,
    shared: Mutex<SharedState>,
}

struct SharedState {
    plugins: Vec<LoadedPlugin>,
    config: BTreeMap<String, bool>,
}

pub struct LoadedPlugin {
    pub manifest: PluginManifest,
    pub dir: PathBuf,
    /// The backend instance sits behind its own mutex so a long call into one
    /// plugin (model loads, synthesis, network tools) never blocks calls to
    /// other plugins: `HostInner.shared` is only held to resolve this Arc.
    /// Calls into a single backend stay serialized (the FFI contract).
    pub backend: Option<Arc<Mutex<dylib::BackendInstance>>>,
    pub load_error: Option<String>,
}

/// Serialized plugin summary for the webviews (`plugin_list`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub permissions: Vec<String>,
    pub enabled: bool,
    pub has_frontend: bool,
    pub has_backend: bool,
    pub backend_loaded: bool,
    pub load_error: Option<String>,
    /// Absolute path of the frontend bundle, read with `plugin_read_frontend`.
    pub frontend_path: Option<String>,
    pub dir: String,
    /// True when the package originated from the app's bundled features and
    /// can be restored after uninstall ("Restore bundled features").
    pub bundled: bool,
}

/// A backend tool as merged into the chat tool list (`plugin_list_tools`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginToolInfo {
    pub plugin_id: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

const PLUGINS_DIR: &str = "plugins";
const DATA_DIR: &str = "plugins-data";
const CONFIG_FILE: &str = "plugins-config.json";
const REMOVED_FILE: &str = "plugins-removed.json";
const CHANGED_EVENT: &str = "plugins-changed";
/// Bundled feature plugins ship here inside the app resources and are seeded
/// into `{app_data}/plugins/` on startup (unless tombstoned by uninstall).
const BUNDLED_RESOURCE_DIR: &str = "plugins";
/// The feature plugins that ship with the app. Used to distinguish
/// bundled packages from third-party installs in dev builds (where the
/// discovery dir doubles as the bundled source dir).
const BUNDLED_IDS: &[&str] = &["alarms", "calendar", "chat", "mcp", "stt", "tts", "vrm"];

pub fn init_state(app: &AppHandle) -> PluginHostState {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let config = load_config(&app_data_dir);
    // Per-plugin file-storage roots must exist before backend `init` runs,
    // because backends may write into them right away.
    let data_dir = app_data_dir.join(DATA_DIR);
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("[plugins] could not create data dir: {e}");
    }
    // Bundled feature plugins (release): copy any missing package from the
    // app resources into the app-data plugins dir so the user can manage
    // (disable/uninstall) them like any other plugin. A tombstoned id stays
    // uninstalled until "Restore bundled features".
    let bundled_dir = bundled_source_dir(app);
    if let Some(src_root) = &bundled_dir {
        seed_bundled(
            src_root,
            &app_data_dir.join(PLUGINS_DIR),
            &load_removed(&app_data_dir),
        );
    }
    // One-time plugin id rename (`library` -> `vrm`): the data dir moves to
    // the new id and a stale seeded package still declaring the old id is
    // removed. Must run BEFORE the legacy-file migrations below, which write
    // into the renamed plugin's data dir.
    migrate_renamed_plugin(&app_data_dir, "library", "vrm");
    // The pre-split voice plugin was replaced by the separate stt + tts
    // plugins: retire any stale installed copy/config entry of the old id.
    migrate_replaced_plugin(&app_data_dir, "voice");
    // Legacy single-file feature storage moves into the owning plugin's data
    // dir BEFORE backends load (they read their files during init).
    migrate_legacy_file(&app_data_dir, "alarms.json", "alarms", "alarms.json");
    migrate_legacy_file(&app_data_dir, "mcp.json", "mcp", "mcp.json");
    migrate_legacy_dir(&app_data_dir, "motions", "vrm", "motions");
    migrate_legacy_dir(&app_data_dir, "emotions", "vrm", "emotions");
    migrate_legacy_dir(&app_data_dir, "models", "vrm", "models");
    migrate_legacy_file(&app_data_dir, "active_model.txt", "vrm", "active_model.txt");
    migrate_legacy_file(&app_data_dir, "calendar.json", "calendar", "calendar.json");
    // Performance config moved to the vrm plugin backend (the perf settings
    // UI lives there); the host's root-level file retires into its data dir.
    migrate_legacy_file(&app_data_dir, "performance.json", "vrm", "performance.json");
    let mut plugins = Vec::new();
    for (dir, manifest) in discover(&plugin_dirs(app)) {
        let enabled = config.get(&manifest.id).copied().unwrap_or(true);
        let plugin_data_dir = data_dir.join(&manifest.id);
        if let Err(e) = std::fs::create_dir_all(&plugin_data_dir) {
            eprintln!("[plugins:{}] could not create data dir: {e}", manifest.id);
        }
        let (backend, load_error) = if enabled {
            load_backend(app, &app_data_dir, &dir, &manifest)
        } else {
            (None, None)
        };
        plugins.push(LoadedPlugin {
            manifest,
            dir,
            backend,
            load_error,
        });
    }
    println!(
        "[plugins] discovered {} plugin(s): {}",
        plugins.len(),
        plugins
            .iter()
            .map(|p| p.manifest.id.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
    PluginHostState {
        inner: Arc::new(HostInner {
            app: app.clone(),
            app_data_dir,
            bundled_dir,
            shared: Mutex::new(SharedState { plugins, config }),
        }),
    }
}

/// Where bundled feature packages ship. Tauri v2 preserves the
/// config-relative path for `bundle.resources`, so the `"resources"` entry
/// lands the packages at `<resource_dir>/resources/plugins` (macOS:
/// `Contents/Resources/resources/plugins`, Linux deb: `/usr/lib/companion/resources/plugins`,
/// Windows: `<install_dir>/resources/plugins`). In dev builds the resource
/// dir does not carry them (the repo `plugins/` folder is used instead), so
/// a missing dir means "no bundled source".
fn bundled_source_dir(app: &AppHandle) -> Option<PathBuf> {
    // 1. Tauri resource dir (release builds, if resources are bundled) and
    //    the executable directory, probing the nested `resources/` layout
    //    first, then a direct `plugins/` sibling for other layouts.
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("resources").join(BUNDLED_RESOURCE_DIR));
        candidates.push(dir.join(BUNDLED_RESOURCE_DIR));
    }
    // Next to the executable (Windows installs keep resources beside it).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("resources").join(BUNDLED_RESOURCE_DIR));
            candidates.push(dir.join(BUNDLED_RESOURCE_DIR));
            candidates.push(dir.join("..").join(BUNDLED_RESOURCE_DIR));
        }
    }
    for cand in candidates {
        if cand.is_dir() {
            return Some(cand);
        }
    }
    // 2. Dev builds: the repo-root plugins/ dir (also the dev discovery root).
    #[cfg(debug_assertions)]
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let dev = std::path::PathBuf::from(manifest_dir)
            .join("..")
            .join("..")
            .join(BUNDLED_RESOURCE_DIR);
        if dev.is_dir() {
            return Some(dev);
        }
    }
    None
}

/// Copy every bundled package that is missing from `dest` and not
/// tombstoned. Idempotent. In debug builds an installed copy whose source
/// has changed is refreshed, so a rebuilt plugin is not shadowed forever by
/// the copy an earlier run seeded (app data outranks the dev dir in
/// discovery); release keeps the never-overwrite rule for installed copies.
fn seed_bundled(src_root: &Path, dest_root: &Path, removed: &HashSet<String>) {
    let entries = match std::fs::read_dir(src_root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let src = entry.path();
        if !src.is_dir() || !src.join("manifest.json").exists() {
            continue;
        }
        let id = src.file_name().map(|n| n.to_string_lossy().into_owned());
        let Some(id) = id else { continue };
        if !BUNDLED_IDS.contains(&id.as_str()) {
            continue;
        }
        if removed.contains(&id) {
            continue;
        }
        let dest = dest_root.join(&id);
        if dest.exists() {
            refresh_bundled_if_stale(&src, &dest, &id);
            if dest.exists() {
                continue;
            }
        }
        if let Err(e) = copy_dir_recursive(&src, &dest) {
            eprintln!("[plugins] seed bundled {id}: {e}");
        } else {
            write_seed_stamp(&src, &dest);
            println!("[plugins] seeded bundled feature: {id}");
        }
    }
}

/// Newest file mtime inside a package, in nanos. fs::copy does not preserve
/// mtimes, so the installed copy's own timestamps cannot be compared against
/// the source — the stamp recorded at seed time can.
///
/// `assets/` directories are excluded from the walk: they hold the heavy
/// model files (voice's are 640+MB), whose metadata walk costs real time on
/// every dev launch, and they change rarely. Trade-off: asset-only edits
/// don't trigger a dev refresh — touch `manifest.json` (or delete the
/// installed copy) to force one.
fn source_stamp(dir: &Path) -> Option<u128> {
    fn walk(dir: &Path, max: &mut Option<u128>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().and_then(|n| n.to_str()) == Some("assets") {
                    continue;
                }
                walk(&path, max);
            } else if let Ok(meta) = entry.metadata() {
                if let Ok(mtime) = meta.modified() {
                    let nanos = mtime
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or(0);
                    if max.map_or(true, |m| nanos > m) {
                        *max = Some(nanos);
                    }
                }
            }
        }
    }
    let mut max = None;
    walk(dir, &mut max);
    max
}

/// Stamp persisted in an installed package at seed time.
fn write_seed_stamp(src: &Path, dest: &Path) {
    if let Some(stamp) = source_stamp(src) {
        let _ = std::fs::write(dest.join(".seeded-stamp"), stamp.to_string());
    }
}

/// Reads the stamp `write_seed_stamp` recorded, for the staleness check in
/// `refresh_bundled_if_stale`.
fn seed_stamp(dest: &Path) -> Option<u128> {
    std::fs::read_to_string(dest.join(".seeded-stamp"))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Replace an installed bundled package with its source copy when the source
/// has been rebuilt since it was seeded. Bundled features ship with the app,
/// so an app update must deliver their updates too — without this, a rebuilt
/// app silently keeps running every previously installed copy (the seed only
/// fills gaps). Uninstall tombstones are checked by the caller; user data
/// lives in plugins-data/, never in the package, so a refresh is lossless.
/// The loaded backend keeps running until restart (backends are never
/// unloaded), but the frontend bundle and tool lists pick up on the next
/// launch/webview.
fn refresh_bundled_if_stale(src: &Path, dest: &Path, id: &str) {
    let Some(stamp) = source_stamp(src) else {
        return;
    };
    if seed_stamp(dest) == Some(stamp) {
        return;
    }
    if let Err(e) = std::fs::remove_dir_all(dest) {
        eprintln!("[plugins] refresh bundled {id}: remove old copy: {e}");
        return;
    }
    if let Err(e) = copy_dir_recursive(src, dest) {
        eprintln!("[plugins] refresh bundled {id}: {e}");
        return;
    }
    write_seed_stamp(src, dest);
    println!("[plugins] refreshed bundled feature from build: {id}");
}

/// Ids the user uninstalled that have a bundled source (so seeding skips
/// them until restore). persisted as `plugins-removed.json`.
fn load_removed(app_data_dir: &Path) -> HashSet<String> {
    match std::fs::read(app_data_dir.join(REMOVED_FILE)) {
        Ok(raw) => serde_json::from_slice(&raw).unwrap_or_default(),
        Err(_) => HashSet::new(),
    }
}

fn save_removed(app_data_dir: &Path, removed: &HashSet<String>) -> Result<(), String> {
    let json = serde_json::to_vec(removed).map_err(|e| e.to_string())?;
    std::fs::write(app_data_dir.join(REMOVED_FILE), json).map_err(|e| e.to_string())
}

impl PluginHostState {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, SharedState>, String> {
        self.inner.shared.lock().map_err(|e| e.to_string())
    }

    /// Broadcast the current plugin list to the webviews. Used by background
    /// work (restore/import) whose command returns before the work finishes:
    /// the `plugins-changed` event is the completion signal.
    pub fn notify_changed(&self) {
        let _ = self.inner.app.emit(CHANGED_EVENT, &self.list());
    }

    /// Snapshot for the webviews.
    pub fn list(&self) -> Vec<PluginInfo> {
        let inner = match self.lock() {
            Ok(inner) => inner,
            Err(e) => {
                eprintln!("[plugins] list failed: {e}");
                return Vec::new();
            }
        };
        let bundled_root = self.inner.bundled_dir.as_ref();
        inner
            .plugins
            .iter()
            .map(|p| {
                let bundled = bundled_root
                    .map(|root| {
                        BUNDLED_IDS.contains(&p.manifest.id.as_str())
                            && root.join(&p.manifest.id).is_dir()
                    })
                    .unwrap_or(false);
                plugin_info(
                    p,
                    inner.config.get(&p.manifest.id).copied().unwrap_or(true),
                    bundled,
                )
            })
            .collect()
    }

    /// Route one request to a plugin backend. Called inside
    /// `spawn_blocking`; the dylib call may take as long as the plugin wants.
    ///
    /// The shared lock is only held to resolve the plugin and clone its
    /// backend handle — the FFI call itself runs under the backend's own
    /// mutex, so a slow plugin never blocks calls to other plugins.
    pub fn call(&self, plugin_id: &str, method: &str, payload: &Value) -> Result<Value, String> {
        let backend = {
            let inner = self.lock()?;
            let plugin = inner
                .plugins
                .iter()
                .find(|p| p.manifest.id == plugin_id)
                .ok_or_else(|| format!("unknown plugin: {plugin_id}"))?;
            if !inner.config.get(plugin_id).copied().unwrap_or(true) {
                return Err(format!("plugin {plugin_id} is disabled"));
            }
            plugin
                .backend
                .clone()
                .ok_or_else(|| format!("plugin {plugin_id} has no backend loaded"))?
        };
        let backend = backend
            .lock()
            .map_err(|_| format!("plugin {plugin_id} backend mutex poisoned"))?;
        backend.call(method, &payload.to_string())
    }

    /// Backend tools of all enabled, loaded plugins. Queried live from each
    /// backend so dynamic tool sets stay current. Backend handles are
    /// snapshotted under the shared lock, then queried one by one — a busy
    /// plugin delays its own entry, not everyone else's.
    pub fn list_tools(&self) -> Vec<PluginToolInfo> {
        let backends: Vec<(String, Arc<Mutex<dylib::BackendInstance>>)> = {
            let inner = match self.lock() {
                Ok(inner) => inner,
                Err(e) => {
                    eprintln!("[plugins] list_tools failed: {e}");
                    return Vec::new();
                }
            };
            inner
                .plugins
                .iter()
                .filter(|p| inner.config.get(&p.manifest.id).copied().unwrap_or(true))
                .filter_map(|p| p.backend.clone().map(|b| (p.manifest.id.clone(), b)))
                .collect()
        };
        let mut tools: Vec<PluginToolInfo> = Vec::new();
        for (plugin_id, backend) in &backends {
            let Ok(backend) = backend.lock() else {
                eprintln!("[plugins:{plugin_id}] backend mutex poisoned; skipping tools");
                continue;
            };
            for tool in backend.tools() {
                tools.push(PluginToolInfo {
                    plugin_id: plugin_id.clone(),
                    name: tool.name.clone(),
                    description: tool.description.clone(),
                    input_schema: tool.input_schema.clone(),
                });
            }
        }
        tools
    }

    /// Persist the enabled flag, load (or stop routing to) the backend, and
    /// broadcast the new list. Frontend contributions are dropped live by the
    /// webviews; full backend unloading requires an app restart.
    pub fn set_enabled(&self, plugin_id: &str, enabled: bool) -> Result<Vec<PluginInfo>, String> {
        let mut guard = self.lock()?;
        let idx = guard
            .plugins
            .iter()
            .position(|p| p.manifest.id == plugin_id)
            .ok_or_else(|| format!("unknown plugin: {plugin_id}"))?;
        guard.config.insert(plugin_id.to_string(), enabled);
        {
            let plugin = &mut guard.plugins[idx];
            if enabled && plugin.backend.is_none() && plugin.load_error.is_none() {
                let (backend, load_error) = load_backend(
                    &self.inner.app,
                    &self.inner.app_data_dir,
                    &plugin.dir,
                    &plugin.manifest,
                );
                plugin.backend = backend;
                plugin.load_error = load_error;
            }
        }
        let bundled_root = self.inner.bundled_dir.clone();
        let infos = guard
            .plugins
            .iter()
            .map(|p| {
                let bundled = bundled_root
                    .as_ref()
                    .map(|root| {
                        BUNDLED_IDS.contains(&p.manifest.id.as_str())
                            && root.join(&p.manifest.id).is_dir()
                    })
                    .unwrap_or(false);
                plugin_info(
                    p,
                    guard.config.get(&p.manifest.id).copied().unwrap_or(true),
                    bundled,
                )
            })
            .collect();
        save_config(&self.inner.app_data_dir, &guard.config)?;
        drop(guard);
        let _ = self.inner.app.emit(CHANGED_EVENT, &infos);
        Ok(infos)
    }

    /// Base64 of the frontend bundle; the webview decodes it into a blob URL
    /// and dynamically imports it. Works identically in dev and prod without
    /// asset-protocol scope configuration. The shared lock only resolves the
    /// bundle path — the read and encode run unlocked.
    pub fn read_frontend(&self, plugin_id: &str) -> Result<String, String> {
        let path = {
            let inner = self.lock()?;
            let plugin = inner
                .plugins
                .iter()
                .find(|p| p.manifest.id == plugin_id)
                .ok_or_else(|| format!("unknown plugin: {plugin_id}"))?;
            let entry = plugin
                .manifest
                .frontend
                .as_ref()
                .ok_or_else(|| format!("plugin {plugin_id} has no frontend"))?;
            plugin.dir.join(&entry.entry)
        };
        let bytes =
            std::fs::read(&path).map_err(|e| format!("frontend bundle not readable: {e}"))?;
        use base64::Engine;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    pub fn storage_get(&self, plugin_id: &str, key: &str) -> Option<Value> {
        self.storage_map(plugin_id).ok()?.get(key).cloned()
    }

    pub fn storage_set(&self, plugin_id: &str, key: &str, value: &Value) -> Result<(), String> {
        let mut map = self.storage_map(plugin_id)?;
        if value.is_null() {
            map.remove(key);
        } else {
            map.insert(key.to_string(), value.clone());
        }
        let path = storage_path(&self.inner.app_data_dir, plugin_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_vec(&map).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())
    }

    /// Import a plugin from raw zip archive bytes. Writes the archive to a
    /// temp dir, extracts, validates the manifest, then moves the package
    /// into `{app_data}/plugins/<id>/` (replacing any existing one) and
    /// activates it. Returns the imported plugin's summary.
    pub fn import_archive(&self, archive_bytes: &[u8]) -> Result<PluginInfo, String> {
        let tmp_root = std::env::temp_dir().join("companion-plugin-import");
        let _ = std::fs::remove_dir_all(&tmp_root);
        std::fs::create_dir_all(&tmp_root).map_err(|e| e.to_string())?;
        let archive_path = tmp_root.join("plugin.zip");
        std::fs::write(&archive_path, archive_bytes).map_err(|e| e.to_string())?;

        let extract_dir = tmp_root.join("extracted");
        std::fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;
        let file = std::fs::File::open(&archive_path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("not a valid zip: {e}"))?;
        zip.extract(&extract_dir)
            .map_err(|e| format!("zip extract failed: {e}"))?;

        let pkg_root = if extract_dir.join("manifest.json").exists() {
            extract_dir.clone()
        } else {
            let mut dirs: Vec<PathBuf> = std::fs::read_dir(&extract_dir)
                .map_err(|e| e.to_string())?
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            if dirs.len() == 1 && dirs[0].join("manifest.json").exists() {
                dirs.pop().unwrap()
            } else {
                return Err("archive must contain a manifest.json at its root (or in a single top-level folder)".into());
            }
        };

        let manifest_json = std::fs::read_to_string(pkg_root.join("manifest.json"))
            .map_err(|e| format!("manifest.json unreadable: {e}"))?;
        let manifest = PluginManifest::parse(&manifest_json)?;

        let app_data_dir = self.inner.app_data_dir.clone();
        let dest = app_data_dir.join("plugins").join(&manifest.id);
        if dest.exists() {
            std::fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
        }
        std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
        copy_dir_recursive(&pkg_root, &dest)?;

        let mut guard = self.lock()?;
        if let Some(pos) = guard
            .plugins
            .iter()
            .position(|p| p.manifest.id == manifest.id)
        {
            guard.plugins.remove(pos);
        }
        guard.config.insert(manifest.id.clone(), true);
        let (backend, load_error) = load_backend(&self.inner.app, &app_data_dir, &dest, &manifest);
        guard.plugins.push(LoadedPlugin {
            manifest: manifest.clone(),
            dir: dest.clone(),
            backend,
            load_error,
        });
        let bundled_root = self.inner.bundled_dir.clone();
        let info = plugin_info(
            guard.plugins.last().unwrap(),
            guard.config.get(&manifest.id).copied().unwrap_or(true),
            bundled_root
                .as_ref()
                .map(|root| root.join(&manifest.id).is_dir())
                .unwrap_or(false),
        );
        save_config(&self.inner.app_data_dir, &guard.config)?;
        let app = self.inner.app.clone();
        let plugins = guard
            .plugins
            .iter()
            .map(|p| {
                let bundled = bundled_root
                    .as_ref()
                    .map(|root| {
                        BUNDLED_IDS.contains(&p.manifest.id.as_str())
                            && root.join(&p.manifest.id).is_dir()
                    })
                    .unwrap_or(false);
                plugin_info(
                    p,
                    guard.config.get(&p.manifest.id).copied().unwrap_or(true),
                    bundled,
                )
            })
            .collect::<Vec<_>>();
        drop(guard);
        let _ = app.emit("plugins-changed", &plugins);

        let _ = std::fs::remove_dir_all(&tmp_root);

        Ok(info)
    }

    pub fn delete(&self, plugin_id: &str) -> Result<Vec<PluginInfo>, String> {
        let mut guard = self.lock()?;
        let pos = guard
            .plugins
            .iter()
            .position(|p| p.manifest.id == plugin_id)
            .ok_or_else(|| format!("unknown plugin: {plugin_id}"))?;
        let plugin = guard.plugins.remove(pos);
        guard.config.remove(plugin_id);
        let dir = plugin.dir.clone();
        save_config(&self.inner.app_data_dir, &guard.config)?;
        // Bundled feature: tombstone the id so the next startup does not
        // re-seed it. `restore_bundled` clears the tombstone.
        let bundled_id = self
            .inner
            .bundled_dir
            .as_ref()
            .map(|root| root.join(plugin_id).is_dir())
            .unwrap_or(false);
        if bundled_id {
            let mut removed = load_removed(&self.inner.app_data_dir);
            removed.insert(plugin_id.to_string());
            if let Err(e) = save_removed(&self.inner.app_data_dir, &removed) {
                eprintln!("[plugins] tombstone {plugin_id}: {e}");
            }
        }
        let bundled_root = self.inner.bundled_dir.clone();
        let plugins = guard
            .plugins
            .iter()
            .map(|p| {
                let bundled = bundled_root
                    .as_ref()
                    .map(|root| {
                        BUNDLED_IDS.contains(&p.manifest.id.as_str())
                            && root.join(&p.manifest.id).is_dir()
                    })
                    .unwrap_or(false);
                plugin_info(
                    p,
                    guard.config.get(&p.manifest.id).copied().unwrap_or(true),
                    bundled,
                )
            })
            .collect::<Vec<_>>();
        let app = self.inner.app.clone();
        drop(guard);

        if let Err(e) = std::fs::remove_dir_all(&dir) {
            eprintln!("[plugins] could not remove {}: {e}", dir.display());
        }

        let _ = app.emit("plugins-changed", &plugins);
        Ok(plugins)
    }

    /// Re-seed every bundled feature the user uninstalled: clears all
    /// tombstones, copies missing packages back, discovers them, and returns
    /// the refreshed list.
    pub fn restore_bundled(&self) -> Result<Vec<PluginInfo>, String> {
        let Some(src_root) = self.inner.bundled_dir.clone() else {
            return Err("no bundled features in this build".into());
        };
        // Clear tombstones.
        let _ = std::fs::remove_file(self.inner.app_data_dir.join(REMOVED_FILE));

        let dest_root = self.inner.app_data_dir.join(PLUGINS_DIR);
        let mut guard = self.lock()?;
        let removed = HashSet::new(); // tombstones just cleared
        seed_bundled(&src_root, &dest_root, &removed);
        for (dir, manifest) in discover(std::slice::from_ref(&dest_root)) {
            if guard.plugins.iter().any(|p| p.manifest.id == manifest.id) {
                continue;
            }
            let enabled = guard.config.get(&manifest.id).copied().unwrap_or(true);
            let plugin_data_dir = self.inner.app_data_dir.join(DATA_DIR).join(&manifest.id);
            let _ = std::fs::create_dir_all(&plugin_data_dir);
            let (backend, load_error) = if enabled {
                load_backend(&self.inner.app, &self.inner.app_data_dir, &dir, &manifest)
            } else {
                (None, None)
            };
            guard.plugins.push(LoadedPlugin {
                manifest,
                dir,
                backend,
                load_error,
            });
        }
        guard
            .plugins
            .sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
        let bundled_root = Some(src_root);
        let infos = guard
            .plugins
            .iter()
            .map(|p| {
                let bundled = bundled_root
                    .as_ref()
                    .map(|root| {
                        BUNDLED_IDS.contains(&p.manifest.id.as_str())
                            && root.join(&p.manifest.id).is_dir()
                    })
                    .unwrap_or(false);
                plugin_info(
                    p,
                    guard.config.get(&p.manifest.id).copied().unwrap_or(true),
                    bundled,
                )
            })
            .collect::<Vec<_>>();
        let app = self.inner.app.clone();
        drop(guard);
        let _ = app.emit(CHANGED_EVENT, &infos);
        Ok(infos)
    }

    fn storage_map(&self, plugin_id: &str) -> Result<BTreeMap<String, Value>, String> {
        // Only discovered plugins get storage, so `plugin_id` here is always
        // a validated, already-known id — no path traversal risk.
        if !self
            .lock()?
            .plugins
            .iter()
            .any(|p| p.manifest.id == plugin_id)
        {
            return Err(format!("unknown plugin: {plugin_id}"));
        }
        let path = storage_path(&self.inner.app_data_dir, plugin_id);
        let raw = match std::fs::read(&path) {
            Ok(raw) => raw,
            Err(_) => return Ok(BTreeMap::new()),
        };
        serde_json::from_slice(&raw).map_err(|e| format!("corrupt storage file: {e}"))
    }
}

fn plugin_info(p: &LoadedPlugin, enabled: bool, bundled: bool) -> PluginInfo {
    PluginInfo {
        id: p.manifest.id.clone(),
        name: p.manifest.name.clone(),
        version: p.manifest.version.clone(),
        description: p.manifest.description.clone(),
        permissions: p.manifest.permissions.clone(),
        enabled,
        has_frontend: p.manifest.frontend.is_some(),
        has_backend: p.manifest.backend.is_some(),
        backend_loaded: p.backend.is_some(),
        load_error: p.load_error.clone(),
        frontend_path: p
            .manifest
            .frontend
            .as_ref()
            .map(|f| p.dir.join(&f.entry).to_string_lossy().into_owned()),
        dir: p.dir.to_string_lossy().into_owned(),
        bundled,
    }
}

/// Search roots: app data always; the repo-root `plugins/` folder in dev.
fn plugin_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = vec![app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join(PLUGINS_DIR)];
    if cfg!(debug_assertions) {
        if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
            let dev = PathBuf::from(manifest_dir).join("..").join(PLUGINS_DIR);
            if let Ok(canon) = dev.canonicalize() {
                if canon.is_dir() {
                    dirs.push(canon);
                }
            }
        }
    }
    dirs
}

fn discover(dirs: &[PathBuf]) -> Vec<(PathBuf, PluginManifest)> {
    let mut found: Vec<(PathBuf, PluginManifest)> = Vec::new();
    let mut seen = HashSet::new();
    for dir in dirs {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let pkg_dir = entry.path();
            if !pkg_dir.is_dir() {
                continue;
            }
            let manifest_path = pkg_dir.join("manifest.json");
            let json = match std::fs::read_to_string(&manifest_path) {
                Ok(json) => json,
                Err(_) => continue,
            };
            let manifest = match PluginManifest::parse(&json) {
                Ok(manifest) => manifest,
                Err(e) => {
                    eprintln!("[plugins] skipping {}: {e}", pkg_dir.display());
                    continue;
                }
            };
            // First package claiming an id wins (app data outranks dev dirs).
            if !seen.insert(manifest.id.clone()) {
                continue;
            }
            found.push((pkg_dir, manifest));
        }
    }
    found.sort_by(|a, b| a.1.id.cmp(&b.1.id));
    found
}

fn load_backend(
    app: &AppHandle,
    app_data_dir: &Path,
    dir: &Path,
    manifest: &PluginManifest,
) -> (Option<Arc<Mutex<dylib::BackendInstance>>>, Option<String>) {
    match &manifest.backend {
        None => (None, None),
        Some(backend) => {
            if let Some(warn) = manifest.platform_warning() {
                eprintln!("[plugins:{}] {}", manifest.id, warn);
            }
            let library = dir.join(&backend.library);
            let data_dir = app_data_dir.join(DATA_DIR).join(&manifest.id);
            if let Err(e) = std::fs::create_dir_all(&data_dir) {
                eprintln!("[plugins:{}] could not create data dir: {e}", manifest.id);
            }
            match dylib::BackendInstance::load(
                app,
                &library,
                &manifest.id,
                data_dir,
                dir.to_path_buf(),
            ) {
                Ok(instance) => (Some(Arc::new(Mutex::new(instance))), None),
                Err(e) => {
                    eprintln!("[plugins:{}] backend load failed: {e}", manifest.id);
                    (None, Some(e))
                }
            }
        }
    }
}

fn config_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(CONFIG_FILE)
}

fn load_config(app_data_dir: &Path) -> BTreeMap<String, bool> {
    match std::fs::read(config_path(app_data_dir)) {
        Ok(raw) => serde_json::from_slice(&raw).unwrap_or_default(),
        Err(_) => BTreeMap::new(),
    }
}

fn save_config(app_data_dir: &Path, config: &BTreeMap<String, bool>) -> Result<(), String> {
    let json = serde_json::to_vec(config).map_err(|e| e.to_string())?;
    std::fs::write(config_path(app_data_dir), json).map_err(|e| e.to_string())
}

fn storage_path(app_data_dir: &Path, plugin_id: &str) -> PathBuf {
    app_data_dir
        .join(DATA_DIR)
        .join(format!("{plugin_id}.json"))
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let to = dest.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else if ty.is_file() {
            std::fs::copy(entry.path(), &to).map_err(|e| e.to_string())?;
        }
        // Symlinks and other types are skipped.
    }
    Ok(())
}

/// One-time migration for a legacy feature directory: copied into the
/// owning plugin's data dir, then the original is renamed `*.migrated`.
fn migrate_legacy_dir(app_data_dir: &Path, legacy: &str, plugin_id: &str, target: &str) {
    let from = app_data_dir.join(legacy);
    if !from.is_dir() {
        return;
    }
    let to_dir = app_data_dir.join(DATA_DIR).join(plugin_id);
    let to = to_dir.join(target);
    let retire = || {
        let _ = std::fs::rename(&from, {
            let mut p = from.clone().into_os_string();
            p.push(".migrated");
            std::path::PathBuf::from(p)
        });
    };
    if to.exists() {
        retire();
        return;
    }
    if let Err(e) = copy_dir_recursive(&from, &to) {
        eprintln!("[plugins] migrate dir {legacy} -> {plugin_id}: {e}");
        return;
    }
    retire();
    println!("[plugins] migrated dir {legacy} into plugins-data/{plugin_id}/{target}");
}

/// One-time migration for a plugin id rename (`library` -> `vrm`): the old
/// data dir moves to the new id (installed models/motions/emotions survive
/// the rename), and a stale seeded package still declaring the old manifest
/// id is removed so it cannot load alongside the renamed plugin. The package
/// dir is host-seeded code (user data lives under `plugins-data/`), so
/// removing it loses nothing; only a manifest that really declares the old id
/// is touched.
fn migrate_renamed_plugin(app_data_dir: &Path, old_id: &str, new_id: &str) {
    // 1. Data dir: plugins-data/<old> -> plugins-data/<new>.
    let data_from = app_data_dir.join(DATA_DIR).join(old_id);
    if data_from.is_dir() {
        let data_to = app_data_dir.join(DATA_DIR).join(new_id);
        if !data_to.exists() {
            match std::fs::rename(&data_from, &data_to) {
                Ok(()) => {
                    println!("[plugins] migrated plugins-data/{old_id} to plugins-data/{new_id}")
                }
                Err(e) => eprintln!("[plugins] rename data dir {old_id} -> {new_id}: {e}"),
            }
        } else {
            // Both exist: keep the new one, retire the old out of the way
            // (same retire-not-delete rule as the legacy migrations).
            let retired = data_from.with_extension("migrated");
            let _ = std::fs::rename(&data_from, &retired);
        }
    }
    // 2. Stale seeded package still carrying the old manifest id.
    let pkg = app_data_dir.join(PLUGINS_DIR).join(old_id);
    let manifest = pkg.join("manifest.json");
    let declares_old = std::fs::read_to_string(&manifest)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(|s| s == old_id))
        .unwrap_or(false);
    if declares_old {
        match std::fs::remove_dir_all(&pkg) {
            Ok(()) => {
                println!("[plugins] removed stale {old_id} package (plugin renamed to {new_id})")
            }
            Err(e) => eprintln!("[plugins] remove stale {old_id} package: {e}"),
        }
    }
}

/// One-time migration: legacy single-file feature storage moves into the
/// owning plugin's data dir. The original is renamed `*.migrated`, never
/// deleted, so a rollback only needs a rename back.

/// The pre-split voice plugin (one package owning TTS + STT) was replaced by
/// the separate `tts` and `stt` plugins in the same release. Clean cut, no
/// state migration: b.anything the old id seeded/owned is retired so the
/// stale installed copy can't resurrect the old sidebar tab or double-register
/// providers next to the new plugins.
fn migrate_replaced_plugin(app_data_dir: &Path, old_id: &str) {
    // Stale seed copies: remove any package dir whose manifest still
    // declares the old id. Removed, not renamed — a renamed copy would still
    // be discovered (its manifest.json keeps declaring the old id). The dir
    // is a seed copy without user data (voice-owned state lived under
    // plugins-data/).
    let candidates = [
        app_data_dir.join(PLUGINS_DIR).join(old_id),
        app_data_dir
            .join(PLUGINS_DIR)
            .join(format!("{old_id}.migrated")),
    ];
    for pkg in candidates {
        if !pkg.is_dir() {
            continue;
        }
        let manifest_ok = std::fs::read(pkg.join("manifest.json"))
            .ok()
            .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
            .and_then(|m| {
                m.get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(|id| id == old_id)
            })
            .unwrap_or(false);
        if manifest_ok {
            match std::fs::remove_dir_all(&pkg) {
                Ok(()) => println!("[plugins] retired replaced plugin package: {old_id}"),
                Err(e) => eprintln!("[plugins] retire {old_id} at {}: {e}", pkg.display()),
            }
        }
    }

    // Config entry + tombstone: the ids no longer exist.
    let config_path = app_data_dir.join(CONFIG_FILE);
    let config_changed = std::fs::read(&config_path)
        .ok()
        .and_then(|raw| serde_json::from_slice::<BTreeMap<String, bool>>(&raw).ok())
        .map(|mut config| {
            let had_voice = config.remove(old_id).is_some();
            if had_voice {
                if let Ok(json) = serde_json::to_vec(&config) {
                    let _ = std::fs::write(&config_path, json);
                }
            }
            had_voice
        })
        .unwrap_or(false);
    if config_changed {
        println!("[plugins] pruned replaced plugin config entry: {old_id}");
    }
    let removed_path = app_data_dir.join(REMOVED_FILE);
    let removed_changed = std::fs::read(&removed_path).ok().and_then(|raw| {
        let mut ids: HashSet<String> = serde_json::from_slice(&raw).unwrap_or_default();
        let had = ids.remove(old_id);
        if had {
            Some((
                serde_json::to_vec(&ids).unwrap_or_else(|_| raw.clone()),
                true,
            ))
        } else {
            None
        }
    });
    if let Some((json, _)) = removed_changed {
        let _ = std::fs::write(&removed_path, json);
        println!("[plugins] pruned replaced plugin tombstone: {old_id}");
    }
    let _ = config_changed; // already handled above

    // Per-plugin data dir/file: voice never wrote one, but retire defensively
    // so stray state doesn't linger under the old id.
    for name in [format!("{old_id}.json"), format!("{old_id}.json.migrated")] {
        let path = app_data_dir.join(DATA_DIR).join(name);
        if path.exists() {
            let _ = std::fs::rename(
                &path,
                path.with_file_name(format!("{old_id}.json.migrated")),
            );
        }
    }
    let data_dir = app_data_dir.join(DATA_DIR).join(old_id);
    if data_dir.is_dir() {
        let _ = std::fs::rename(
            &data_dir,
            data_dir.with_file_name(format!("{old_id}.migrated")),
        );
    }
}

fn migrate_legacy_file(app_data_dir: &Path, legacy: &str, plugin_id: &str, target: &str) {
    let from = app_data_dir.join(legacy);
    if !from.exists() {
        return;
    }
    let to_dir = app_data_dir.join(DATA_DIR).join(plugin_id);
    if let Err(e) = std::fs::create_dir_all(&to_dir) {
        eprintln!("[plugins] migrate {legacy}: create dir: {e}");
        return;
    }
    let to = to_dir.join(target);
    let retire = || {
        let _ = std::fs::rename(&from, from.with_extension("migrated"));
    };
    if to.exists() {
        // Plugin already owns data; keep it and retire the legacy file.
        retire();
        return;
    }
    if let Err(e) = std::fs::copy(&from, &to) {
        eprintln!("[plugins] migrate {legacy} -> {plugin_id}: {e}");
        return;
    }
    retire();
    println!("[plugins] migrated {legacy} into plugins-data/{plugin_id}/{target}");
}
