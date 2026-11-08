#![allow(unexpected_cfgs)]

mod plugin_host;

use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        // Global shortcuts are registered from plugin frontends (e.g. the stt
        // plugin's mic toggle) through the JS API — the host only provides the
        // plugin and the capability permissions, no fixed handler.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // Show the main window before any plugin work: its webview page
            // is already loading, so first visibility shouldn't wait on
            // plugin dylib loading and backend init (the window is
            // transparent, so there's no flash — just a sooner dock icon).
            if let Some(win) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                make_transparent(&win);
                let _ = win.show();
                #[cfg(target_os = "macos")]
                {
                    join_all_spaces(&win);
                    println!("[main] join_all_spaces applied");
                }
            }

            // Discover and load plugin packages (app data + dev plugins dir)
            app.manage(plugin_host::init_state(app.handle()));

            // Warm the settings webview so its first open is instant — but a
            // beat later, off the boot path: a second webview spawning while
            // the main one does its first load steals resources from the
            // window the user is actually waiting on.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                if let Err(e) = build_settings_window(&handle, false) {
                    eprintln!("settings prewarm failed: {e}");
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Keep the settings webview warm: closing its window hides it
            // instead of destroying it, so reopening is instant. If the main
            // window is already gone, let the close through so the app exits.
            WindowEvent::CloseRequested { api, .. } if window.label() == "settings" => {
                if window.app_handle().get_webview_window("main").is_some() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            // The settings window may be parked hidden; don't let it keep a
            // zombie app alive once the main window is gone. Visibility is
            // probed off-thread: window getters block on the event loop and
            // deadlock when called from inside an event callback.
            WindowEvent::Destroyed if window.label() == "main" => {
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    let settings_visible = app
                        .get_webview_window("settings")
                        .and_then(|s| s.is_visible().ok())
                        .unwrap_or(false);
                    if !settings_visible {
                        app.exit(0);
                    }
                });
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            open_settings,
            restart_app,
            quit_app,
            open_devtools,
            secret_set,
            secret_get,
            secret_delete,
            plugin_host::commands::plugin_list,
            plugin_host::commands::plugin_call,
            plugin_host::commands::plugin_list_tools,
            plugin_host::commands::plugin_set_enabled,
            plugin_host::commands::plugin_read_frontend,
            plugin_host::commands::plugin_storage_get,
            plugin_host::commands::plugin_storage_set,
            plugin_host::commands::plugin_import_archive,
            plugin_host::commands::plugin_delete,
            plugin_host::commands::plugin_restore_bundled,
            cursor_window_local,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command(rename_all = "snake_case")]
fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    // The window is pre-created hidden at startup and kept alive on close, so
    // the common path is just revealing an already-loaded webview.
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    build_settings_window(&app, true)
}

/// Create the settings webview. Called hidden at startup to warm the page and
/// on demand if the window was never created or got destroyed.
fn build_settings_window(app: &tauri::AppHandle, visible: bool) -> Result<(), String> {
    let is_dev = cfg!(debug_assertions) && app.config().build.dev_url.is_some();
    let url = if is_dev {
        let dev_url = app.config().build.dev_url.as_ref().unwrap();
        let base = dev_url.to_string().trim_end_matches('/').to_string();
        tauri::WebviewUrl::External(format!("{base}/settings.html").parse().map_err(|e: url::ParseError| e.to_string())?)
    } else {
        tauri::WebviewUrl::App("settings.html".into())
    };

    tauri::WebviewWindowBuilder::new(app, "settings", url)
        .title("Settings")
        .inner_size(780.0, 580.0)
        .min_inner_size(780.0, 580.0)
        .max_inner_size(780.0, 580.0)
        .resizable(false)
        .decorations(true)
        .visible(visible)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
fn restart_app(app: tauri::AppHandle) {
    app.request_restart();
}

/// Quit for real: closes every window, including the parked/visible settings
/// window (closing the main window alone intentionally leaves the app alive
/// when settings is open).
#[tauri::command(rename_all = "snake_case")]
fn quit_app(app: tauri::AppHandle) {
    // Exit off the IPC dispatch thread. Calling app.exit() synchronously here
    // queues an exit request the macOS event loop never processes (commands
    // run inside the webview's scheme-handler dispatch, and the run loop
    // doesn't get back to queued runtime messages in that state), leaving the
    // app alive with every window — including settings — still on screen.
    // A short delay also lets the IPC response land before the process dies.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(100));
        app.exit(0);
    });
}

