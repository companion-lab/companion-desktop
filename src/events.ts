import { listen } from "@tauri-apps/api/event";

// Cross-window event bridge for CORE channels only. Everything feature-owned
// (alarms, calendar, voice, library, chat, avatar perf/mixer) flows through
// its plugin's namespaced events (`plugin:{id}:{event}`) or host-global
// channels plugins subscribe to directly; this file keeps just the channels
// core code still owns.

export type PerformanceConfig = {
  load_mode: "eager" | "lazy";
  tts_threads: number;
  unload_stt_when_idle: boolean;
  max_pixel_ratio: number;
  fps_cap: "thirty" | "sixty" | "uncapped";
  antialias: boolean;
};

export type UiPrefs = {
  hideChat: boolean;
  micShortcut: string;
  /** Talk over the avatar to interrupt it. Default true. */
  bargeIn?: boolean;
};

/** Corner snap presets. `center` is a plugin-facing nicety; the settings
 *  section only offers the four corners plus "free". */
export type WindowAnchor =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "center";

export type WindowPrefs = {
  /** Re-apply the last saved position at startup. */
  rememberPosition: boolean;
  /** Last chosen snap preset; one-shot action, not a locked constraint
   *  (dragging the window afterwards is free and keeps the highlight). */
  anchor: "free" | Exclude<WindowAnchor, "center">;
  alwaysOnTop: boolean;
  /** Cursor pass-through over transparent pixels. Default on — the desktop
   *  pet's core behavior. */
  clickThrough: boolean;
  /** macOS only: follow every Space / coexist with fullscreen apps. */
  followSpaces: boolean;
  /** Main-window accent color (hex), applied as the `--c-accent` theme
   *  token. Null = default. */
  accent: string | null;
  /** Last window position (physical px), persisted after drags. */
  savedPosition: { x: number; y: number } | null;
};

type Listener<T> = (payload: T) => void;

const uiPrefsChangedListeners = new Set<Listener<UiPrefs>>();
const windowPrefsChangedListeners = new Set<Listener<WindowPrefs>>();

let started = false;

export function startEventBridge() {
  if (started) return;
  started = true;

  listen<UiPrefs>("ui-prefs-changed", (e) => {
    uiPrefsChangedListeners.forEach((l) => l(e.payload));
  }).catch(() => {});

  listen<WindowPrefs>("window-prefs-changed", (e) => {
    windowPrefsChangedListeners.forEach((l) => l(e.payload));
  }).catch(() => {});
}

export function onUiPrefsChanged(l: Listener<UiPrefs>): () => void {
  uiPrefsChangedListeners.add(l);
  return () => uiPrefsChangedListeners.delete(l);
}

export function onWindowPrefsChanged(l: Listener<WindowPrefs>): () => void {
  windowPrefsChangedListeners.add(l);
  return () => windowPrefsChangedListeners.delete(l);
}
