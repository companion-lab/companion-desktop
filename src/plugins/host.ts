// Plugin host for the webviews: discovers plugin packages via the Rust host,
// imports their frontend bundles as blob-URL modules, and activates them with
// a scoped PluginContext. One bad plugin logs an error and is skipped.
//
// Outside Tauri (plain `vite` runs, e.g. the Playwright e2e), this is a no-op
// so pages render with core contributions only.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import React from "react";
import ReactDOMClient from "react-dom/client";
// Exposed to plugin bundles alongside React: their JSX runtime shim needs the
// real jsx/jsxs (with React's static-children handling) — the main "react"
// entry doesn't export them, which used to force the shim's createElement
// fallback and made dev React warn for every keyless element in any
// multi-child JSX across all plugins.
import * as JsxRuntime from "react/jsx-runtime";
import * as ui from "../ui";
import { createPluginContext } from "./api";
import { registerBuiltinContributions } from "./builtin";import { getSystemPrompts, getTools, removePluginContributions } from "./registry";
import { useSettingsState } from "./settings-context";
import type { CompanionPlugin, PluginInfo, UiExports } from "./types";

let started = false;
let activePluginIds: string[] = [];
// Plugins whose frontend activation is in flight. Tracked synchronously at
// activation start (activePluginIds only updates when it completes), so two
// concurrent triggers — a Plugins-section toggle and the plugins-changed
// sync — can't both start an activation and double-register a plugin.
const activatingIds = new Set<string>();

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function activePlugins(): string[] {
  return [...activePluginIds];
}

/**
 * Idempotent. Registers core contributions immediately (so first paint has
 * the full settings page), then activates plugin frontends asynchronously —
 * their contributions stream in via registry version bumps.
 */
export async function startPluginHost(): Promise<void> {
  if (started) return;
  started = true;

  registerBuiltinContributions();
  if (!isTauri()) return;

  setHostGlobals();
  try {
    const plugins: PluginInfo[] = await invoke("plugin_list");
    const enabled = plugins.filter((p) => p.enabled && p.hasFrontend);
    // Activate concurrently: each plugin reads its bundle, imports, and runs
    // activate() independently, so one slow or broken plugin delays nobody.
    // activePluginIds stays in plugin_list order for deterministic bookkeeping.
    const results = await Promise.allSettled(
      enabled.map((plugin) => activatePlugin(plugin).then(() => plugin.id)),
    );
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        activePluginIds.push(result.value);
      } else {
        console.error(
          `[plugins] ${enabled[i].id} frontend failed to activate:`,
          result.reason,
        );
      }
    });
    const skipped = plugins.filter((p) => !p.enabled).map((p) => p.id);
    if (skipped.length) removePluginContributionsFor(skipped);
  } catch (e) {
    console.warn("[plugins] host unavailable:", e);
  }

  // Live sync: plugins are toggled from another window's Plugins section, and
  // config changes must apply here too — otherwise re-enabling a plugin (e.g.
  // vrm) brings its settings UI back in the settings window while THIS window
  // keeps running without it until a manual reset. Newly enabled frontends
  // activate in this window; newly disabled/deleted ones tear down. Runs in
  // every window, so a toggle anywhere applies everywhere immediately.
  listen<PluginInfo[]>("plugins-changed", (e) => {
    const enabled = e.payload
      .filter((p) => p.enabled && p.hasFrontend)
      .map((p) => p.id);
    for (const id of activePluginIds) {
      if (!enabled.includes(id)) disablePlugins([id]);
    }
    for (const id of enabled) {
      if (!activePluginIds.includes(id)) {
        void enablePlugin(id).catch((err) =>
          console.error(`[plugins] ${id} frontend failed to activate:`, err),
        );
      }
    }
  }).catch(() => {});
}

/** Drop frontend contributions of plugins disabled mid-session. */
export function disablePlugins(pluginIds: string[]): void {
  removePluginContributionsFor(pluginIds);
  activePluginIds = activePluginIds.filter((id) => !pluginIds.includes(id));
}

