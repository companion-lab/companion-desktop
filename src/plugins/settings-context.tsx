// Settings-page state available to settings tab/section contributions.
// Core sections (window size, performance) receive state via this context;
// feature-plugin sections own their settings through their plugin storage.

import { createContext, useContext } from "react";
import type { PerformanceConfig } from "../perf";
import type { WindowSize } from "../window-size";

export type SettingsPageState = {
  perf: PerformanceConfig;
  /** Persists via the backend, like the built-in Performance tab. */
  setPerf: (v: PerformanceConfig) => void;
  winSize: WindowSize;
  setWinSize: (v: WindowSize) => void;
};

const SettingsStateContext = createContext<SettingsPageState | null>(null);

export const SettingsStateProvider = SettingsStateContext.Provider;

export function useSettingsState(): SettingsPageState {
  const value = useContext(SettingsStateContext);
  if (!value) {
    throw new Error(
      "useSettingsState must be used inside the settings window (SettingsStateProvider)",
    );
  }
  return value;
}
