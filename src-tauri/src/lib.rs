#![allow(unexpected_cfgs)]

mod click_through;
mod plugin_host;
mod updater;

use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        // Global shortcuts are registered from plugin frontends (e.g. the stt
        // plugin's mic toggle) through the JS API — the host only provides the
        // plugin and the capability permissions, no fixed handler.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Update flow: opens the downloaded installer / release page with the
        // OS handler. Called from updater's Rust commands only, so no
        // capability permissions are needed for it.
        .plugin(tauri_plugin_opener::init())
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
                    // Startup default: follow all Spaces (users can turn it
                    // off in Settings > General, applied from the webview).
                    set_join_all_spaces(&win, true);
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
            updater::check_for_update,
            updater::download_update,
            updater::open_update_installer,
            updater::open_url,
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
            cursor_global,
            window_set_follow_spaces,
            click_through::windowing_backend,
            click_through::set_click_through_exclusions,
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
    // WebviewUrl::App resolves per runtime mode — the dev server under
    // `tauri dev` (custom-protocol feature off), the embedded frontendDist in
    // built bundles (feature on). A manual dev_url check here would send
    // every bundled debug build to the not-running dev server: a blank
    // window.
    tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        tauri::WebviewUrl::App("settings.html".into()),
    )
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
/// animation and IPC loops. Toggleable at runtime via
/// `window_set_follow_spaces` (Settings > General) and from the plugin API.
#[cfg(target_os = "macos")]
fn set_join_all_spaces(win: &tauri::WebviewWindow, join: bool) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSWindowCollectionBehavior;
    unsafe {
        let ns_window = win.ns_window().expect("ns_window") as *mut AnyObject;
        let before: usize = msg_send![ns_window, collectionBehavior];
        let flags = NSWindowCollectionBehavior::CanJoinAllSpaces.bits()
            | NSWindowCollectionBehavior::FullScreenAuxiliary.bits();
        let behavior = if join { before | flags } else { before & !flags };
        let _: () = msg_send![ns_window, setCollectionBehavior: behavior];
        let after: usize = msg_send![ns_window, collectionBehavior];
        if after != before {
            println!("[main] collectionBehavior {before:#b} -> {after:#b}");
        }
    }
}

/// Toggle the macOS "follow every Space / fullscreen" behavior of the main
/// window at runtime. No-op on other platforms (the pref is still accepted so
/// callers don't need platform branches).
#[tauri::command(rename_all = "snake_case")]
fn window_set_follow_spaces(app: tauri::AppHandle, join: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let win = app
            .get_webview_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        set_join_all_spaces(&win, join);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, join);
        Ok(())
    }
}

