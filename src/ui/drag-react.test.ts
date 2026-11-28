import { describe, expect, it } from "vitest";
import { ARM_IDLE_MS, DRAG_IDLE_MS, leanFromVelocity } from "./drag-react";

describe("leanFromVelocity", () => {
  it("maps rightward motion to a positive lean.x and trails vertically at zero", () => {
    const l = leanFromVelocity(2, 0);
    expect(l.x).toBeGreaterThan(0);
    expect(l.y).toBe(0);
  });

  it("maps downward motion to a positive lean.y", () => {
    const l = leanFromVelocity(0, 3);
    expect(l.y).toBeGreaterThan(0);
    expect(l.x).toBe(0);
  });

  it("saturates brisk drags at ±1 per axis", () => {
    const l = leanFromVelocity(100, -100);
    expect(l.x).toBeLessThanOrEqual(1);
    expect(l.y).toBeGreaterThanOrEqual(-1);
  });

  it("is point-symmetric: reversed motion mirrors the lean", () => {
    const a = leanFromVelocity(1, -1);
    const b = leanFromVelocity(-1, 1);
    expect(b.x).toBeCloseTo(-a.x, 10);
    expect(b.y).toBeCloseTo(-a.y, 10);
  });

  it("is quiet at rest", () => {
    expect(leanFromVelocity(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it("exported idle windows stay in sync with the drag lifecycle", () => {
    // The end-of-drag idle window must be shorter than the armed-but-unmoved
    // window so a click can never read as a stale drag.
    expect(DRAG_IDLE_MS).toBeLessThan(ARM_IDLE_MS);
  });
});
