import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadUiPrefs, saveUiPrefs, normalizeShortcut, shortcutFromEvent, DEFAULT_UI_PREFS } from "./ui-prefs";

let store: Map<string, string>;

beforeEach(() => {
  store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => vi.unstubAllGlobals());

function setStored(value: string) {
  store.set("companion:ui", value);
}

describe("loadUiPrefs", () => {
  it("returns defaults when nothing is stored", () => {
    expect(loadUiPrefs()).toEqual(DEFAULT_UI_PREFS);
  });

  it("merges stored values over the defaults", () => {
    setStored(JSON.stringify({ hideChat: true }));
    expect(loadUiPrefs()).toEqual({ ...DEFAULT_UI_PREFS, hideChat: true });
  });

  // A corrupt entry must not break startup.
  it("falls back to defaults on unparseable JSON", () => {
    setStored("{not json");
    expect(loadUiPrefs()).toEqual(DEFAULT_UI_PREFS);
  });

  it("falls back to defaults when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
      removeItem: () => {},
    });
    expect(loadUiPrefs()).toEqual(DEFAULT_UI_PREFS);
  });
});

describe("saveUiPrefs", () => {
  it("round-trips through storage", () => {
    saveUiPrefs({ hideChat: true, micShortcut: "Alt+K" });
    expect(loadUiPrefs()).toEqual({ hideChat: true, micShortcut: "Alt+K" });
  });

  it("swallows storage failures", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
    });
    expect(() => saveUiPrefs(DEFAULT_UI_PREFS)).not.toThrow();
  });
});

describe("normalizeShortcut", () => {
  it("canonicalises modifier aliases and order", () => {
    expect(normalizeShortcut("shift+ctrl+m")).toBe("Ctrl+Shift+M");
    expect(normalizeShortcut("cmd+k")).toBe("Meta+K");
    expect(normalizeShortcut("super+j")).toBe("Meta+J");
    expect(normalizeShortcut("control+alt+x")).toBe("Ctrl+Alt+X");
  });

  it("keeps multi-character keys as typed", () => {
    expect(normalizeShortcut("ctrl+F5")).toBe("Ctrl+F5");
  });

  it("drops empty segments", () => {
    expect(normalizeShortcut("  ctrl + + m ")).toBe("Ctrl+M");
  });

  it("returns modifiers alone when no key is given", () => {
    expect(normalizeShortcut("ctrl+shift")).toBe("Ctrl+Shift");
  });

  it("returns an empty string for empty input", () => {
    expect(normalizeShortcut("")).toBe("");
  });
});

describe("shortcutFromEvent", () => {
  function keyEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
    return { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...init } as KeyboardEvent;
  }

  it("builds a combo from modifier flags", () => {
    expect(shortcutFromEvent(keyEvent({ ctrlKey: true, shiftKey: true, key: "m" }))).toBe("Ctrl+Shift+M");
  });

  // Pressing Ctrl alone fires a keydown with key="Control"; that must not
  // register as the "Ctrl" shortcut.
  it("ignores bare modifier presses", () => {
    for (const k of ["Control", "Shift", "Alt", "Meta"]) {
      expect(shortcutFromEvent(keyEvent({ ctrlKey: true, key: k }))).toBeNull();
    }
  });

  it("ignores unmodified keys", () => {
    expect(shortcutFromEvent(keyEvent({ key: "a" }))).toBeNull();
  });

  it("keeps multi-character keys", () => {
    expect(shortcutFromEvent(keyEvent({ altKey: true, key: "F5" }))).toBe("Alt+F5");
  });
});