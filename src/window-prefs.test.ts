import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WINDOW_PREFS,
  loadWindowPrefs,
  saveWindowPrefs,
  updateWindowPrefs,
} from "./window-prefs";

const { emitted } = vi.hoisted(() => ({
  emitted: [] as Array<{ event: string; payload: unknown }>,

}));

// The module only emits under Tauri; the stubbed window below satisfies
// its `__TAURI_INTERNALS__` probe.
vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload?: unknown) => {
    emitted.push({ event, payload });
    return Promise.resolve();
  },
}));

let store: Map<string, string>;

beforeEach(() => {
  store = new Map<string, string>();
  emitted.length = 0;
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
});

afterEach(() => vi.unstubAllGlobals());

describe("loadWindowPrefs", () => {
  it("returns defaults when nothing is stored", () => {
    expect(loadWindowPrefs()).toEqual(DEFAULT_WINDOW_PREFS);
  });

  it("merges stored values over the defaults", () => {
    store.set("companion:window", JSON.stringify({ alwaysOnTop: false }));
    expect(loadWindowPrefs()).toEqual({ ...DEFAULT_WINDOW_PREFS, alwaysOnTop: false });
  });

  it("falls back to defaults on unparseable JSON", () => {
    store.set("companion:window", "{not json");
    expect(loadWindowPrefs()).toEqual(DEFAULT_WINDOW_PREFS);
  });
});

describe("saveWindowPrefs", () => {
  it("round-trips through storage", () => {
    saveWindowPrefs({ ...DEFAULT_WINDOW_PREFS, anchor: "bottom-right" });
    expect(loadWindowPrefs().anchor).toBe("bottom-right");
  });

  it("broadcasts window-prefs-changed under Tauri", () => {
    saveWindowPrefs({ ...DEFAULT_WINDOW_PREFS, clickThrough: false });
    expect(emitted).toEqual([
      { event: "window-prefs-changed", payload: { ...DEFAULT_WINDOW_PREFS, clickThrough: false } },
    ]);
  });
});

describe("updateWindowPrefs", () => {
  it("patches the stored object read-modify-write", () => {
    updateWindowPrefs({ savedPosition: { x: 100, y: 200 } });
    updateWindowPrefs({ alwaysOnTop: false });
    expect(loadWindowPrefs()).toEqual({
      ...DEFAULT_WINDOW_PREFS,
      alwaysOnTop: false,
      savedPosition: { x: 100, y: 200 },
    });
  });
});
