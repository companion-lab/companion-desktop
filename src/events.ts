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

type Listener<T> = (payload: T) => void;

const uiPrefsChangedListeners = new Set<Listener<UiPrefs>>();

let started = false;

export function startEventBridge() {
  if (started) return;
  started = true;

  listen<UiPrefs>("ui-prefs-changed", (e) => {
    uiPrefsChangedListeners.forEach((l) => l(e.payload));
  }).catch(() => {});
}

export function onUiPrefsChanged(l: Listener<UiPrefs>): () => void {
  uiPrefsChangedListeners.add(l);
  return () => uiPrefsChangedListeners.delete(l);
}