/// Shared probe behind both cursor commands: the cursor position in
/// window-relative CSS coordinates (top-left origin) plus the window's CSS
/// size. (x, y) is NOT clamped to the window — it may be negative or beyond
/// the size when the cursor is outside it, even on another display. None
/// means no reading is available: probe failure or an unsupported
/// platform/session (Wayland).
#[allow(clippy::too_many_lines)]
fn cursor_css_unclamped(app: &tauri::AppHandle) -> Option<(f64, f64, f64, f64)> {
    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2_foundation::{NSPoint, NSRect};

        let win = app.get_webview_window("main")?;
        unsafe {
            let ns_window = win.ns_window().ok()? as *mut objc2::runtime::AnyObject;
            let frame: NSRect = msg_send![ns_window, frame];
            let mouse: NSPoint = msg_send![objc2::class!(NSEvent), mouseLocation];

            // Window-relative top-left CSS coordinates (points == CSS px on
            // macOS). Cocoa: bottom-left origin.
            let local_x = mouse.x - frame.origin.x;
            let local_y = (frame.origin.y + frame.size.height) - mouse.y;
            Some((local_x, local_y, frame.size.width, frame.size.height))
        }
    }
    #[cfg(target_os = "windows")]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};

        #[repr(C)]
        struct WinPoint {
            x: i32,
            y: i32,
        }
        #[repr(C)]
        struct WinRect {
            left: i32,
            top: i32,
            right: i32,
            bottom: i32,
        }
        #[link(name = "user32")]
        extern "system" {
            fn GetCursorPos(lp_point: *mut WinPoint) -> i32;
            fn GetWindowRect(hwnd: *mut std::ffi::c_void, lp_rect: *mut WinRect) -> i32;
        }

        let win = app.get_webview_window("main")?;
        let hwnd = match win.window_handle().ok()?.as_raw() {
            RawWindowHandle::Win32(h) => h.hwnd.get() as *mut std::ffi::c_void,
            _ => return None,
        };
        unsafe {
            let mut cursor = WinPoint { x: 0, y: 0 };
            let mut rect = WinRect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if GetCursorPos(&mut cursor) == 0 || GetWindowRect(hwnd, &mut rect) == 0 {
                return None;
            }
            // Tauri is per-monitor DPI aware (tao opts in at startup), so
            // GetCursorPos/GetWindowRect report physical pixels; CSS px is
            // physical / scale. For the undecorated window the client area is
            // the whole window rect and the webview fills it, so the rect's
            // top-left is CSS (0, 0).
            let scale = win.scale_factor().ok()?;
            if scale <= 0.0 {
                return None;
            }
            Some((
                (cursor.x - rect.left) as f64 / scale,
                (cursor.y - rect.top) as f64 / scale,
                (rect.right - rect.left) as f64 / scale,
                (rect.bottom - rect.top) as f64 / scale,
            ))
        }
    }
    #[cfg(target_os = "linux")]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use std::os::raw::c_ulong;

        // Wayland exposes no global cursor position to regular clients
        // (wl_pointer only speaks in per-surface positions), and XWayland's X
        // cursor goes stale while the pointer is over native Wayland windows:
        // report None instead of coordinates that freeze the gaze at a stale
        // point.
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            return None;
        }

        let win = app.get_webview_window("main")?;
        // XID of the GTK toplevel: it is the webview's client area, its origin
        // maps to CSS (0, 0). GTK on X11 yields an Xlib window; Xcb as an
        // equally valid fallback.
        let xid = match win.window_handle().ok()?.as_raw() {
            RawWindowHandle::Xlib(h) => h.window,
            RawWindowHandle::Xcb(h) => h.window.get() as c_ulong,
            _ => return None,
        };

        // x11-dl dlopens libX11 at runtime, so a session without it (or
        // without the client library) just reports None.
        let xlib = match x11_dl::xlib::Xlib::open() {
            Ok(xlib) => xlib,
            Err(_) => return None,
        };
        unsafe {
            let display = (xlib.XOpenDisplay)(std::ptr::null_mut());
            if display.is_null() {
                return None;
            }

            // The default screen's root spans every monitor (RandR), so root
            // coordinates are global across displays — the same notion of
            // "global" the other platforms read.
            let root = (xlib.XDefaultRootWindow)(display);
            let mut cursor_root = (0i32, 0i32);
            let mut win_local = (0i32, 0i32);
            let mut root_return: c_ulong = 0;
            let mut child_return: c_ulong = 0;
            let mut mask = 0u32;
            let on_screen = (xlib.XQueryPointer)(
                display,
                root,
                &mut root_return,
                &mut child_return,
                &mut cursor_root.0,
                &mut cursor_root.1,
                &mut win_local.0,
                &mut win_local.1,
                &mut mask,
            ) != 0;
            let mut win_origin = (0i32, 0i32);
            let mut dest_child: c_ulong = 0;
            (xlib.XTranslateCoordinates)(
                display,
                xid,
                root,
                0,
                0,
                &mut win_origin.0,
                &mut win_origin.1,
                &mut dest_child,
            );
            let mut attrs = std::mem::zeroed::<x11_dl::xlib::XWindowAttributes>();
            let sized = (xlib.XGetWindowAttributes)(display, xid, &mut attrs) != 0;
            (xlib.XCloseDisplay)(display);
            if !on_screen || !sized {
                return None;
            }

            // X pixels are physical; CSS px is physical / scale (also covers
            // the integer GDK scale typical on X11; anything else is rare and
            // GTK itself is no better there).
            let scale = win.scale_factor().ok()?;
            if scale <= 0.0 {
                return None;
            }
            Some((
                (cursor_root.0 - win_origin.0) as f64 / scale,
                (cursor_root.1 - win_origin.1) as f64 / scale,
                attrs.width as f64 / scale,
                attrs.height as f64 / scale,
            ))
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = app;
        None
    }
}

/// Returns the cursor position in window-local CSS coordinates, or None if the
/// cursor is outside the main window. Computed entirely in Rust using the
/// window's native frame, avoiding Tauri's (buggy on secondary monitors)
/// coordinate conversion between outerPosition() and cursorPosition(). Shares
/// the probe with cursor_global; only the None-outside contract is kept here
/// for the click-through check.
#[tauri::command]
fn cursor_window_local(app: tauri::AppHandle) -> Option<(f64, f64, f64, f64)> {
    let (x, y, w, h) = cursor_css_unclamped(&app)?;
    if x >= 0.0 && y >= 0.0 && x < w && y < h {
        Some((x, y, w, h))
    } else {
        None
    }
}

/// Like cursor_window_local, but the coordinates are NOT clamped to the main
/// window: (x, y) is relative to the window's top-left and may be negative or
/// beyond the window size when the cursor is outside it (e.g. on another
/// display). Callers that need to distinguish "outside the window" must check
/// the bounds themselves — cursor_window_local keeps its None-outside contract
/// for the click-through probe.
#[tauri::command]
fn cursor_global(app: tauri::AppHandle) -> Option<(f64, f64, f64, f64)> {
    cursor_css_unclamped(&app)
}
