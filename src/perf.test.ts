import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { loadPerf, savePerf, DEFAULT_PERF } from "./perf";

beforeEach(() => {
  invoke.mockReset();
});

describe("loadPerf", () => {
  it("merges backend config over the defaults", async () => {
    invoke.mockResolvedValue({ fps_cap: "thirty" });
    expect(await loadPerf()).toEqual({ ...DEFAULT_PERF, fps_cap: "thirty" });
    expect(invoke).toHaveBeenCalledWith("plugin_call", {
      plugin_id: "vrm",
      method: "vrm.get_performance_config",
    });
  });

  it("falls back to defaults when the backend errors", async () => {
    invoke.mockRejectedValue(new Error("no config"));
    expect(await loadPerf()).toEqual({ ...DEFAULT_PERF });
  });
});

describe("savePerf", () => {
  it("forwards the config and returns the backend result", async () => {
    invoke.mockResolvedValue({ ...DEFAULT_PERF, tts_threads: 4 });
    const cfg = { ...DEFAULT_PERF, tts_threads: 4 };
    expect(await savePerf(cfg)).toEqual({ ...DEFAULT_PERF, tts_threads: 4 });
    expect(invoke).toHaveBeenCalledWith("plugin_call", {
      plugin_id: "vrm",
      method: "vrm.set_performance_config",
      payload: { config: cfg },
    });
  });

  it("propagates write failures", async () => {
    invoke.mockRejectedValue(new Error("read-only fs"));
    await expect(savePerf(DEFAULT_PERF)).rejects.toThrow("read-only fs");
  });
});
