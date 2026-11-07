import type { UiPrefs } from "./events";

const STORE_KEY = "companion:ui";

export const DEFAULT_UI_PREFS: UiPrefs = {
  hideChat: false,
  micShortcut: "Ctrl+Shift+M",
};

export function loadUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...DEFAULT_UI_PREFS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_UI_PREFS };
}

export function saveUiPrefs(p: UiPrefs): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

export function normalizeShortcut(s: string): string {
  const parts = s.split("+").map((p) => p.trim()).filter(Boolean);
  const mods: string[] = [];
  let key = "";
  for (const p of parts) {
    const l = p.toLowerCase();
    if (["ctrl", "control"].includes(l)) mods.push("Ctrl");
    else if (l === "shift") mods.push("Shift");
    else if (l === "alt") mods.push("Alt");
    else if (["meta", "cmd", "command", "super"].includes(l)) mods.push("Meta");
    else key = p.length === 1 ? p.toUpperCase() : p;
  }
  const order = ["Ctrl", "Shift", "Alt", "Meta"];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return key ? [...mods, key].join("+") : mods.join("+");
}

export function shortcutFromEvent(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.shiftKey) mods.push("Shift");
  if (e.altKey) mods.push("Alt");
  if (e.metaKey) mods.push("Meta");
  const k = e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(k)) return null;
  const key = k.length === 1 ? k.toUpperCase() : k;
  if (!mods.length) return null;
  return [...mods, key].join("+");
}
