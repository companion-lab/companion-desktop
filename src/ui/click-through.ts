import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

// Click-through for the transparent companion window: cursor over an opaque
// model pixel or a DOM overlay captures clicks; cursor over fully transparent
// canvas passes through to the app behind.
//
// macOS delivers no mouse events to a window that ignores cursor events (no
// forwarding in Tauri), so instead of mousemove the state is driven by a poll
// of the global cursor position. Both cursorPosition() and
// document.elementFromPoint() work while events are ignored — they don't
// depend on the window receiving input.

/** Alpha at or above this counts as "something is there" (0-255). Filters
 *  antialiased edge halo without trapping clicks on faint glow. */
export const OPAQUE_ALPHA_THRESHOLD = 16;

type PhysicalPos = { x: number; y: number };

/** Global physical cursor position -> window-local CSS pixels, or null when
 *  the cursor is outside the window. */
export function toLocalCss(
  cursor: PhysicalPos,
  origin: PhysicalPos,
  scaleFactor: number,
  innerSize: PhysicalPos,
): { x: number; y: number } | null {
  if (scaleFactor <= 0) return null;
  const x = (cursor.x - origin.x) / scaleFactor;
  const y = (cursor.y - origin.y) / scaleFactor;
  if (x < 0 || y < 0 || x >= innerSize.x || y >= innerSize.y) return null;
  return { x, y };
}

export type CaptureInput = {
  /** Element under the cursor (document.elementFromPoint), may be null. */
  hit: Element | null;
  /** The interaction canvas itself, for identity comparison. */
  canvas: HTMLCanvasElement | null;
  /** Alpha byte (0-255) of the rendered pixel under the cursor, or null when
   *  it can't be read (no avatar engine, readback failure). */
  alpha: number | null;
};

/** Capture decision: any DOM overlay catches the cursor; on the bare canvas
 *  only rendered (opaque) model pixels do. */
export function shouldCapture({ hit, canvas, alpha }: CaptureInput): boolean {
  if (hit && hit !== canvas) return true;
  if (alpha === null) return true; // can't prove emptiness — stay interactive
  return alpha >= OPAQUE_ALPHA_THRESHOLD;
}

type InitOptions = {
  canvas: () => HTMLCanvasElement | null;
  /** Alpha byte at a window-local CSS point of the avatar engine's render, or
   *  null when no engine is live (the avatar bus no-ops). Runs in the same
   *  webview as the engine, so the query is a plain sync call. */
  alphaAt: (cssX: number, cssY: number) => number | null;
  pollMs?: number;
};

export function initClickThrough({ canvas, alphaAt, pollMs = 90 }: InitOptions): () => void {
  const win = getCurrentWindow();
  let ignoring = false;
  let stopped = false;
  let timer: number | null = null;
  // Last plausible window origin. On a secondary monitor outerPosition() can
  // report stale/monitor-relative (or (0,0)) coordinates; trusting those
  // makes every cursor look "outside" and traps the window in ignore mode.
  // Keep the last good origin when a reading looks suspicious.

  const stop = () => {
    stopped = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
    // Always hand cursor events back when the feature shuts down.
    win.setIgnoreCursorEvents(false).catch(() => {});
    ignoring = false;
  };

  const poll = async () => {
    if (stopped) return;
    try {
      // Use the Rust command for reliable multi-monitor coordinates.
      const local = await invoke<[number, number, number, number] | null>("cursor_window_local");
      let capture: boolean;
      if (!local) {
        // Cursor is outside the window: pass clicks through to the app behind.
        capture = false;
      } else {
        const [lx, ly, w, h] = local;
        if (lx < 0 || ly < 0 || lx >= w || ly >= h) {
          capture = false;
        } else {
          const hit = document.elementFromPoint(lx, ly);
          const cv = canvas();
          const alpha = hit === cv && cv ? alphaAt(lx, ly) : null;
          capture = shouldCapture({ hit, canvas: cv, alpha });
        }
      }
      const desiredIgnoring = !capture;
      if (ignoring !== desiredIgnoring) {
        ignoring = desiredIgnoring;
        await win.setIgnoreCursorEvents(desiredIgnoring);
      }
    } catch {
      // Browser dev context or a transient IPC hiccup: keep the last state.
    }
  };

  void poll();
  timer = setInterval(poll, pollMs) as unknown as number;
  return stop;
}
