import { afterEach, describe, expect, it, vi } from "vitest";

import {
  guardUpdate,
  isKeyboardOpen,
  isTouchViewport,
  type GuardState,
  type LayoutBox,
} from "./mobile-keyboard";

describe("isTouchViewport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is true when the primary pointer is coarse (phone/tablet)", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(pointer: coarse)" }));
    expect(isTouchViewport()).toBe(true);
  });

  it("is false when the primary pointer is fine (desktop, touch-screen laptop)", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(isTouchViewport()).toBe(false);
  });

  it("is false without a matchMedia implementation", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(isTouchViewport()).toBe(false);
  });
});

describe("isKeyboardOpen", () => {
  it("is closed when both viewports match the stable box", () => {
    expect(isKeyboardOpen({ h: 800, w: 400 }, { h: 800, w: 400 }, 800)).toBe(false);
  });

  it("opens when the layout height shrinks at constant width (keyboard)", () => {
    expect(isKeyboardOpen({ h: 400, w: 400 }, { h: 800, w: 400 }, 400)).toBe(true);
  });

  it("opens when only the visual viewport shrinks (iOS pan model)", () => {
    expect(isKeyboardOpen({ h: 800, w: 400 }, { h: 800, w: 400 }, 400)).toBe(true);
  });

  it("does not read a rotation as a keyboard (width changes)", () => {
    // Portrait -> landscape: height shrinks but the width grows.
    expect(isKeyboardOpen({ h: 400, w: 800 }, { h: 800, w: 400 }, 400)).toBe(false);
    // Landscape -> portrait: height grows.
    expect(isKeyboardOpen({ h: 800, w: 400 }, { h: 400, w: 800 }, 800)).toBe(false);
  });

  it("tolerates sub-pixel rounding", () => {
    expect(isKeyboardOpen({ h: 800, w: 400 }, { h: 800.5, w: 400 }, 800)).toBe(false);
    expect(isKeyboardOpen({ h: 800, w: 400 }, { h: 800, w: 400 }, 799.8)).toBe(false);
    expect(isKeyboardOpen({ h: 800, w: 400.5 }, { h: 800, w: 400 }, 800)).toBe(false);
  });

  it("handles a missing visualViewport API", () => {
    expect(isKeyboardOpen({ h: 800, w: 400 }, { h: 800, w: 400 }, undefined)).toBe(false);
    expect(isKeyboardOpen({ h: 400, w: 400 }, { h: 800, w: 400 }, undefined)).toBe(true);
  });
});

describe("guardUpdate", () => {
  const step = (
    stable: LayoutBox,
    layout: LayoutBox,
    visualH?: number,
  ): { state: GuardState; pin: number | null; reset: boolean } => {
    const { state, action } = guardUpdate(
      { stable },
      { layoutH: layout.h, layoutW: layout.w, visualH },
    );
    return { state, pin: action.pinHeight, reset: action.resetScroll };
  };

  it("pins fixed canvases to the stable height while the layout shrinks", () => {
    // Keyboard opens by shrinking the layout (browser without the meta).
    expect(step({ h: 800, w: 400 }, { h: 400, w: 400 }, 400)).toMatchObject({
      pin: 800,
      reset: true,
    });
  });

  it("keeps the baseline frozen across keyboard-open resizes", () => {
    // Caret nudge / quick-type bar while open (layout stays shrunk): still
    // pinned to the frozen keyboard-closed height, not the current one.
    expect(step({ h: 800, w: 400 }, { h: 440, w: 400 }, 440)).toMatchObject({
      pin: 800,
      reset: true,
    });
  });

  it("re-baselines when the keyboard closes, clearing the pin", () => {
    expect(step({ h: 400, w: 400 }, { h: 800, w: 400 }, 800)).toMatchObject({
      state: { stable: { h: 800, w: 400 } },
      pin: null,
      reset: false,
    });
  });

  it("re-baselines immediately on a keyboard-closed rotation", () => {
    // Rotating portrait -> landscape with no keyboard: the new box becomes
    // the baseline instead of pinning to the stale portrait height.
    expect(step({ h: 800, w: 400 }, { h: 400, w: 800 }, 400)).toMatchObject({
      state: { stable: { h: 400, w: 800 } },
      pin: null,
    });
  });

  it("never pins when only the visual viewport shrinks (iOS)", () => {
    expect(step({ h: 800, w: 400 }, { h: 800, w: 400 }, 400)).toMatchObject({
      pin: null,
      reset: true,
    });
  });

  it("keeps scrolling allowed while the keyboard is open (iOS pan)", () => {
    expect(step({ h: 800, w: 400 }, { h: 800, w: 400 }, 400)).toMatchObject({ reset: true });
    // A caret nudge while open must not close the guard.
    expect(step({ h: 800, w: 400 }, { h: 800, w: 400 }, 380)).toMatchObject({ reset: true });
  });

  it("handles a missing visualViewport API", () => {
    expect(step({ h: 800, w: 400 }, { h: 400, w: 400 })).toMatchObject({
      pin: 800,
      reset: true,
    });
    expect(step({ h: 400, w: 400 }, { h: 800, w: 400 })).toMatchObject({
      pin: null,
      reset: false,
    });
  });
});
