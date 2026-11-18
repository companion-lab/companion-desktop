import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SttProvider, TtsProvider } from "../plugins/types";
import {
  activeSttProvider,
  activeTtsProvider,
  onProvidersChanged,
  registerSttProvider,
  registerTtsProvider,
  removePluginServices,
  resetServicesForTests,
} from "./registry";
import { sttProvider } from "./stt";
import { ttsProvider } from "./tts";

// Minimal provider doubles: the registry only stores and hands them out,
// so the call bodies never run in these tests.
function fakeTts(id: string): TtsProvider {
  return {
    id,
    speak: async (_text, _settings, _onViseme, onEnd) => onEnd(),
    speakLoop: async (_text, _settings, _onViseme, onEnd) => onEnd(),
    createStream: () => ({ push: () => {}, flush: () => {}, stop: () => {} }),
    stop: () => {},
    setVolume: () => {},
  };
}

function fakeStt(id: string): SttProvider {
  return {
    id,
    createEngine: () => ({
      start: async () => {},
      stop: async () => ({}),
      setBargeInListener: () => {},
      discardPending: () => {},
      shouldSend: () => true,
    }),
    setSuppress: () => {},
    micEnergy: async () => 0,
  };
}

beforeEach(() => {
  resetServicesForTests();
  vi.restoreAllMocks();
});

describe("TTS takeover stack", () => {
  it("activates the only registration", () => {
    registerTtsProvider("voice", fakeTts("voice"));
    expect(activeTtsProvider()?.id).toBe("voice");
  });

  it("stacks takeovers: the latest registration wins", () => {
    registerTtsProvider("voice", fakeTts("voice"));
    registerTtsProvider("sakura", fakeTts("sakura"));
    expect(activeTtsProvider()?.id).toBe("sakura");
  });

  it("registering null hands the slot back to the provider underneath", () => {
    registerTtsProvider("voice", fakeTts("voice"));
    registerTtsProvider("sakura", fakeTts("sakura"));
    registerTtsProvider("sakura", null);
    expect(activeTtsProvider()?.id).toBe("voice");
  });

  it("re-registering the same plugin replaces its stack entry in place", () => {
    registerTtsProvider("voice", fakeTts("voice"));
    registerTtsProvider("sakura", fakeTts("sakura"));
    // Same pluginId: must not grow the stack (old entry is dropped first).
    registerTtsProvider("sakura", fakeTts("sakura-v2"));
    registerTtsProvider("sakura", null);
    expect(activeTtsProvider()?.id).toBe("voice");
  });

  it("empties to null when the stack drains completely", () => {
    registerTtsProvider("voice", fakeTts("voice"));
    registerTtsProvider("voice", null);
    expect(activeTtsProvider()).toBeNull();
  });

  it("warns when a takeover stacks on top of an existing provider", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerTtsProvider("voice", fakeTts("voice"));
    expect(warn).not.toHaveBeenCalled();
    registerTtsProvider("sakura", fakeTts("sakura"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("taken over by sakura");
  });
});

describe("STT registration", () => {
  it("is last-registration-wins", () => {
    registerSttProvider("voice", fakeStt("voice"));
    registerSttProvider("cloud", fakeStt("cloud"));
    expect(activeSttProvider()?.id).toBe("cloud");
  });

  it("null clears the provider", () => {
    registerSttProvider("voice", fakeStt("voice"));
    registerSttProvider("voice", null);
    expect(activeSttProvider()).toBeNull();
  });

  it("warns when a second plugin takes an owned slot", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerSttProvider("voice", fakeStt("voice"));
    registerSttProvider("voice", fakeStt("voice-v2"));
    expect(warn).not.toHaveBeenCalled(); // same owner replacing itself
    registerSttProvider("cloud", fakeStt("cloud"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("replaced by cloud");
  });
});

describe("removePluginServices", () => {
  it("restores the TTS provider underneath a removed takeover", () => {
    registerTtsProvider("voice", fakeTts("voice"));
    registerTtsProvider("sakura", fakeTts("sakura"));
    removePluginServices("sakura");
    expect(activeTtsProvider()?.id).toBe("voice");
  });

  it("leaves unrelated registrations alone", () => {
    registerTtsProvider("voice", fakeTts("voice"));
    registerSttProvider("voice", fakeStt("voice"));
    removePluginServices("other-plugin");
    expect(activeTtsProvider()?.id).toBe("voice");
    expect(activeSttProvider()?.id).toBe("voice");
  });

  it("drops the STT provider only when the removed plugin owns it", () => {
    registerSttProvider("voice", fakeStt("voice"));
    removePluginServices("cloud");
    expect(activeSttProvider()?.id).toBe("voice");
    removePluginServices("voice");
    expect(activeSttProvider()).toBeNull();
  });
});

describe("onProvidersChanged", () => {
  it("notifies on every registration change", () => {
    const seen: Array<string | null> = [];
    onProvidersChanged(() => seen.push(activeTtsProvider()?.id ?? null));
    registerTtsProvider("voice", fakeTts("voice"));
    registerTtsProvider("voice", null);
    expect(seen).toEqual(["voice", null]);
  });

  it("unsubscribes", () => {
    const calls: number[] = [];
    const off = onProvidersChanged(() => calls.push(calls.length));
    registerSttProvider("voice", fakeStt("voice"));
    off();
    registerSttProvider("voice", null);
    expect(calls).toEqual([0]);
  });

  it("a throwing listener does not break the others", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const other = vi.fn();
    onProvidersChanged(() => {
      throw new Error("boom");
    });
    onProvidersChanged(other);
    registerSttProvider("voice", fakeStt("voice"));
    expect(other).toHaveBeenCalledTimes(1);
    // The registry swallows listener errors silently.
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("consumer facades", () => {
  it("ttsProvider() falls back to the silent no-op provider", async () => {
    const tts = ttsProvider();
    expect(tts.id).toBe("none");
    // Speaking without a voice plugin completes silently.
    const onEnd = vi.fn();
    await tts.speak("hi", {}, () => {}, onEnd);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("ttsProvider() returns the registered provider", () => {
    registerTtsProvider("voice", fakeTts("voice"));
    expect(ttsProvider().id).toBe("voice");
  });

  it("sttProvider() is null without a voice plugin (text-only mode)", () => {
    expect(sttProvider()).toBeNull();
  });

  it("sttProvider() returns the registered provider", () => {
    registerSttProvider("voice", fakeStt("voice"));
    expect(sttProvider()?.id).toBe("voice");
  });
});
