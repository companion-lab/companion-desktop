// Builds the capability-scoped PluginContext handed to a plugin frontend at
// activation. This is the only object plugins touch; everything routes
// through the registry or namespaced host commands.

import { emit as tauriEmit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import * as ui from "../ui";
import { avatarBus, setAvatarHandlers } from "../avatar-bus";
import { registerSttProvider, registerTtsProvider } from "../services/registry";
import { sttProvider } from "../services/stt";
import { ttsProvider } from "../services/tts";
import { applyWindowSize } from "../window-size";
import {
  getMainWindow,
  mainWindowLogicalPosition,
  mainWindowLogicalSize,
  setClickThroughOverride,
  snapToAnchor,
} from "../window-control";
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
  LogicalSizeLike,
  PluginContext,
  SettingsTabContribution,
  ToolContribution,
  UiExports,
  WindowSurface,
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

/** The live runtime surface behind `ctx.window`. Routes to the main window
 *  from any webview; reuses applyWindowSize for the GTK min-size dance. */
function buildWindowSurface(): WindowSurface {
  // Window events deliver physical px without a scale attached, so convert
  // with the main window's current scale factor.
  const mainScale = async (): Promise<number> => {
    const win = await getMainWindow();
    return (win ? await win.scaleFactor() : 1) || 1;
  };
  const listenMain = async (
    event: "tauri://move" | "tauri://resize",
    handler: (e: { payload: unknown }) => void,
  ): Promise<() => void> => {
    const win = await getMainWindow();
    if (!win) return () => {};
    return win.listen(event, handler);
  };
  return {
    getSize: () => mainWindowLogicalSize(),
    setSize: async (size: LogicalSizeLike) => {
      await applyWindowSize(size);
    },
    getPosition: () => mainWindowLogicalPosition(),
    setPosition: async (pos) => {
      if (typeof pos === "string") {
        await snapToAnchor(pos);
        return;
      }
      const win = await getMainWindow();
      if (!win) return;
      await win.setPosition(new LogicalPosition(pos.x, pos.y));
    },
    setAlwaysOnTop: async (on) => {
      const win = await getMainWindow();
      if (win) await win.setAlwaysOnTop(on);
    },
    setClickThrough: (on) => {
      setClickThroughOverride(on);
    },
    onMoved: (cb) => {
      let unlisten: (() => void) | null = null;
      let disposed = false;
      void listenMain("tauri://move", (e) => {
        const pos = e.payload as { x: number; y: number };
        void mainScale().then((scale) => {
          if (!disposed) cb({ x: pos.x / scale, y: pos.y / scale });
        });
      })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch((err) => console.warn("[window] onMoved listen failed", err));
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
    onResized: (cb) => {
      let unlisten: (() => void) | null = null;
      let disposed = false;
      void listenMain("tauri://resize", (e) => {
        // Resize payloads are PhysicalSize {width, height}, not {x, y}.
        const size = e.payload as { width: number; height: number };
        void mainScale().then((scale) => {
          if (!disposed) cb({ width: size.width / scale, height: size.height / scale });
        });
      })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch((err) => console.warn("[window] onResized listen failed", err));
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
  };
}

/** Throwing stubs for plugins without the "window" permission — always
 *  present so the failure is a clear error, not an undefined access. */
function forbiddenWindowSurface(pluginId: string): WindowSurface {
  const msg = `[plugin:${pluginId}] ctx.window requires the "window" permission in manifest.json`;
  const deny = () => {
    throw new Error(msg);
  };
  return {
    getSize: deny,
    setSize: deny,
    getPosition: deny,
    setPosition: deny,
    setAlwaysOnTop: deny,
    setClickThrough: deny,
    onMoved: deny,
    onResized: deny,
  };
}

export function createPluginContext(
  pluginId: string,
  permissions: string[] = [],
): PluginContext {
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

    window: permissions.includes("window")
      ? buildWindowSurface()
      : forbiddenWindowSurface(pluginId),

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