#[tauri::command(rename_all = "snake_case")]
fn open_devtools(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        window.open_devtools();
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = window;
        Err("DevTools are only available in debug builds".into())
    }
}

const KEYRING_SERVICE: &str = "dev.fl.companion";
const KEYRING_ACCOUNT: &str = "api-key";

fn keyring_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, account).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
fn secret_set(value: String, name: Option<String>) -> Result<(), String> {
    if value.is_empty() {
        return secret_delete(name);
    }
    let account = name.as_deref().unwrap_or(KEYRING_ACCOUNT);
    let entry = keyring_entry(account)?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
fn secret_get(name: Option<String>) -> Result<Option<String>, String> {
    let account = name.as_deref().unwrap_or(KEYRING_ACCOUNT);
    let entry = keyring_entry(account)?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command(rename_all = "snake_case")]
fn secret_delete(name: Option<String>) -> Result<(), String> {
    let account = name.as_deref().unwrap_or(KEYRING_ACCOUNT);
    let entry = keyring_entry(account)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(target_os = "macos")]
fn make_transparent(win: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyClass;
    use objc2::runtime::AnyObject;
    unsafe {
        let ns_view = win.ns_view().expect("ns_view") as *mut AnyObject;
        let ns_color_class = AnyClass::get(c"NSColor").expect("NSColor");
        let clear: *mut AnyObject = msg_send![ns_color_class, clearColor];
        let _: () = msg_send![ns_view, setBackgroundColor: clear];
        let _: () = msg_send![ns_view, setOpaque: false];
    }
}

/// Desktop-pet behavior: the overlay follows every Space (and coexists with
/// fullscreen apps) instead of being stranded on the Space it spawned on —
/// an avatar stuck behind a fullscreen window stops painting entirely
/// (WebKit suspends rendering for occluded windows), which also starves its
/// animation and IPC loops.
#[cfg(target_os = "macos")]
fn join_all_spaces(win: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSWindowCollectionBehavior;
    unsafe {
        let ns_window = win.ns_window().expect("ns_window") as *mut AnyObject;
        let before: usize = msg_send![ns_window, collectionBehavior];
        let behavior = before
            | NSWindowCollectionBehavior::CanJoinAllSpaces.bits()
            | NSWindowCollectionBehavior::FullScreenAuxiliary.bits();
        let _: () = msg_send![ns_window, setCollectionBehavior: behavior];
        let after: usize = msg_send![ns_window, collectionBehavior];
        println!(
            "[main] collectionBehavior {before:#b} -> {after:#b} (want CanJoinAllSpaces={:b}, FullScreenAuxiliary={:b})",
            NSWindowCollectionBehavior::CanJoinAllSpaces.bits(),
            NSWindowCollectionBehavior::FullScreenAuxiliary.bits(),
        );
    }
}

/// Returns the cursor position in window-local CSS coordinates, or None if the
/// cursor is outside the main window. Computed entirely in Rust using the
/// NSWindow frame, avoiding Tauri's (buggy on secondary monitors) coordinate
/// conversion between outerPosition() and cursorPosition().
#[tauri::command]
fn cursor_window_local(app: tauri::AppHandle) -> Option<(f64, f64, f64, f64)> {
    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2_foundation::{NSPoint, NSRect};

        let win = app.get_webview_window("main")?;
        unsafe {
            let ns_window = win.ns_window().ok()? as *mut objc2::runtime::AnyObject;
            let frame: NSRect = msg_send![ns_window, frame];
            let mouse: NSPoint = msg_send![objc2::class!(NSEvent), mouseLocation];

            // Cursor outside the window frame (Cocoa: bottom-left origin).
            if mouse.x < frame.origin.x
                || mouse.x > frame.origin.x + frame.size.width
                || mouse.y < frame.origin.y
                || mouse.y > frame.origin.y + frame.size.height
            {
                return None;
            }

            // Window-local top-left CSS coordinates (points == CSS px on macOS).
            let local_x = mouse.x - frame.origin.x;
            let local_y = (frame.origin.y + frame.size.height) - mouse.y;
            Some((local_x, local_y, frame.size.width, frame.size.height))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        None
    }
}
