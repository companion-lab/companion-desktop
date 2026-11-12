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
//
// Native Wayland has neither a global cursor position nor a working
// `setIgnoreCursorEvents` (tao's GTK input shape never reaches the
// compositor from a WebKitGTK window), so there the compositor's input
// region is driven instead: see initClickThroughWayland below.

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
  /** Live click-through switch (Settings > General; read by the poll so
   *  toggling needs no re-init). Omit = always enabled. */
  enabled?: () => boolean;
  pollMs?: number;
};

/** Per-window click-through strategy chooser: the macOS/Windows/X11 poll
 *  toggles `setIgnoreCursorEvents` from the global cursor position; native
 *  Wayland drives the compositor's input region instead (no global cursor,
 *  and tao's GTK input shape never reaches the compositor there). Resolved
 *  once at init; the returned cleanup releases whichever strategy started. */
export function initClickThrough(opts: InitOptions): () => void {
  let stopped = false;
  let stopActive: (() => void) | null = null;
  void invoke<"wayland" | "x11" | null>("windowing_backend")
    .then((backend) => {
      if (stopped) return;
      stopActive =
        backend === "wayland"
          ? initClickThroughWayland(opts)
          : initClickThroughPoll(opts);
    })
    .catch(() => {
      // No host (browser dev context): nothing to drive.
    });
  return () => {
    stopped = true;
    stopActive?.();
  };
}

function initClickThroughPoll({
  canvas,
  alphaAt,
  enabled,
  pollMs = 90,
}: InitOptions): () => void {
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
    // Feature disabled (Settings > General): keep releasing cursor events
    // and skip the hit test entirely.
    if (enabled && !enabled()) {
      if (ignoring) {
        ignoring = false;
        await win.setIgnoreCursorEvents(false).catch(() => {});
      }
      return;
    }
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

// Wayland: the compositor routes clicks outside the window's input region to
// the surface below, so click-through is managed by cutting a small
// exclusion rect out of the input region (set_click_through_exclusions) once
// a pointermove lands on fully transparent canvas pixels. The webview keeps
// the full input region otherwise and receives real pointer events; moving
// back onto the model or a DOM overlay fires a fresh pointer event that
// clears the exclusion. Events never arrive from inside the excluded rect
// (the compositor routes them below) — which is exactly the passthrough the
// user wants there.
function initClickThroughWayland({
  canvas,
  alphaAt,
  enabled,
}: InitOptions): () => void {
  // Square (CSS px) cut around the cursor while it sits on transparent
  // pixels. Big enough to cover small pointer jitters between events.
  const EXCLUDE_SIDE = 64;
  // Dedupe grid: only re-sync the region when the cursor moved this far, so
  // a stream of mousemoves doesn't spam the IPC.
  const RESYNC_STEP = 16;
  let stopped = false;
  // Region state last sent to the host, keyed on the 16px grid ("full" = no
  // exclusion). Shared by the move handler and the disabled-state poll.
  let lastSent = "full";

  const send = (at: { x: number; y: number } | null) => {
    const key = at
      ? `${Math.round(at.x / RESYNC_STEP)},${Math.round(at.y / RESYNC_STEP)}`
      : "full";
    if (key === lastSent) return;
    lastSent = key;
    const rects = at
      ? [[at.x - EXCLUDE_SIDE / 2, at.y - EXCLUDE_SIDE / 2, EXCLUDE_SIDE, EXCLUDE_SIDE]]
      : null;
    void invoke("set_click_through_exclusions", { rects }).catch(() => {});
  };

  const onMove = (e: PointerEvent) => {
    if (stopped) return;
    if (enabled && !enabled()) {
      send(null);
      return;
    }
    const lx = e.clientX;
    const ly = e.clientY;
    const hit = document.elementFromPoint(lx, ly);
    const cv = canvas();
    const alpha = hit === cv && cv ? alphaAt(lx, ly) : null;
    // Any DOM overlay or an opaque model pixel captures the cursor; fully
    // transparent canvas passes through. Alpha readback failure stays
    // interactive (can't prove emptiness).
    if (hit && hit !== cv) send(null);
    else if (alpha !== null && alpha < OPAQUE_ALPHA_THRESHOLD) send({ x: lx, y: ly });
    else send(null);
  };

  // A resize invalidates the full-window part of the current region (it was
  // sized at set time) — reset to full input; the next move re-establishes
  // the exclusion if needed.
  const onResize = () => {
    if (!stopped) send(null);
  };

  // The move handler only runs while events flow; when the cursor parks in
  // an excluded (transparent) area and the user then turns the feature off,
  // no event would clear the exclusion — poll the switch lightly.
  const timer = setInterval(() => {
    if (!stopped && enabled && !enabled() && lastSent !== "full") send(null);
  }, 300);

  document.addEventListener("pointermove", onMove, true);
  window.addEventListener("resize", onResize);
  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("resize", onResize);
    if (lastSent !== "full") send(null);
  };
}
