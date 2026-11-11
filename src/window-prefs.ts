// Persistence for the main (companion) window's layout and behavior
// preferences: position restore, snap anchor, always-on-top, click-through,
// macOS follow-Spaces. Mirrors ui-prefs.ts; the `window-prefs-changed`
// broadcast (relayed by events.ts) is how the settings window tells the main
// window — which owns all the applying — that something changed.

import { emit } from "@tauri-apps/api/event";
import type { WindowPrefs } from "./events";

const STORE_KEY = "companion:window";

export const DEFAULT_WINDOW_PREFS: WindowPrefs = {
  rememberPosition: true,
  anchor: "free",
  alwaysOnTop: true,
  clickThrough: true,
  followSpaces: true,
  accent: null,
  savedPosition: null,
};

export function loadWindowPrefs(): WindowPrefs {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...DEFAULT_WINDOW_PREFS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_WINDOW_PREFS };
}

/** Persist (and broadcast when running under Tauri). The main window applies
 *  the diff on receiving the event; other windows just refresh their state. */
export function saveWindowPrefs(prefs: WindowPrefs): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    void emit("window-prefs-changed", prefs).catch((e) =>
      console.warn("window-prefs-changed emit failed", e),
    );
  }
}

/** Read-modify-write helper for single fields (e.g. position tracking while
 *  the user drags). Broadcasts so every window stays in sync. */
export function updateWindowPrefs(patch: Partial<WindowPrefs>): WindowPrefs {
  const next = { ...loadWindowPrefs(), ...patch };
  saveWindowPrefs(next);
  return next;
}
