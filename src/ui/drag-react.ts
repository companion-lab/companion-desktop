import { getCurrentWindow } from "@tauri-apps/api/window";
import { avatarBus } from "../avatar-bus";

// Drag-react: the 3D character reacts while its window is carried. The OS
// keeps doing the actual drag (native startDragging stays smooth); during it
// the webview still receives `tauri://move` events (App.tsx already relies on
// that for position persistence), so drag state and velocity are derived from
// those events. Pointer events stop flowing inside the native drag loop,
// which is why they can only arm the effect, not measure it.
//
// This module only measures: each move event becomes a normalized lean target
// fed through the avatar bus (setCarry), and the vrm engine does all the
// animation — it smooths the lean per frame, shifts the model root opposite
// the motion (spring bones make hair/skirt swing), and settles back on
// release. No CSS, no rAF loop here.

/** No move events for this long while dragging → the drag has ended (the
 *  native drag loop gives no reliable pointerup). */
export const DRAG_IDLE_MS = 130;
/** An armed press that never moves (plain click / context-menu press)
 *  disarms after this long. */
export const ARM_IDLE_MS = 250;

/** Normalized lean per logical px/ms of drag velocity (a brisk drag runs
 *  ~2-4 px/ms, so ~2.2 saturates the lean). */
const LEAN_PER_SPEED = 0.45;

const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v)) || 0;

/** Velocity → normalized carry lean. +x = dragging right, +y = dragging
 *  down (screen axes). The engine maps these to the opposite-of-motion lag.
 *  `|| 0` normalizes -0 (multiplier of -0 velocity) so it never compares
 *  unequal to zero downstream. Pure so tests can pin the mapping. */
export function leanFromVelocity(vx: number, vy: number): { x: number; y: number } {
  return {
    x: clamp(vx * LEAN_PER_SPEED, 1),
    y: clamp(vy * LEAN_PER_SPEED, 1),
  };
}

export type DragReactOptions = {
  /** The full-window interaction canvas — grabs (drags) start here. */
  canvas: () => HTMLCanvasElement | null;
  /** Live switch (Settings > General > Window Behavior); consulted per
   *  event, so toggling needs no re-init. Omit = always on. */
  enabled?: () => boolean;
};

export function initDragReact({ canvas, enabled }: DragReactOptions): () => void {
  const canvasEl = canvas();
  if (!canvasEl) return () => {}; // nothing to arm from — inert

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let unlistenMoved: (() => void) | null = null;
  let armed = false;
  let dragging = false;
  let endTimer = 0;
  let lastMoveAt = 0;
  let lastPos: { x: number; y: number } | null = null;

  const active = () => armed || dragging;

  const clearEndTimer = () => {
    if (endTimer) window.clearTimeout(endTimer);
    endTimer = 0;
  };

  /** Back to rest (also the shutdown path): settle the character. Safe to
   *  call when nothing is happening. */
  const disarm = () => {
    armed = false;
    dragging = false;
    lastPos = null;
    clearEndTimer();
    avatarBus().setCarry(null);
  };

  const arm = () => {
    if (active()) return;
    if (enabled && !enabled()) return;
    if (reducedMotion.matches) return;
    armed = true;
    // An armed press that never moves (a plain click, or a right-click that
    // opens the context menu) disarms quietly.
    clearEndTimer();
    endTimer = window.setTimeout(disarm, ARM_IDLE_MS);
  };

  const onMoved = (e: { payload: { x: number; y: number } }) => {
    if (!active()) return; // programmatic moves (snap presets, restore) never sway
    if (enabled && !enabled()) {
      disarm();
      return;
    }
    const now = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const pos = { x: e.payload.x / dpr, y: e.payload.y / dpr };
    if (lastPos) {
      const dx = pos.x - lastPos.x;
      const dy = pos.y - lastPos.y;
      if (dx !== 0 || dy !== 0) {
        const dt = now - lastMoveAt;
        // Clamp so a long hold before the first jerk doesn't dilute the
        // velocity to nothing.
        const vdt = Math.min(Math.max(dt, 1), 100);
        if (!dragging) dragging = true;
        avatarBus().setCarry(leanFromVelocity(dx / vdt, dy / vdt));
      }
    }
    lastPos = pos;
    lastMoveAt = now;
    // Move events keep arriving while the drag lives; when they stop, the
    // drag has ended (the native loop gives no reliable pointerup).
    clearEndTimer();
    endTimer = window.setTimeout(disarm, DRAG_IDLE_MS);
  };

  const onPointerDown = (e: PointerEvent) => {
    // Right-click opens the context menu, not a drag.
    if (e.button !== 0) return;
    arm();
  };
  // Fast paths for the release; the idle timer is the backstop (platforms
  // differ on whether pointer events survive the native drag).
  const onPointerEnd = () => {
    if (active()) disarm();
  };
  const onBlur = () => {
    if (active()) disarm();
  };

  canvasEl.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointerup", onPointerEnd);
  window.addEventListener("pointercancel", onPointerEnd);
  window.addEventListener("blur", onBlur);
  try {
    void getCurrentWindow()
      .onMoved(onMoved)
      .then((u) => {
        unlistenMoved = u;
      });
  } catch {
    // No Tauri runtime (plain browser dev tab): the pointer fast-paths still
    // work, but there are no window-move events to react to.
  }

  return () => {
    unlistenMoved?.();
    canvasEl.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointerup", onPointerEnd);
    window.removeEventListener("pointercancel", onPointerEnd);
    window.removeEventListener("blur", onBlur);
    disarm();
  };
}
