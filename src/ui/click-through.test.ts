import { describe, expect, it } from "vitest";
import {
  shouldCapture,
  toLocalCss,
  type CaptureInput,
} from "./click-through";

describe("toLocalCss", () => {
  const origin = { x: 1000, y: 500 };
  const inner = { x: 480, y: 750 };

  it("converts global physical pixels to window-local CSS pixels", () => {
    // 2x monitor: window starts at physical (1000,500); cursor 132px right of
    // the origin is 66 CSS px into the window.
    expect(toLocalCss({ x: 1132, y: 760 }, origin, 2, inner)).toEqual({ x: 66, y: 130 });
  });

  it("handles fractional scale factors", () => {
    expect(toLocalCss({ x: 1060, y: 545 }, origin, 1.5, inner)).toEqual({ x: 40, y: 30 });
  });

  it("returns null when the cursor is outside the window", () => {
    expect(toLocalCss({ x: 900, y: 600 }, origin, 2, inner)).toBeNull(); // left of origin
    expect(toLocalCss({ x: 1000, y: 400 }, origin, 2, inner)).toBeNull(); // above origin
    expect(toLocalCss({ x: 1961, y: 600 }, origin, 2, inner)).toBeNull(); // past right edge
    expect(toLocalCss({ x: 1200, y: 2001 }, origin, 2, inner)).toBeNull(); // past bottom edge
  });

  it("returns null for a non-positive scale factor", () => {
    expect(toLocalCss({ x: 1000, y: 500 }, origin, 0, inner)).toBeNull();
  });

  it("accepts the exact bottom-right corner", () => {
    expect(
      toLocalCss({ x: 1000 + 480 * 2 - 1, y: 500 + 750 * 2 - 1 }, origin, 2, inner),
    ).toEqual({ x: 479.5, y: 749.5 });
  });
});

describe("shouldCapture", () => {
  // shouldCapture only compares hit vs canvas by identity — plain objects
  // stand in for DOM nodes since tests run in a node environment.
  const canvas = { tagName: "CANVAS" } as unknown as HTMLCanvasElement;
  const div = { tagName: "DIV" } as unknown as Element;

  const input = (partial: Partial<CaptureInput>): CaptureInput => ({
    hit: canvas,
    canvas,
    alpha: null,
    ...partial,
  });

  it("captures over any non-canvas element (chat panel, banner, menus)", () => {
    expect(shouldCapture(input({ hit: div }))).toBe(true);
  });

  it("captures over opaque model pixels", () => {
    expect(shouldCapture(input({ alpha: 255 }))).toBe(true);
  });

  it("passes through fully transparent pixels", () => {
    expect(shouldCapture(input({ alpha: 0 }))).toBe(false);
  });

  it("filters the antialiased halo below the threshold", () => {
    expect(shouldCapture(input({ alpha: 15 }))).toBe(false);
    expect(shouldCapture(input({ alpha: 16 }))).toBe(true);
  });

  it("stays interactive when the pixel cannot be read", () => {
    // No scene yet / readback failure: default to capture so the window
    // never becomes a black hole for clicks.
    expect(shouldCapture(input({ alpha: null }))).toBe(true);
    expect(shouldCapture(input({ hit: null, alpha: null }))).toBe(true);
  });
});
