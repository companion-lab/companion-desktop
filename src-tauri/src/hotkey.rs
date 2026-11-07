use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub struct HotkeyState {
    current: Mutex<Option<String>>,
}

impl HotkeyState {
    fn new() -> Self {
        HotkeyState {
            current: Mutex::new(None),
        }
    }
}

pub fn init_state() -> HotkeyState {
    HotkeyState::new()
}

fn normalize(shortcut: &str) -> String {
    let mut mods: Vec<&str> = Vec::new();
    let mut key = String::new();
    for part in shortcut.split('+') {
        let p = part.trim();
        let l = p.to_lowercase();
        if l == "ctrl" || l == "control" {
            if !mods.contains(&"Ctrl") {
                mods.push("Ctrl");
            }
        } else if l == "shift" {
            if !mods.contains(&"Shift") {
                mods.push("Shift");
            }
        } else if l == "alt" {
            if !mods.contains(&"Alt") {
                mods.push("Alt");
            }
        } else if ["meta", "cmd", "command", "super"].contains(&l.as_str()) {
            if !mods.contains(&"Meta") {
                mods.push("Meta");
            }
        } else if !p.is_empty() {
            key = if p.len() == 1 { p.to_uppercase() } else { p.to_string() };
        }
    }
    let order = ["Ctrl", "Shift", "Alt", "Meta"];
    mods.sort_by_key(|m| order.iter().position(|o| o == m).unwrap_or(99));
    if key.is_empty() {
        mods.join("+")
    } else {
        mods.into_iter()
            .chain(std::iter::once(key.as_str()))
            .collect::<Vec<_>>()
            .join("+")
    }
}

fn emit_mic_toggle(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit("mic-toggle", ());
    }
}

pub fn register_shortcut(app: &tauri::AppHandle, shortcut: &str) -> Result<String, String> {
    let norm = normalize(shortcut);
    if norm.is_empty() {
        return Err("Shortcut needs a key (e.g. Ctrl+Shift+M)".into());
    }
    let parsed: Shortcut = norm.parse::<Shortcut>().map_err(|e| format!("invalid shortcut: {e}"))?;
    let ext = app.global_shortcut();
    ext.register(parsed).map_err(|e| format!("register shortcut: {e}"))?;
    Ok(norm)
}

pub fn unregister_shortcut(app: &tauri::AppHandle, shortcut: &str) {
    if let Ok(parsed) = shortcut.parse::<Shortcut>() {
        let _ = app.global_shortcut().unregister(parsed);
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_mic_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, HotkeyState>,
    shortcut: String,
) -> Result<String, String> {
    let norm = normalize(&shortcut);
    let mut guard = state.current.lock().map_err(|e| e.to_string())?;
    if guard.as_deref() == Some(norm.as_str()) {
        return Ok(norm);
    }
    if let Some(prev) = guard.take() {
        unregister_shortcut(&app, &prev);
    }
    match register_shortcut(&app, &norm) {
        Ok(ok) => {
            *guard = Some(ok.clone());
            println!("mic shortcut: {ok}");
            Ok(ok)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_mic_shortcut(state: tauri::State<'_, HotkeyState>) -> Result<Option<String>, String> {
    state.current.lock().map(|g| g.clone()).map_err(|e| e.to_string())
}

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                emit_mic_toggle(app);
            }
        })
        .build()
}
