import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCENT_CHOICES, applyAccent, DEFAULT_ACCENT } from "./theme";

let styleProps: Map<string, string>;

beforeEach(() => {
  styleProps = new Map();
  vi.stubGlobal("document", {
    documentElement: {
      style: {
        setProperty: (k: string, v: string) => void styleProps.set(k, v),
      },
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("applyAccent", () => {
  it("sets the --c-accent token", () => {
    applyAccent("#a855f7");
    expect(styleProps.get("--c-accent")).toBe("#a855f7");
  });

  it("falls back to the default accent when unset", () => {
    applyAccent(null);
    expect(styleProps.get("--c-accent")).toBe(DEFAULT_ACCENT);
  });

  // The token lands in inline styles fed from persisted prefs JSON, so
  // anything that isn't a plain hex color must be rejected.
  it("rejects non-hex values (injection guard)", () => {
    applyAccent("red; } body { background: url(evil)");
    applyAccent("url(javascript:alert(1))");
    expect(styleProps.size).toBe(0);
  });

  it("accepts every swatch in the palette", () => {
    for (const color of ACCENT_CHOICES) {
      applyAccent(color);
      expect(styleProps.get("--c-accent")).toBe(color);
    }
  });
});
