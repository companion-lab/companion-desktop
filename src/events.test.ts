import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UiPrefs, WindowPrefs } from "./events";

// startEventBridge subscribes to the two core channels through the Tauri
// event API; capture the registrations so tests can drive the handlers.
const { registered, failListen } = vi.hoisted(() => ({
  registered: [] as Array<{
    event: string;
    handler: (e: { payload: unknown }) => void;
  }>,
  failListen: { value: false },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    if (failListen.value) return Promise.reject(new Error("bridge down"));
    registered.push({ event, handler });
    return Promise.resolve(() => {});
  },
}));

// The bridge is one-shot via a module flag, so every test gets a fresh
// module instance (registry.test.ts dynamic-import precedent).
let events: typeof import("./events");

beforeEach(async () => {
  registered.length = 0;
  failListen.value = false;
  vi.resetModules();
  events = await import("./events");
});

function fire(event: string, payload: unknown) {
  const reg = registered.find((r) => r.event === event);
  if (!reg) throw new Error(`no listener registered for ${event}`);
  reg.handler({ payload });
}

describe("startEventBridge", () => {
  it("registers the two core channels once", () => {
    events.startEventBridge();
    events.startEventBridge();
    expect(registered.map((r) => r.event)).toEqual([
      "ui-prefs-changed",
      "window-prefs-changed",
    ]);
  });

  it("a listen failure never rejects out of the bridge", async () => {
    failListen.value = true;
    expect(() => events.startEventBridge()).not.toThrow();
    // The rejection is swallowed by the bridge; give it a tick to land.
    await new Promise((r) => setTimeout(r, 0));
    expect(registered).toEqual([]);
  });
});

describe("ui prefs channel", () => {
  it("dispatches payloads to subscribed listeners", () => {
    events.startEventBridge();
    const seen: UiPrefs[] = [];
    events.onUiPrefsChanged((p) => seen.push(p));
    fire("ui-prefs-changed", { hideChat: true, micShortcut: "f2" });
    expect(seen).toEqual([{ hideChat: true, micShortcut: "f2" }]);
  });

  it("stops dispatching after unsubscribe", () => {
    events.startEventBridge();
    const seen: UiPrefs[] = [];
    const off = events.onUiPrefsChanged((p) => seen.push(p));
    off();
    fire("ui-prefs-changed", { hideChat: true, micShortcut: "" });
    expect(seen).toEqual([]);
  });

  it("listeners added after a payload do not replay it", () => {
    events.startEventBridge();
    const late = vi.fn();
    fire("ui-prefs-changed", { hideChat: true, micShortcut: "" });
    events.onUiPrefsChanged(late);
    expect(late).not.toHaveBeenCalled();
  });

  it("emitUiPrefsChanged fans out synchronously without Tauri", () => {
    events.startEventBridge();
    const seen: UiPrefs[] = [];
    events.onUiPrefsChanged((p) => seen.push(p));
    // The local-apply path: no queued frame, no echo round trip.
    events.emitUiPrefsChanged({ hideChat: true, micShortcut: "Ctrl+Shift+M" });
    expect(seen).toEqual([{ hideChat: true, micShortcut: "Ctrl+Shift+M" }]);
  });

  it("emitUiPrefsChanged is safe with no subscribers", () => {
    expect(() =>
      events.emitUiPrefsChanged({ hideChat: false, micShortcut: "Ctrl+Shift+M" }),
    ).not.toThrow();
  });
});

describe("window prefs channel", () => {
  it("dispatches payloads to subscribed listeners", () => {
    events.startEventBridge();
    const seen: WindowPrefs[] = [];
    events.onWindowPrefsChanged((p) => seen.push(p));
    fire("window-prefs-changed", {
      rememberPosition: false,
      anchor: "top-left",
      alwaysOnTop: true,
      clickThrough: true,
      followSpaces: false,
      savedPosition: null,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].anchor).toBe("top-left");
  });

  it("stops dispatching after unsubscribe", () => {
    events.startEventBridge();
    const seen: WindowPrefs[] = [];
    const off = events.onWindowPrefsChanged((p) => seen.push(p));
    off();
    fire("window-prefs-changed", {
      rememberPosition: false,
      anchor: "free",
      alwaysOnTop: false,
      clickThrough: true,
      followSpaces: false,
      savedPosition: null,
    });
    expect(seen).toEqual([]);
  });
});
