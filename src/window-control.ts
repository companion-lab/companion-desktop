// Window layout control for the main (companion) window: position restore,
// corner snapping, always-on-top, and macOS follow-Spaces. Shared by the host
// (App.tsx startup + settings broadcasts) and the plugin API surface
// (ctx.window), so both behave identically.
//
// Every helper routes to the main window no matter which webview calls it
// (same routing as applyWindowSize in window-size.ts): the settings window
// and plugin frontends running there still control the pet window.

import { PhysicalPosition, LogicalPosition } from "@tauri-apps/api/dpi";
import {
  currentMonitor,
  availableMonitors,
  getCurrentWindow,
  type Window,
} from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import type { WindowAnchor, WindowPrefs } from "./events";
import { loadWindowPrefs, updateWindowPrefs } from "./window-prefs";

/** CSS-pixel gap between the window and the monitor's work-area edge when
 *  snapping to a corner. */
const SNAP_MARGIN = 16;

/** Resolve the main window from any webview (current window when we ARE the
 *  main window, else the shared `main` instance). Null outside Tauri. */
export async function getMainWindow(): Promise<Window | null> {
  const current = getCurrentWindow();
  if (current.label === "main") return current;
  try {
    return (await WebviewWindow.getByLabel("main")) ?? null;
  } catch {
    return null;
  }
}

/** Is this physical point on any connected monitor? Used to reject a saved
 *  position whose monitor no longer exists (unplugged, dock change). */
async function positionOnAnyMonitor(
  pos: { x: number; y: number },
): Promise<boolean> {
  try {
    const monitors = await availableMonitors();
    return monitors.some(
      (m) =>
        pos.x >= m.position.x &&
        pos.x < m.position.x + m.size.width &&
        pos.y >= m.position.y &&
        pos.y < m.position.y + m.size.height,
    );
  } catch {
    return false;
  }
}

/**
 * Place the window at its remembered spot at startup: the snap anchor wins
 * when one was chosen, else the last dragged position (validated against
 * currently connected monitors). Failures are logged, never thrown — a
 * layout restore must not break startup.
 */
export async function restoreWindowLayout(prefs: WindowPrefs): Promise<void> {
  try {
    if (prefs.anchor !== "free") {
      await snapToAnchor(prefs.anchor);
      return;
    }
    if (!prefs.rememberPosition || !prefs.savedPosition) return;
    const saved = prefs.savedPosition;
    if (!(await positionOnAnyMonitor(saved))) {
      console.warn("restoreWindowLayout: saved position off-screen, ignoring", saved);
      return;
    }
    const win = await getMainWindow();
    if (!win) return;
    await win.setPosition(new PhysicalPosition(saved.x, saved.y));
  } catch (e) {
    console.warn("restoreWindowLayout failed", e);
  }
}

/**
 * Move the main window to `anchor` of the current monitor's work area
 * (taskbar-aware; falls back to the raw monitor bounds). `center` centers
 * within the work area.
 */
export async function snapToAnchor(anchor: WindowAnchor): Promise<void> {
  const win = await getMainWindow();
  if (!win) return;
  try {
    const mon = (await currentMonitor()) ?? (await availableMonitors())[0];
    if (!mon) return;
    const wa = {
      x: mon.workArea?.position.x ?? mon.position.x,
      y: mon.workArea?.position.y ?? mon.position.y,
      w: mon.workArea?.size.width ?? mon.size.width,
      h: mon.workArea?.size.height ?? mon.size.height,
    };
    const size = await win.outerSize(); // undecorated window: outer == inner
    const scale = (await win.scaleFactor()) || 1;
    const margin = Math.round(SNAP_MARGIN * scale);

    let x: number;
    let y: number;
    if (anchor === "center") {
      x = wa.x + Math.round((wa.w - size.width) / 2);
      y = wa.y + Math.round((wa.h - size.height) / 2);
    } else {
      x =
        anchor.includes("left")
          ? wa.x + margin
          : wa.x + wa.w - size.width - margin;
      y =
        anchor.includes("top") ? wa.y + margin : wa.y + wa.h - size.height - margin;
    }
    await win.setPosition(new PhysicalPosition(x, y));
  } catch (e) {
    console.warn("snapToAnchor failed", anchor, e);
  }
}

/** Apply the non-position behavior prefs: always-on-top and macOS
 *  follow-Spaces. Called at startup and on `window-prefs-changed` diffs. */
export async function applyWindowBehavior(prefs: WindowPrefs): Promise<void> {
  try {
    const win = await getMainWindow();
    if (win) await win.setAlwaysOnTop(prefs.alwaysOnTop);
  } catch (e) {
    console.warn("applyWindowBehavior: setAlwaysOnTop failed", e);
  }
  try {
    await invoke("window_set_follow_spaces", { join: prefs.followSpaces });
  } catch (e) {
    console.warn("applyWindowBehavior: follow-spaces failed", e);
  }
}

/** Debounced position tracking: read the current position and store it as
 *  `savedPosition`. Respects `rememberPosition`; no-ops until startup layout
 *  restore finished (so pre-restore OS placement can't overwrite the record). */
let positionTrackingArmed = false;

export function armPositionTracking(): void {
  positionTrackingArmed = true;
}

export async function persistCurrentPosition(): Promise<void> {
  if (!positionTrackingArmed) return;
  try {
    const prefs = loadWindowPrefs();
    if (!prefs.rememberPosition) return;
    const win = await getMainWindow();
    if (!win) return;
    const pos = await win.outerPosition(); // physical px
    updateWindowPrefs({ savedPosition: { x: pos.x, y: pos.y } });
  } catch (e) {
    console.warn("persistCurrentPosition failed", e);
  }
}

// ---------------------------------------------------------------------------
// Click-through runtime override (ctx.window.setClickThrough)
// ---------------------------------------------------------------------------

// Null = follow the persisted pref; a boolean takes precedence until the next
// startup (plugin changes are runtime-only — user prefs win on relaunch).
let clickThroughOverride: boolean | null = null;

export function setClickThroughOverride(on: boolean): void {
  clickThroughOverride = on;
}

/** Effective click-through state: the plugin override, else the user pref. */
export function clickThroughEnabled(prefs: WindowPrefs): boolean {
  return clickThroughOverride ?? prefs.clickThrough;
}

// ---------------------------------------------------------------------------
// Shared conversions for the plugin API surface (ctx.window)
// ---------------------------------------------------------------------------

/** Outer position of the main window in logical (CSS) pixels. */
export async function mainWindowLogicalPosition(): Promise<LogicalPosition> {
  const win = await getMainWindow();
  if (!win) return new LogicalPosition(0, 0);
  const pos = await win.outerPosition();
  const scale = (await win.scaleFactor()) || 1;
  return pos.toLogical(scale);
}

/** Outer size of the main window in logical (CSS) pixels. */
export async function mainWindowLogicalSize(): Promise<{
  width: number;
  height: number;
}> {
  const win = await getMainWindow();
  if (!win) return { width: 0, height: 0 };
  const size = await win.outerSize();
  const scale = (await win.scaleFactor()) || 1;
  return size.toLogical(scale);
}
