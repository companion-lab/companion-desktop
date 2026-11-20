//! Windows/Linux system-tray icon: the app's right-clickable icon.
//!
//! The pet window skips the taskbar, so on Windows/Linux there is no taskbar
//! button to right-click (and neither platform's taskbar menu supports custom
//! entries anyway). The tray icon fills that role with the same items the
//! macOS Dock menu gives: Settings, Show, Quit. macOS is excluded — the Dock
//! menu (dock_menu.rs) already covers it there.

use tauri::{
    menu::{MenuBuilder, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager,
};

/// Create the tray icon and its menu. Runs in the Tauri setup hook.
///
/// Failures are logged, not fatal: on Linux the icon needs the libappindicator
/// runtime package, and some desktop environments don't show tray icons at
/// all — the app must keep working without it.
pub fn install(app: &tauri::App) -> Result<(), String> {
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let show =
        MenuItem::with_id(app, "show", "Show", true, None::<&str>).map_err(|e| e.to_string())?;
    let quit =
        MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).map_err(|e| e.to_string())?;
    let separator = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;

    let menu = MenuBuilder::new(app)
        .items(&[&settings, &show, &separator, &quit])
        .build()
        .map_err(|e| e.to_string())?;

    let mut builder = TrayIconBuilder::with_id("companion-tray").menu(&menu);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder
        .tooltip("companion")
        .build(app)
        .map_err(|e| e.to_string())?;

    // Dropping the last TrayIcon instance removes the icon; stashing it in
    // app state keeps it alive for the app's lifetime (and makes it
    // retrievable via app.tray_by_id later).
    app.manage(tray);

    Ok(())
}
