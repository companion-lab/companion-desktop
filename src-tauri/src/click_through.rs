// Wayland click-through for the transparent companion window.
//
// macOS, Windows and X11 use the standard `setIgnoreCursorEvents` flow: the
// app polls the global cursor and toggles per-window input capture. Native
// Wayland has no global cursor position for clients, and tao's own
// `set_ignore_cursor_events` applies a GTK input shape that WebKitGTK
// windows never sync to the compositor (GTK3 forwards an input shape only
// during the window's own paint cycle) — clicks keep landing on the window.
//
// So on Wayland the input region is driven directly instead: the webview
// keeps the full input region by default and receives real pointer events;
// when a move lands on fully transparent canvas pixels the frontend asks for
// a small exclusion rect to be cut out of the input region around that point
// (`set_click_through_exclusions`). Clicks over excluded space are then
// routed by the compositor to the window below, and moving back onto the
// model or a DOM overlay fires a fresh pointerenter on the webview, which
// clears the exclusion again.

/// The windowing backend the click-through paths should use: "wayland",
/// "x11", or "other" (macOS / Windows).
#[tauri::command]
pub fn windowing_backend() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            "wayland"
        } else {
            "x11"
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        "other"
    }
}

/// Cut `rects` (window-local CSS px, [x, y, w, h]) out of the main window's
/// input region, or reset it to the whole window when `rects` is None.
/// Wayland only; a no-op elsewhere (the standard `setIgnoreCursorEvents`
/// flow covers X11, macOS and Windows).
#[tauri::command(rename_all = "snake_case")]
pub fn set_click_through_exclusions(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    rects: Option<Vec<[f64; 4]>>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return Ok(());
        }
        // Size and scale are resolved here (dispatching those getters from
        // inside the main-thread closure would deadlock the event loop);
        // only the resolved values move into the GTK closure. The input
        // shape coordinates are GDK application pixels == CSS px.
        let scale = window.scale_factor().unwrap_or(1.0).max(1.0);
        let inner = window.inner_size().map_err(|e| e.to_string())?;
        let (w, h) = (inner.width as f64 / scale, inner.height as f64 / scale);
        // The GTK handle must be fetched (and used) around the main thread:
        // the dispatcher getter runs it on the main thread and returns the
        // handle, which this closure then drives during its own main-thread
        // execution.
        let gtk_win = window.gtk_window().map_err(|e| e.to_string())?;
        app.run_on_main_thread(move || {
            use gtk::prelude::*;

            let Some(gdk_win) = gtk_win.window() else { return };
            let full = cairo::Region::create_rectangle(&cairo::RectangleInt {
                x: 0,
                y: 0,
                width: w.ceil() as i32,
                height: h.ceil() as i32,
            });
            if let Some(rects) = &rects {
                for r in rects {
                    let _ = full.subtract_rectangle(&cairo::RectangleInt {
                        x: r[0] as i32,
                        y: r[1] as i32,
                        width: r[2] as i32,
                        height: r[3] as i32,
                    });
                }
            }
            gdk_win.input_shape_combine_region(&full, 0, 0);
            // GTK3 only forwards the input shape to the compositor during
            // the window's paint cycle — force one now.
            gtk_win.queue_draw();
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, window, rects);
        Ok(())
    }
}
