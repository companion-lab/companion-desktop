// Plugin capability registry: feature plugins publish named capability
// providers (e.g. the vision plugin's `vision.capture`); other plugins
// consume them through ctx.capabilities.
//
// Unlike the TTS/STT services registry (typed facades, fixed kinds),
// capabilities are generic: any plugin may publish any named provider and
// consumers decide the shape they expect (structural typing at the call
// site). Names are namespaced by the owning plugin id (`"<pluginId>.<name>"`)
// so a plugin can never spoof another plugin's capability — mirroring how
// events are hard-namespaced as `plugin:{id}:{event}`.
//
// Registry state is per-webview module state, like the services registry:
// plugin frontends activate in both windows, so provider and consumer
// coexist in whichever window the consumer runs in.

import type { CapabilityMethods, CapabilityProvider } from "./types";

type Entry = { pluginId: string; provider: CapabilityProvider };

const providers = new Map<string, Entry>();
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

/** Publish a capability under `"<pluginId>.<name>"`. Pass null to
 *  unregister (plugin teardown). Throws when the name is not namespaced by
 *  the publishing plugin's own id — that prefix is the anti-spoofing rule,
 *  so `vision.capture` can only ever come from the vision plugin. */
export function registerCapability(
  pluginId: string,
  name: string,
  provider: CapabilityProvider | null,
): void {
  const prefix = `${pluginId}.`;
  if (!name.startsWith(prefix) || name.length <= prefix.length) {
    throw new Error(
      `[capabilities] capability "${name}" must be namespaced as "${prefix}<name>"`,
    );
  }
  if (!provider) {
    if (providers.get(name)?.pluginId === pluginId) providers.delete(name);
    notify();
    return;
  }
  providers.set(name, { pluginId, provider });
  notify();
}

/** The provider registered under `name`, or null when absent. */
export function useCapability<M extends CapabilityMethods = CapabilityMethods>(
  name: string,
): { pluginId: string; description?: string; methods: M } | null {
  const e = providers.get(name);
  return e ? { pluginId: e.pluginId, description: e.provider.description, methods: e.provider.methods as M } : null;
}

/** Every registered capability, with its owning plugin (discovery surface). */
export function listCapabilities(): Array<{
  name: string;
  pluginId: string;
  description?: string;
}> {
  return [...providers.entries()].map(([name, e]) => ({
    name,
    pluginId: e.pluginId,
    description: e.provider.description,
  }));
}

/** Subscribe to registrations/removals. Returns the unsubscribe function. */
export function onCapabilitiesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Drop the capabilities owned by `pluginId` — called with the rest of the
 *  plugin's contribution teardown (disable/uninstall). */
export function removePluginCapabilities(pluginId: string): void {
  let changed = false;
  for (const [name, e] of [...providers]) {
    if (e.pluginId === pluginId) {
      providers.delete(name);
      changed = true;
    }
  }
  if (changed) notify();
}

/** Test helper: clear every registration. */
export function resetCapabilitiesForTests(): void {
  providers.clear();
  listeners.clear();
}
