import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowPrefs } from "./events";

// window-control routes everything through the Tauri window APIs; fake the
// modules (window-prefs.test.ts mock convention) and record the calls.
const h = vi.hoisted(() => {
  return {
    // The fake main window: records setPosition / setAlwaysOnTop calls.
    win: null as null | Record<string, any>,
    positions: [] as Array<{ x: number; y: number }>,
    alwaysOnTopCalls: [] as boolean[],
    outerPos: { x: 123, y: 456 },
    currentLabel: "main",
    mainWindowVisible: true,
    getByLabelThrows: false,
    currentMonitorNull: false,
    monitors: [] as Array<Record<string, any>>,
    invokeCalls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
    emitted: [] as Array<{ event: string; payload: unknown }>,
  };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () =>
    h.currentLabel === "main" ? h.win : { label: h.currentLabel },
  currentMonitor: () =>
    Promise.resolve(h.currentMonitorNull ? null : (h.monitors[0] ?? null)),
  availableMonitors: () => Promise.resolve(h.monitors),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: {
    getByLabel: (label: string) => {
      if (h.getByLabelThrows) return Promise.reject(new Error(`no ${label}`));
      return Promise.resolve(h.mainWindowVisible ? h.win : null);
    },
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    h.invokeCalls.push({ cmd, args: args ?? {} });
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload?: unknown) => {
    h.emitted.push({ event, payload });
    return Promise.resolve();
  },
}));

// Standard fixture: 1000x800 monitor with a 25px top inset (menu bar),
// window 200x150, scale factor 2 → SNAP_MARGIN = 32 physical px.
const BASE_MONITOR = {
  name: "main",
  position: { x: 0, y: 0 },
  size: { width: 1000, height: 800 },
  workArea: { position: { x: 0, y: 25 }, size: { width: 1000, height: 770 } },
  scaleFactor: 2,
};

const PREFS: WindowPrefs = {
  rememberPosition: true,
  anchor: "free",
  alwaysOnTop: true,
  clickThrough: true,
  followSpaces: false,
  savedPosition: null,
};

let store: Map<string, string>;
let wc: typeof import("./window-control");

beforeEach(async () => {
  h.win = {
    label: "main",
    setPosition: (p: { x: number; y: number }) =>
      void h.positions.push({ x: p.x, y: p.y }),
    setAlwaysOnTop: (on: boolean) => void h.alwaysOnTopCalls.push(on),
    outerSize: () =>
      Promise.resolve({ width: 200, height: 150, toLogical: () => ({}) }),
    outerPosition: () =>
      Promise.resolve({ ...h.outerPos, toLogical: () => ({}) }),
    scaleFactor: () => Promise.resolve(2),
  };
  h.positions.length = 0;
  h.alwaysOnTopCalls.length = 0;
  h.currentLabel = "main";
  h.mainWindowVisible = true;
  h.getByLabelThrows = false;
  h.currentMonitorNull = false;
  h.monitors = [BASE_MONITOR];
  h.invokeCalls.length = 0;
  h.emitted.length = 0;
  h.outerPos = { x: 123, y: 456 };

  store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });

  // Fresh module per test: positionTrackingArmed and clickThroughOverride
  // are module state.
  vi.resetModules();
  wc = await import("./window-control");
});

afterEach(() => vi.unstubAllGlobals());

describe("getMainWindow", () => {
  it("returns the current window when we ARE the main window", async () => {
    const win = await wc.getMainWindow();
    expect(win?.label).toBe("main");
  });

  it("resolves the shared main instance from another webview", async () => {
    h.currentLabel = "settings";
    const win = await wc.getMainWindow();
    expect(win?.label).toBe("main");
  });

  it("is null when the main window does not exist", async () => {
    h.currentLabel = "settings";
    h.mainWindowVisible = false;
    expect(await wc.getMainWindow()).toBeNull();
  });

  it("is null when the lookup fails", async () => {
    h.currentLabel = "settings";
    h.getByLabelThrows = true;
    expect(await wc.getMainWindow()).toBeNull();
  });
});

describe("snapToAnchor", () => {
  it("snaps top-left inside the work area with scaled margin", async () => {
    await wc.snapToAnchor("top-left");
    expect(h.positions).toEqual([{ x: 32, y: 57 }]);
  });

  it("snaps top-right", async () => {
    await wc.snapToAnchor("top-right");
    expect(h.positions).toEqual([{ x: 768, y: 57 }]);
  });

  it("snaps bottom-left", async () => {
    await wc.snapToAnchor("bottom-left");
    expect(h.positions).toEqual([{ x: 32, y: 613 }]);
  });

  it("snaps bottom-right", async () => {
    await wc.snapToAnchor("bottom-right");
    expect(h.positions).toEqual([{ x: 768, y: 613 }]);
  });

  it("centers within the work area", async () => {
    await wc.snapToAnchor("center");
    expect(h.positions).toEqual([{ x: 400, y: 335 }]);
  });

  it("falls back to raw monitor bounds without a work area", async () => {
    const { workArea: _ignored, ...raw } = BASE_MONITOR;
    h.monitors = [raw];
    await wc.snapToAnchor("top-left");
    expect(h.positions).toEqual([{ x: 32, y: 32 }]);
  });

  it("uses the first available monitor when currentMonitor() is null", async () => {
    h.currentMonitorNull = true;
    await wc.snapToAnchor("top-left");
    expect(h.positions).toEqual([{ x: 32, y: 57 }]);
  });

  it("no-ops without any monitor", async () => {
    h.monitors = [];
    await wc.snapToAnchor("top-left");
    expect(h.positions).toEqual([]);
  });

  it("no-ops when the main window is missing", async () => {
    h.currentLabel = "settings";
    h.mainWindowVisible = false;
    await wc.snapToAnchor("top-left");
    expect(h.positions).toEqual([]);
  });

  it("rounds the margin at scale 1", async () => {
    h.win!.scaleFactor = () => Promise.resolve(1);
    await wc.snapToAnchor("top-left");
    expect(h.positions).toEqual([{ x: 16, y: 41 }]);
  });
});

