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

export async function loadPerf(): Promise<PerformanceConfig> {
  try {
    const cfg = await invoke<PerformanceConfig>("get_performance_config");
    return { ...DEFAULT_PERF, ...cfg };
  } catch {
    return { ...DEFAULT_PERF };
  }
}

export async function savePerf(cfg: PerformanceConfig): Promise<PerformanceConfig> {
  // The backend persists the file and emits perf-changed to all windows.
  return invoke<PerformanceConfig>("set_performance_config", { config: cfg });
}

