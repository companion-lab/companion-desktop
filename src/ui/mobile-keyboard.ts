// Mobile keyboard guard for the main window.
//
// On phones the on-screen keyboard changes the viewport, and every
// viewport-anchored layer moves with it — including the avatar canvas
// (`position: fixed; inset: 0`), so the keyboard pushes the character up and
// the head scrolls out of view. The chat panel is the only layer allowed to
// move (it lifts itself above the keyboard via the visual viewport, see the
// chat plugin's ChatPanel); this guard keeps everything else pinned:
//
// - Android Chromium resizes the whole layout viewport (the
//   `interactive-widget=resizes-content` meta in index.html makes that
//   explicit — the panning resizes-visual behavior is what pushed the
//   character off-screen). With the layout shrunk, any fixed-position canvas
//   is pinned to the last keyboard-closed height while the keyboard is open,
//   starting from the first animation frame so it never actually changes
//   size. It just extends underneath the keyboard, which is invisible — the
//   rendered character keeps its full size and the visible top shows the
//   head.
// - iOS never resizes the layout viewport; it PANS the window instead
//   (window.scrollY moves) to reveal the focused input. While the keyboard is
//   open, every pan is scrolled back to 0 so the fixed layers stay put.
//
// Desktop webviews have no on-screen keyboard: innerHeight and the visual
// viewport height never diverge, so the guard is a persistent no-op there.

export type VisualViewportLike = { height: number; offsetTop: number };

/** The guard only matters where an on-screen keyboard can appear. Gating on a
 * coarse primary pointer (phones/tablets) instead of a UA sniff keeps desktop
 * webviews and desktop browsers out — there a height-only window resize is a
 * completely normal operation (window edge drag, size slider), which this
 * guard's keyboard heuristic would misread and pin the canvases to a stale
 * height. */
export function isTouchViewport(): boolean {
  try {
    return (
      typeof matchMedia === "function" &&
      matchMedia("(pointer: coarse)").matches
    );
  } catch {
    return false;
  }
}

export type LayoutBox = { h: number; w: number };

/** Keyboard-open detection. `layout` is the current window box, `stable` the
 * last keyboard-closed box, `visualH` the visual viewport height (undefined =
 * API unsupported). The 1px slack absorbs sub-pixel rounding on fractional-
 * DPR devices.
 *
 * The keyboard shrinks the HEIGHT only and never touches the width, while a
 * rotation always changes the width — that's what tells a plain rotation
 * apart from a keyboard-shrink (both shrink the layout height, and with the
 * keyboard open the visual viewport shrinks with the layout too, so the
 * visual-viewport signal alone cannot separate them). */
export function isKeyboardOpen(
  layout: LayoutBox,
  stable: LayoutBox,
  visualH: number | undefined,
): boolean {
  const shrunkLayout =
    layout.h < stable.h - 1 && Math.abs(layout.w - stable.w) <= 1;
  const shrunkVisual = visualH !== undefined && visualH < layout.h - 1;
  return shrunkLayout || shrunkVisual;
}

export type ViewportSnapshot = {
  /** window.innerHeight / innerWidth */
  layoutH: number;
  layoutW: number;
  /** visualViewport.height (undefined = API unsupported) */
  visualH?: number;
};

/** Internal state: the last observed keyboard-closed layout box. Frozen while
 * the keyboard is open (caret nudges and the iOS quick-type bar resize the
 * visual viewport without the layout ever returning to full), re-baselined
 * immediately on any keyboard-closed resize such as rotating the phone. */
export interface GuardState {
  stable: LayoutBox;
}

export interface GuardAction {
  /** Height to pin fixed canvases to, or null to release the pin. */
  pinHeight: number | null;
  /** True while the keyboard is open: the wiring may reset window scroll. */
  resetScroll: boolean;
}

/** Pure step of the guard, called on every viewport resize/scroll. */
export function guardUpdate(
  state: GuardState,
  snap: ViewportSnapshot,
): { state: GuardState; action: GuardAction } {
  const open = isKeyboardOpen(
    { h: snap.layoutH, w: snap.layoutW },
    state.stable,
    snap.visualH,
  );
  const next: GuardState = open
    ? state
    : { stable: { h: snap.layoutH, w: snap.layoutW } };
  return {
    state: next,
    action: {
      // Over-constrained fixed box (top: 0 + explicit height): bottom is
      // ignored, so the canvas keeps its full height and overflows downward.
      pinHeight:
        open && snap.layoutH < next.stable.h - 1 ? next.stable.h : null,
      resetScroll: open,
    },
  };
}

function fixedCanvases(): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  for (const c of document.querySelectorAll("canvas")) {
    if (getComputedStyle(c).position === "fixed") out.push(c);
  }
  return out;
}

export function initMobileKeyboardGuard(): () => void {
  if (!isTouchViewport()) return () => {};
  const vv = window.visualViewport;
  let state: GuardState = {
    stable: { h: window.innerHeight, w: window.innerWidth },
  };

  const update = () => {
    const { state: next, action } = guardUpdate(state, {
      layoutH: window.innerHeight,
      layoutW: window.innerWidth,
      visualH: vv?.height,
    });
    state = next;

    for (const c of fixedCanvases()) {
      c.style.height = action.pinHeight !== null ? `${action.pinHeight}px` : "";
    }

    if (action.resetScroll && (window.scrollY !== 0 || window.scrollX !== 0)) {
      window.scrollTo(0, 0);
    }
  };

  // resize covers keyboard show/hide on both platforms; the scroll events
  // cover iOS's pan (window and visual viewport fire separate events).
  vv?.addEventListener("resize", update);
  vv?.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  window.addEventListener("scroll", update);
  return () => {
    vv?.removeEventListener("resize", update);
    vv?.removeEventListener("scroll", update);
    window.removeEventListener("resize", update);
    window.removeEventListener("scroll", update);
    for (const c of fixedCanvases()) c.style.height = "";
  };
}
