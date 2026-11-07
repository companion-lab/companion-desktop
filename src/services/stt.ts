// STT provider access: plugin consumers reach the active provider via
// ctx.services.stt(). Delegates to the provider registered by the voice
// plugin; with the plugin absent there is no speech recognition — callers
// must handle null (text-only mode).

import type { SttProvider } from "../plugins/types";
import { activeSttProvider } from "./registry";

/** Active provider, or null when no voice plugin is installed. */
export function sttProvider(): SttProvider | null {
  return activeSttProvider();
}