describe("restoreWindowLayout", () => {
  it("snap anchor wins over a saved position", async () => {
    await wc.restoreWindowLayout({ ...PREFS, anchor: "top-right", savedPosition: { x: 5, y: 5 } });
    expect(h.positions).toEqual([{ x: 768, y: 57 }]);
  });

  it("applies the saved position when the anchor is free", async () => {
    await wc.restoreWindowLayout({ ...PREFS, savedPosition: { x: 100, y: 200 } });
    expect(h.positions).toEqual([{ x: 100, y: 200 }]);
  });

  it("rejects a saved position on no connected monitor", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await wc.restoreWindowLayout({ ...PREFS, savedPosition: { x: 5000, y: 5000 } });
    expect(h.positions).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("honors rememberPosition=false", async () => {
    await wc.restoreWindowLayout({ ...PREFS, rememberPosition: false, savedPosition: { x: 100, y: 200 } });
    expect(h.positions).toEqual([]);
  });

  it("no-ops with nothing saved", async () => {
    await wc.restoreWindowLayout({ ...PREFS });
    expect(h.positions).toEqual([]);
  });

  it("accepts a position landing exactly on a monitor edge (half-open)", async () => {
    // Containment is x >= left && x < right: the last pixel of a 1920x1080
    // monitor is still "on" it, one past the edge is not.
    h.monitors = [{ ...BASE_MONITOR, position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } }];
    await wc.restoreWindowLayout({ ...PREFS, savedPosition: { x: 1919, y: 1079 } });
    expect(h.positions).toEqual([{ x: 1919, y: 1079 }]);
    h.positions.length = 0;
    await wc.restoreWindowLayout({ ...PREFS, savedPosition: { x: 1920, y: 0 } });
    expect(h.positions).toEqual([]);
  });

  it("never throws on window failures", async () => {
    h.win!.setPosition = () => Promise.reject(new Error("denied"));
    await expect(
      wc.restoreWindowLayout({ ...PREFS, anchor: "top-left" }),
    ).resolves.toBeUndefined();
  });
});

describe("applyWindowBehavior", () => {
  it("applies always-on-top and follow-spaces", async () => {
    await wc.applyWindowBehavior({ ...PREFS, alwaysOnTop: true, followSpaces: true });
    expect(h.alwaysOnTopCalls).toEqual([true]);
    expect(h.invokeCalls).toEqual([
      { cmd: "window_set_follow_spaces", args: { join: true } },
    ]);
  });

  it("still applies follow-spaces without a main window", async () => {
    h.currentLabel = "settings";
    h.mainWindowVisible = false;
    await wc.applyWindowBehavior(PREFS);
    expect(h.alwaysOnTopCalls).toEqual([]);
    expect(h.invokeCalls).toHaveLength(1);
  });

  it("swallows failures from both calls", async () => {
    h.win!.setAlwaysOnTop = () => Promise.reject(new Error("denied"));
    await expect(
      wc.applyWindowBehavior({ ...PREFS, alwaysOnTop: true, followSpaces: true }),
    ).resolves.toBeUndefined();
    expect(h.invokeCalls).toHaveLength(1);
  });
});

describe("persistCurrentPosition", () => {
  function storedPosition(): { x: number; y: number } | null | undefined {
    const raw = store.get("companion:window");
    if (!raw) return undefined;
    return JSON.parse(raw).savedPosition;
  }

  it("no-ops until armPositionTracking", async () => {
    await wc.persistCurrentPosition();
    expect(storedPosition()).toBeUndefined();
  });

  it("stores the outer position once armed", async () => {
    wc.armPositionTracking();
    await wc.persistCurrentPosition();
    expect(storedPosition()).toEqual({ x: 123, y: 456 });
    // Saved via updateWindowPrefs → broadcast on the core channel.
    expect(h.emitted).toEqual([
      {
        event: "window-prefs-changed",
        payload: expect.objectContaining({ savedPosition: { x: 123, y: 456 } }),
      },
    ]);
  });

  it("respects rememberPosition=false", async () => {
    wc.armPositionTracking();
    store.set("companion:window", JSON.stringify({ ...PREFS, rememberPosition: false }));
    await wc.persistCurrentPosition();
    expect(storedPosition()).toBeNull();
  });
});

describe("click-through override", () => {
  it("follows the user pref without an override", () => {
    expect(wc.clickThroughEnabled({ ...PREFS, clickThrough: true })).toBe(true);
    expect(wc.clickThroughEnabled({ ...PREFS, clickThrough: false })).toBe(false);
  });

  it("a boolean override wins over the pref until restart", () => {
    wc.setClickThroughOverride(true);
    expect(wc.clickThroughEnabled({ ...PREFS, clickThrough: false })).toBe(true);
    wc.setClickThroughOverride(false);
    expect(wc.clickThroughEnabled({ ...PREFS, clickThrough: true })).toBe(false);
  });

  it("the override sticks across reads (runtime-only, not a toggle)", () => {
    wc.setClickThroughOverride(true);
    expect(wc.clickThroughEnabled({ ...PREFS, clickThrough: true })).toBe(true);
    expect(wc.clickThroughEnabled({ ...PREFS, clickThrough: false })).toBe(true);
  });
});
