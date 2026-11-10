// Service registry: feature plugins publish capability providers (TTS, STT);
// host code and other plugins consume them through the typed facades in
// services/tts.ts and services/stt.ts.
//
// One active provider per service kind. TTS is a takeover stack: a plugin
// can take the slot (e.g. the sakura voice plugin while its toggle is on)
// and hand it back by registering null, which restores the provider
// underneath without a restart. STT stays last-registration-wins. When
// nothing is registered the facades fall back to no-op/local
// implementations.

import type { SttProvider, TtsProvider } from "../plugins/types";

// TTS takeover stack, registration order: [stock, ..., current].
const ttsStack: Array<{ pluginId: string; provider: TtsProvider }> = [];
let ttsProvider: TtsProvider | null = null;
let sttProvider: SttProvider | null = null;
// Owning plugin per service kind, so a disabled/uninstalled plugin's
// provider is unregistered with the rest of its contributions. Without
// this, disabling the stt plugin left its provider here and consumers
// (the chat mic button) kept treating speech as available.
let sttOwner: string | null = null;

const listeners = new Set<() => void>();

function notify() {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* listener errors must not break registration */
    }
  }
}

/** Subscribe to provider changes (e.g. voice plugin installed/uninstalled). */
export function onProvidersChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Publish the TTS provider. Pass null to unregister — the previous
 *  registration (if any) becomes active again. */
export function registerTtsProvider(pluginId: string, provider: TtsProvider | null): void {
  const idx = ttsStack.findIndex((e) => e.pluginId === pluginId);
  if (idx !== -1) ttsStack.splice(idx, 1);
  if (provider) {
    if (ttsStack.length > 0) {
      console.warn(
        `[services] tts provider taken over by ${pluginId} (${ttsStack.length} provider(s) stacked underneath)`,
      );
    }
    ttsStack.push({ pluginId, provider });
  }
  const top = ttsStack[ttsStack.length - 1] ?? null;
  ttsProvider = top?.provider ?? null;
  notify();
}

/** Publish the STT provider. Pass null to unregister (plugin removal). */
export function registerSttProvider(pluginId: string, provider: SttProvider | null): void {
  if (provider && sttProvider && sttOwner !== pluginId) {
    console.warn(`[services] stt provider already registered by ${sttOwner}; replaced by ${pluginId}`);
  }
  sttProvider = provider;
  sttOwner = provider ? pluginId : null;
  notify();
}

/** Drop the service providers owned by `pluginId` — called with the rest of
 *  the plugin's contribution teardown (disable/uninstall). */
export function removePluginServices(pluginId: string): void {
  const idx = ttsStack.findIndex((e) => e.pluginId === pluginId);
  if (idx !== -1) {
    ttsStack.splice(idx, 1);
    const top = ttsStack[ttsStack.length - 1] ?? null;
    ttsProvider = top?.provider ?? null;
    }
  if (sttOwner === pluginId) {
    sttProvider = null;
    sttOwner = null;
  }
  notify();
}

export function activeTtsProvider(): TtsProvider | null {
  return ttsProvider;
}

export function activeSttProvider(): SttProvider | null {
  return sttProvider;
}
