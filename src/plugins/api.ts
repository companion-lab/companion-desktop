// Builds the capability-scoped PluginContext handed to a plugin frontend at
// activation. This is the only object plugins touch; everything routes
// through the registry or namespaced host commands.

import { emit as tauriEmit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import * as ui from "../ui";
import { avatarBus, setAvatarHandlers } from "../avatar-bus";
import { registerSttProvider, registerTtsProvider } from "../services/registry";
import { sttProvider } from "../services/stt";
import { ttsProvider } from "../services/tts";
import {
  registerContextMenuItem,
  registerSection,
  registerSystemPrompt,
  registerTab,
  registerTool,
  registerWidget,
  replaceSection,
  overrideTab,
  overrideWidget,
} from "./registry";
import type {
  PluginContext,
  SettingsTabContribution,
  ToolContribution,
  UiExports,
} from "./types";

// Re-exported so plugins can keep importing icons/helpers they registered.
export type { SettingsTabContribution, ToolContribution };

function prefixLog(id: string) {
  const p = `[plugin:${id}]`;
  return {
    info: (msg: string) => console.info(p, msg),
    warn: (msg: string) => console.warn(p, msg),
    error: (msg: string) => console.error(p, msg),
  };
}

/** Keychain account names are namespaced per plugin to avoid collisions. */
function secretAccount(pluginId: string, name: string): string {
  return `${pluginId}:${name}`;
}

export function createPluginContext(pluginId: string): PluginContext {
  return {
    id: pluginId,
    log: prefixLog(pluginId),

    settings: {
      registerTab: (tab) => registerTab(pluginId, tab),
      overrideTab: (id, component) => overrideTab(pluginId, id, component),
      registerSection: (section) =>
        registerSection(pluginId, {
          ...section,
          // Default ordering bands: "top" lands before the core sections
          // (order 100), "bottom" after them.
          order: section.order ?? (section.slot === "top" ? 50 : 150),
        }),
      replaceSection: (id, component) => replaceSection(pluginId, id, component),
    },

    main: {
      registerWidget: (widget) => registerWidget(pluginId, widget),
      overrideWidget: (targetId, component) =>
        overrideWidget(pluginId, targetId, component),
      registerContextMenuItem: (item) => registerContextMenuItem(pluginId, item),
    },

    tools: {
      register: (tool) => registerTool(pluginId, tool),
    },
    systemPrompt: {
      register: (fragment) => registerSystemPrompt(pluginId, fragment),
    },

    backend: {
      call: <T = unknown>(method: string, payload?: unknown) =>
        invoke<T>("plugin_call", {
          plugin_id: pluginId,
          method,
          payload: payload ?? null,
        }),
    },

    events: {
      on: (event, cb) => {
        let unlisten: (() => void) | null = null;
        let disposed = false;
        listen(`plugin:${pluginId}:${event}`, (e) => cb(e.payload))
          .then((fn) => {
            if (disposed) fn();
            else unlisten = fn;
          })
          .catch((err) => console.error(`[plugin:${pluginId}] listen failed`, err));
        return () => {
          disposed = true;
          unlisten?.();
        };
      },
      emit: (event, payload) => {
        void tauriEmit(`plugin:${pluginId}:${event}`, payload ?? null);
      },
    },

    storage: {
      get: <T = unknown,>(key: string) =>
        invoke<T | null>("plugin_storage_get", { plugin_id: pluginId, key }),
      set: async (key, value) => {
        await invoke("plugin_storage_set", { plugin_id: pluginId, key, value: value ?? null });
      },
      remove: async (key) => {
        await invoke("plugin_storage_set", { plugin_id: pluginId, key, value: null });
      },
    },

    avatar: {
      setEmotion: (name) => avatarBus().setEmotion(name),
      triggerMotion: (name) => avatarBus().triggerMotion(name),
      setViseme: (name, weight) => avatarBus().setViseme(name, weight),
      registerMotion: (def) => avatarBus().registerMotion(def),
      registerEmotion: (def) => avatarBus().registerEmotion(def),
      loadModel: (source) => avatarBus().loadModel(source),
      loadVrmaBase64: (data, name) => avatarBus().loadVrmaBase64(data, name),
      reloadLibrary: (motions, emotions) => avatarBus().reloadLibrary(motions, emotions),
      describeCapabilities: () => avatarBus().describeCapabilities(),
      // Engine side of the bus: the plugin that owns the avatar runtime
      // (currently the vrm plugin) installs the live handlers here.
      provide: (handlers) => setAvatarHandlers(handlers),
    },

    services: {
      registerTts: (provider) => registerTtsProvider(pluginId, provider),
      registerStt: (provider) => registerSttProvider(pluginId, provider),
      tts: () => ttsProvider(),
      stt: () => sttProvider(),
    },

    secrets: {
      set: async (name, value) => {
        if (!value) {
          await invoke("secret_delete", { name: secretAccount(pluginId, name) });
          return;
        }
        await invoke("secret_set", {
          value,
          name: secretAccount(pluginId, name),
        });
      },
      get: (name) =>
        invoke<string | null>("secret_get", { name: secretAccount(pluginId, name) }),
      remove: async (name) => {
        await invoke("secret_delete", { name: secretAccount(pluginId, name) });
      },
    },

    ui: ui as UiExports,
  };
}
