//! macOS Dock icon context menu (right-click on the Dock tile).
//!
//! AppKit builds that menu by calling the NSApplication delegate's
//! `applicationDockMenu:` method and shows the returned items above its own
//! Options / Show All Windows / Hide / Quit entries. tao — Tauri's windowing
//! layer — installs its own delegate class, which doesn't implement the
//! method, so both it and the menu item's action are added to the delegate's
//! class at runtime via `class_addMethod`.

use std::sync::OnceLock;

use objc2::ffi::class_addMethod;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
use objc2_foundation::NSString;

use crate::show_settings;

/// Handle the menu item's action needs; set during `install`.
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// The menu handed back from `applicationDockMenu:`. The Dock requests it on
/// every right-click, so it is built once in `install` and returned from the
/// cache. objc2 types are !Send, but both touchpoints (setup and the Dock
/// callbacks) run on the main thread — checked via MainThreadMarker in
/// `install`, and AppKit only ever sends Dock-menu callbacks on the main
/// thread.
struct DockMenu(Option<Retained<NSMenu>>);
unsafe impl Send for DockMenu {}
unsafe impl Sync for DockMenu {}
static MENU: OnceLock<DockMenu> = OnceLock::new();

/// Register the Dock menu. Runs in the Tauri setup hook, on the main thread.
pub fn install(app: &tauri::AppHandle) {
    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("[main] dock menu: setup not on main thread, skipping");
        return;
    };

    let _ = APP.set(app.clone());

    unsafe {
        let ns_app = NSApplication::sharedApplication(mtm);
        let delegate: *mut AnyObject = msg_send![&*ns_app, delegate];
        if delegate.is_null() {
            eprintln!("[main] dock menu: no NSApplication delegate, skipping");
            return;
        }

        let item = NSMenuItem::new(mtm);
        item.setTitle(&NSString::from_str("Settings"));
        // Target the delegate explicitly: a nil-target action would be routed
        // through the responder chain and could be swallowed on the way.
        item.setTarget(Some(&*delegate));
        item.setAction(Some(sel!(companionOpenSettings:)));

        let menu = NSMenu::new(mtm);
        menu.insertItem_atIndex(&item, 0);
        // install() runs once per process; a duplicate call would be ignored
        // by OnceLock and the first menu would keep winning.
        let _ = MENU.set(DockMenu(Some(menu)));

        // Both methods AppKit will send, added to the delegate's class.
        // ClassBuilder is only for brand-new classes, so this needs the raw
        // runtime call. It only fails if the class already implements the
        // selector — then whatever is there keeps winning and the item just
        // doesn't appear (logged below).
        //
        // The runtime takes an untyped `Imp`; the signatures above only
        // matter to AppKit's caller, which is described by the `types`
        // strings. fn-pointer casts between differing signatures aren't
        // primitive, hence the transmutes.
        let cls = (*delegate).class() as *const AnyClass as *mut AnyClass;
        let dock_menu_imp = std::mem::transmute::<
            unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut AnyObject,
            Imp,
        >(application_dock_menu
            as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut AnyObject);
        let action_imp = std::mem::transmute::<
            unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
            Imp,
        >(companion_open_settings
            as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject));
        let dock_menu = class_addMethod(cls, sel!(applicationDockMenu:), dock_menu_imp, c"@@:@".as_ptr());
        let action = class_addMethod(cls, sel!(companionOpenSettings:), action_imp, c"v@:@".as_ptr());
        if !(dock_menu.as_bool() && action.as_bool()) {
            eprintln!("[main] dock menu: class_addMethod rejected a selector");
        }
    }
}

/// `applicationDockMenu:` — AppKit calls this on the delegate every time the
/// user right-clicks the Dock icon.
unsafe extern "C-unwind" fn application_dock_menu(
    _this: *mut AnyObject,
    _sel: Sel,
    _sender: *mut AnyObject,
) -> *mut AnyObject {
    match MENU.get().and_then(|m| m.0.as_ref()) {
        Some(menu) => Retained::autorelease_return(menu.clone()) as *mut AnyObject,
        // No menu (shouldn't happen: install() precedes this) — default menu.
        None => std::ptr::null_mut(),
    }
}

/// Action of the "Settings" Dock menu item.
unsafe extern "C-unwind" fn companion_open_settings(
    _this: *mut AnyObject,
    _sel: Sel,
    _sender: *mut AnyObject,
) {
    if let Some(app) = APP.get() {
        if let Err(e) = show_settings(app) {
            eprintln!("[main] dock menu: open settings failed: {e}");
        }
    }
}
