import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const BASE_WIDTH = 480;
export const BASE_HEIGHT = 750;

export type WindowSize = { width: number; height: number };

// Smallest scale the slider offers. Must match minWidth/minHeight in tauri.conf.json:
// without an explicit min, GTK pins min to the content requisition and silently
// ignores shrink requests (see gtk_window_compute_hints).
export const MIN_SCALE = 0.5;
export const MIN_WIDTH = Math.round(BASE_WIDTH * MIN_SCALE);
export const MIN_HEIGHT = Math.round(BASE_HEIGHT * MIN_SCALE);

export function sizeForScale(scale: number): WindowSize {
  const s = Math.max(MIN_SCALE, scale);
  return {
    width: Math.round(BASE_WIDTH * s),
    height: Math.round(BASE_HEIGHT * s),
  };
}

export function scaleForSize(size: WindowSize): number {
  return size.width / BASE_WIDTH;
}

/**
 * GTK derives min size from content when none is set, so lower the floor before
 * every resize. Failures are logged, not swallowed: a silent reject looks
 * identical to the bug this guards against.
 */
export async function applyWindowSize(size: WindowSize): Promise<void> {
  const target = getCurrentWindow();
  const win = target.label === "main" ? target : await WebviewWindow.getByLabel("main");
  if (!win) {
    console.warn("applyWindowSize: main window not found", size);
    return;
  }
  try {
    await win.setMinSize(new LogicalSize(MIN_WIDTH, MIN_HEIGHT));
    await win.setSize(new LogicalSize(size.width, size.height));
  } catch (e) {
    console.error("applyWindowSize failed", size, e);
  }
}