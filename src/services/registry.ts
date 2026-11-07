// Service registry: feature plugins publish capability providers (TTS, STT);
// host code and other plugins consume them through the typed facades in
// services/tts.ts and services/stt.ts.
//
// One provider per service kind: registering replaces the previous one, and
// the facades fall back to no-op/local implementations when nothing is
// registered (e.g. voice plugin uninstalled).

import type { SttProvider, TtsProvider } from "../plugins/types";

let ttsProvider: TtsProvider | null = null;
let sttProvider: SttProvider | null = null;
// Owning plugin per service kind, so a disabled/uninstalled plugin's
// provider is unregistered with the rest of its contributions. Without
// this, disabling the stt plugin left its provider here and consumers
// (the chat mic button) kept treating speech as available.
let ttsOwner: string | null = null;
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

/** Publish the TTS provider. Pass null to unregister (plugin removal). */
export function registerTtsProvider(pluginId: string, provider: TtsProvider | null): void {
  if (provider && ttsProvider && ttsOwner !== pluginId) {
    console.warn(`[services] tts provider already registered by ${ttsOwner}; replaced by ${pluginId}`);
  }
  ttsProvider = provider;
  ttsOwner = provider ? pluginId : null;
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
  if (ttsOwner === pluginId) {
    ttsProvider = null;
    ttsOwner = null;
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