/** Re-activate a plugin enabled mid-session (e.g. from the Plugins tab). */
export async function enablePlugin(pluginId: string, force = false): Promise<void> {
  if (!isTauri()) return;
  // An activation already in flight does the work for this config change
  // too (the Plugins-section toggle and the plugins-changed sync fire for
  // the same set_enabled, in either order) — never start a second one, even
  // under force: it would double-register the plugin and its widgets.
  if (activatingIds.has(pluginId)) return;
  if (!force && activePluginIds.includes(pluginId)) return;
  // Drop any stale tracking entry so re-activation is clean. Mark the
  // activation as in flight SYNCHRONOUSLY, before the first await.
  activePluginIds = activePluginIds.filter((id) => id !== pluginId);
  activatingIds.add(pluginId);
  try {
    const plugins: PluginInfo[] = await invoke("plugin_list");
    const plugin = plugins.find((p) => p.id === pluginId);
    if (!plugin) {
      console.warn("[plugins] enablePlugin: not found", pluginId);
      return;
    }
    if (!plugin.enabled) {
      console.warn("[plugins] enablePlugin: disabled", pluginId);
      return;
    }
    if (!plugin.hasFrontend) {
      console.warn("[plugins] enablePlugin: no frontend", pluginId);
      return;
    }
    await activatePlugin(plugin);
    activePluginIds.push(pluginId);
  } finally {
    activatingIds.delete(pluginId);
  }
}

async function activatePlugin(plugin: PluginInfo): Promise<void> {
  const base64 = await invoke<string>("plugin_read_frontend", {
    plugin_id: plugin.id,
  });
  const mod = (await importPluginModule(base64)) as Partial<CompanionPlugin> & {
    default?: Partial<CompanionPlugin>;
  };
  const activate = mod.activate ?? mod.default?.activate;
  if (typeof activate !== "function") {
    throw new Error("bundle has no activate() export");
  }
  await activate(createPluginContext(plugin.id));
  console.log(`[plugins] ${plugin.id} activated`);
}

function removePluginContributionsFor(ids: string[]) {
  for (const id of ids) removePluginContributions(id);
}

/**
 * Shared host globals for plugin bundles. They import react/@tauri-apps
 * through the `@companion/plugin` host-bridge, which reads these — plugins
 * never bundle their own copies. `tools.get` exposes the frontend tool
 * registry so the chat plugin can offer ctx.tools.register() tools to the
 * model and route their calls (the registry lives in this bundle, plugin
 * bundles cannot import it directly).
 */
function setHostGlobals() {
  const w = window as unknown as {
    __companion_host__?: {
      React: unknown;
      ReactDOMClient: unknown;
      JsxRuntime: unknown;
      settings: { useSettingsState: typeof useSettingsState };
      ui: UiExports;
      tools: { get: typeof getTools };
      systemPrompts: { get: () => string[] };
    };
  };
  w.__companion_host__ = {
    React,
    ReactDOMClient,
    JsxRuntime,
    settings: { useSettingsState },
    ui: ui as UiExports,
    tools: { get: getTools },
    systemPrompts: { get: getSystemPrompts },
  };
}

async function importPluginModule(base64: string): Promise<unknown> {
  const bytes = await base64ToBytes(base64);
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "text/javascript" }),
  );
  try {
    // @vite-ignore: the URL only exists at runtime (plugin bundle fetched
    // from the Rust host), so the bundler must leave this import alone.
    return await import(/* @vite-ignore */ url);
  } finally {
    // Revoke late: import() must finish fetching/evaluating the module first.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

async function base64ToBytes(base64: string): Promise<ArrayBuffer> {
  // Native webview decoder (data: URL fetch) — faster than a JS char loop
  // and it doesn't pin the main thread for the whole decode.
  const res = await fetch(`data:application/octet-stream;base64,${base64}`);
  return res.arrayBuffer();
}
