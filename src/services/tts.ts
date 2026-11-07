// TTS provider access: plugin consumers reach the active provider via
// ctx.services.tts(). Delegates to the provider registered by the voice
// plugin; with the plugin absent, speech is silent.

import type { TtsProvider } from "../plugins/types";
import { activeTtsProvider } from "./registry";

const silentTts: TtsProvider = {
  id: "none",
  speak: async (_text, _settings, _onViseme, onEnd) => onEnd(),
  speakLoop: async (_text, _settings, _onViseme, onEnd) => onEnd(),
  createStream: () => ({
    push: () => {},
    flush: () => {},
    stop: () => {},
  }),
  stop: () => {},
  setVolume: () => {},
};

/** Active provider: registered voice plugin, else silent. */
export function ttsProvider(): TtsProvider {
  return activeTtsProvider() ?? silentTts;
}
