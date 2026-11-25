// Cross-window console log sink: every webview's console capture (app/src/
// logs.ts) funnels its lines here so the Settings > Logs panel can read the
// whole app's output. Console logs are per-webview otherwise — the settings
// window would never see the main window's (or a loaded plugin's) lines, and
// release builds have no devtools at all.
//
// The sink is a bounded in-memory ring buffer, not a file: it exists to be
// glanced at while debugging, and the panel can copy everything out of it.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, WebviewWindow};

const CAP: usize = 2000;
const EVENT_NEW: &str = "log-entry";
const EVENT_CLEARED: &str = "log-cleared";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// Epoch millis — the panel renders local time from it.
    pub ts: i64,
    /// "info" | "warn" | "error".
    pub level: String,
    /// Emitting webview label ("main", "settings", virtual "web").
    pub source: String,
    pub message: String,
}

fn buffer() -> &'static Mutex<VecDeque<LogEntry>> {
    static BUF: OnceLock<Mutex<VecDeque<LogEntry>>> = OnceLock::new();
    BUF.get_or_init(|| Mutex::new(VecDeque::with_capacity(CAP)))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn push_entry(app: &AppHandle, level: String, source: String, message: String) {
    let entry = LogEntry {
        ts: now_ms(),
        level,
        source,
        message,
    };
    {
        // A poisoned lock (a panic while holding it) must not take logging
        // down: recover the data and keep going.
        let mut buf = buffer().lock().unwrap_or_else(|p| p.into_inner());
        if buf.len() >= CAP {
            buf.pop_front();
        }
        buf.push_back(entry.clone());
    }
    // Fire-and-forget: a panel without listeners (or a wedged window) must
    // never stall the logging webview.
    let _ = app.emit(EVENT_NEW, &entry);
}

/// Called from each webview's console capture. The invoking window label is
/// the entry's source, so panel lines say where they came from.
#[tauri::command]
pub fn log_push(window: WebviewWindow, app: AppHandle, level: String, message: String) {
    push_entry(&app, level, window.label().to_string(), message);
}

#[tauri::command]
pub fn log_recent() -> Vec<LogEntry> {
    buffer()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .cloned()
        .collect()
}

#[tauri::command]
pub fn log_clear(app: AppHandle) {
    buffer().lock().unwrap_or_else(|p| p.into_inner()).clear();
    // Open panels drop their local copies too, so clear is really clear.
    let _ = app.emit(EVENT_CLEARED, ());
}

/// Bridge entry for browser pages: same sink, virtual "web" source.
pub fn log_push_web(app: &AppHandle, level: String, message: String) {
    push_entry(app, level, "web".to_string(), message);
}
