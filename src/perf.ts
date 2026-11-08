import { invoke } from "@tauri-apps/api/core";
import type { PerformanceConfig } from "./events";

export type { PerformanceConfig };

export const DEFAULT_PERF: PerformanceConfig = {
  load_mode: "eager",
  tts_threads: 0,
  unload_stt_when_idle: true,
  max_pixel_ratio: 1.5,
  fps_cap: "sixty",
  antialias: true,
};

// Perf persistence lives in the vrm plugin backend — the graphics settings UI
// is that plugin's — so core reaches it through the plugin host like any
// other method call. The backend persists the file and broadcasts
// `perf-changed` (plugin-namespaced: plugin:vrm:perf-changed) to all windows.

export async function loadPerf(): Promise<PerformanceConfig> {
  try {
    const cfg = await invoke<PerformanceConfig>("plugin_call", {
      plugin_id: "vrm",
      method: "vrm.get_performance_config",
    });
    return { ...DEFAULT_PERF, ...cfg };
  } catch {
    return { ...DEFAULT_PERF };
  }
}

export async function savePerf(cfg: PerformanceConfig): Promise<PerformanceConfig> {
  return invoke<PerformanceConfig>("plugin_call", {
    plugin_id: "vrm",
    method: "vrm.set_performance_config",
    payload: { config: cfg },
  });
}
