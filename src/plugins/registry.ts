// Central contribution registry. Built-in features and plugin frontends both
// register here; pages render from these maps instead of hardcoded lists.
//
// Every contribution is tagged with its owning plugin id so disabling a
// plugin removes all of its contributions live. Override maps are
// last-registration-wins (plugins activate after core, so plugins win).

import { useSyncExternalStore } from "react";
import { removePluginServices } from "../services/registry";
import type {
  ContextMenuItemContribution,
  SectionContribution,
  SectionReplacementContribution,
  SettingsTabContribution,
  SystemPromptContribution,
  TabOverrideContribution,
  ToolContribution,
  WidgetContribution,
  WidgetOverrideContribution,
} from "./types";

type Wrapped<T> = { pluginId: string; key: string; order: number; value: T };

type Store = {
  tabs: Map<string, Wrapped<SettingsTabContribution>>;
  tabOverrides: Map<string, Wrapped<TabOverrideContribution>>;
  sections: Map<string, Wrapped<SectionContribution>>;
  sectionReplacements: Map<string, Wrapped<SectionReplacementContribution>>;
  widgets: Map<string, Wrapped<WidgetContribution>>;
  widgetOverrides: Map<string, Wrapped<WidgetOverrideContribution>>;
  contextMenuItems: Map<string, Wrapped<ContextMenuItemContribution>>;
  tools: Map<string, Wrapped<ToolContribution>>;
  systemPrompts: Map<string, Wrapped<SystemPromptContribution>>;
  version: number;
};

const store: Store = {
  tabs: new Map(),
  tabOverrides: new Map(),
  sections: new Map(),
  sectionReplacements: new Map(),
  widgets: new Map(),
  widgetOverrides: new Map(),
  contextMenuItems: new Map(),
  tools: new Map(),
  systemPrompts: new Map(),
  version: 0,
};

const listeners = new Set<() => void>();

function bump() {
  store.version += 1;
  for (const l of listeners) l();
}

export function subscribeRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-render trigger for components that read from the registry. */
export function useRegistryVersion(): number {
  return useSyncExternalStore(subscribeRegistry, () => store.version);
}

let counter = 0;
function wrap<T>(pluginId: string, order: number | undefined, value: T): Wrapped<T> {
  counter += 1;
  return {
    pluginId,
    key: `${pluginId}:${counter}`,
    order: order ?? 100,
    value,
  };
}

function sorted<T>(map: Map<string, Wrapped<T>>): Wrapped<T>[] {
  return [...map.values()].sort((a, b) => a.order - b.order);
}

function register<T>(map: Map<string, Wrapped<T>>, entry: Wrapped<T>, what: string) {
  if (map.has(entry.key)) {
    console.warn(`[plugins] duplicate ${what} key "${entry.key}" ignored`);
    return;
  }
  map.set(entry.key, entry);
  bump();
}

// ---------------------------------------------------------------------------
// Registration (called from api.ts createPluginContext)
// ---------------------------------------------------------------------------

export function registerTab(
  pluginId: string,
  tab: SettingsTabContribution,
) {
  if (store.tabs.has(tab.id)) {
    console.warn(`[plugins] tab id "${tab.id}" already registered; ignored`);
    return;
  }
  store.tabs.set(
    tab.id,
    wrap(pluginId, tab.order, { ...tab, order: tab.order ?? 100 }),
  );
  bump();
}

export function overrideTab(pluginId: string, id: string, component: TabOverrideContribution["component"]) {
  if (!store.tabs.has(id) && !store.tabOverrides.has(id)) {
    console.warn(`[plugins] overriding unknown tab "${id}"`);
  }
  store.tabOverrides.set(id, wrap(pluginId, undefined, { id, component }));
  bump();
}

export function registerSection(pluginId: string, section: SectionContribution) {
  register(store.sections, wrap(pluginId, section.order, section), "section");
}

export function replaceSection(
  pluginId: string,
  id: string,
  component: SectionReplacementContribution["component"],
) {
  store.sectionReplacements.set(
    id,
    wrap(pluginId, undefined, { id, component }),
  );
  bump();
}

export function registerWidget(pluginId: string, widget: WidgetContribution) {
  register(store.widgets, wrap(pluginId, widget.order, widget), "widget");
}

export function overrideWidget(
  pluginId: string,
  targetId: WidgetOverrideContribution["targetId"],
  component: WidgetOverrideContribution["component"],
) {
  store.widgetOverrides.set(
    targetId,
    wrap(pluginId, undefined, { targetId, component }),
  );
  bump();
}

export function registerContextMenuItem(
  pluginId: string,
  item: ContextMenuItemContribution,
) {
  register(
    store.contextMenuItems,
    wrap(pluginId, item.order, item),
    "context menu item",
  );
}

export function registerTool(pluginId: string, tool: ToolContribution) {
  // Qualified name convention shared with MCP: {server}__{name}. One tool per
  // qualified name; re-registration replaces.
  for (const [key, entry] of store.tools) {
    if (entry.pluginId === pluginId && entry.value.name === tool.name) {
      store.tools.delete(key);
    }
  }
  register(store.tools, wrap(pluginId, undefined, tool), "tool");
}

export function registerSystemPrompt(pluginId: string, fragment: SystemPromptContribution) {
  // Re-registering with the same id within one plugin replaces the fragment
  // (last registration wins — mirrors override maps).
  for (const [key, entry] of store.systemPrompts) {
    if (entry.pluginId === pluginId && entry.value.id === fragment.id) {
      store.systemPrompts.delete(key);
    }
  }
  register(
    store.systemPrompts,
    wrap(pluginId, fragment.order, fragment),
    "system prompt",
  );
}

// ---------------------------------------------------------------------------
// Removal (disable/unload)
// ---------------------------------------------------------------------------

export function removePluginContributions(pluginId: string) {
  let changed = false;
  const dropIf = <T,>(map: Map<string, Wrapped<T>>) => {
    for (const [key, entry] of map) {
      if (entry.pluginId === pluginId) {
        map.delete(key);
        changed = true;
      }
    }
  };
  dropIf(store.tabs);
  dropIf(store.tabOverrides);
  dropIf(store.sections);
  dropIf(store.sectionReplacements);
  dropIf(store.widgets);
  dropIf(store.widgetOverrides);
  dropIf(store.contextMenuItems);
  dropIf(store.tools);
  dropIf(store.systemPrompts);
  // Service providers (TTS/STT) are contributions too: a disabled plugin
  // must not keep publishing capabilities (e.g. the chat mic button read
  // the stt provider after the stt plugin was disabled).
  removePluginServices(pluginId);
  if (changed) bump();
}

// ---------------------------------------------------------------------------
// Readers (pages call these; pair with useRegistryVersion)
// ---------------------------------------------------------------------------

export function getTabs(): (SettingsTabContribution & { order: number })[] {
  // Group tabs so the sidebar never splits a group: group by `group`, keeping
  // first-appearance order of groups, and sort within each group by `order`.
  // (A flat sort by `order` would interleave groups and duplicate headers.)
  const groupOrder: string[] = [];
  const byGroup = new Map<string, Wrapped<SettingsTabContribution>[]>();
  for (const w of store.tabs.values()) {
    if (!byGroup.has(w.value.group)) {
      byGroup.set(w.value.group, []);
      groupOrder.push(w.value.group);
    }
    byGroup.get(w.value.group)!.push(w);
  }
  const out: (SettingsTabContribution & { order: number })[] = [];
  for (const g of groupOrder) {
    const items = [...byGroup.get(g)!].sort((a, b) => a.order - b.order);
    for (const w of items) out.push({ ...w.value, order: w.order });
  }
  return out;
}

export function getTabIds(): string[] {
  return getTabs().map((t) => t.id);
}

export function hasTab(id: string): boolean {
  return store.tabs.has(id);
}

/** One tab contribution by id — carries the whole-tab `component` when the
 *  tab declared one (core tabs are section-assembled and have none). */
export function getTab(id: string): SettingsTabContribution | undefined {
  return store.tabs.get(id)?.value;
}

export function getTabOverride(id: string): TabOverrideContribution["component"] | undefined {
  const entry = store.tabOverrides.get(id);
  return entry?.value.component;
}

/**
 * Sections for a tab as one ordered list. Ordering bands: order < 100 sorts
 * before the core sections, order > 100 after them (api.ts defaults plugin
 * contributions to 50 for `slot: "top"` and 150 for `slot: "bottom"`; core
 * sections are 100 and keep registration order among themselves).
 */
export function getSectionsForTab(tabId: string): SectionContribution[] {
  return sorted(store.sections)
    .filter((w) => w.value.tabId === tabId)
    .map((w) => w.value);
}

export function getSectionReplacement(
  id: string,
): SectionReplacementContribution["component"] | undefined {
  return store.sectionReplacements.get(id)?.value.component;
}

export function getWidgets(slot: string): WidgetContribution[] {
  return sorted(store.widgets)
    .filter((w) => w.value.slot === slot)
    .map((w) => w.value);
}

export function getWidgetOverride(
  targetId: string,
): WidgetOverrideContribution["component"] | undefined {
  return store.widgetOverrides.get(targetId)?.value.component;
}

export function getContextMenuItems(): ContextMenuItemContribution[] {
  return sorted(store.contextMenuItems).map((w) => w.value);
}

/** All frontend-registered tools, keyed by qualified name `{pluginId}__{name}`. */
export function getTools(): Map<string, ToolContribution> {
  const out = new Map<string, ToolContribution>();
  for (const w of store.tools.values()) {
    out.set(`${w.pluginId}__${w.value.name}`, w.value);
  }
  return out;
}

/** Plugin-contributed system-prompt fragments, sorted by `order` (then
 *  insertion order). Empty/whitespace text is filtered. Reactivity: the
 *  registry bumps on every registration/removal, so callers should read
 *  this live (e.g. on each chat turn). */
export function getSystemPrompts(): string[] {
  const sorted = [...store.systemPrompts.values()].sort((a, b) => a.order - b.order);
  const out: string[] = [];
  for (const w of sorted) {
    const text = (w.value.text ?? "").trim();
    if (text) out.push(text);
  }
  return out;
}

/** Test helper: wipe every contribution. */
export function resetRegistryForTests() {
  store.tabs.clear();
  store.tabOverrides.clear();
  store.sections.clear();
  store.sectionReplacements.clear();
  store.widgets.clear();
  store.widgetOverrides.clear();
  store.contextMenuItems.clear();
  store.tools.clear();
  store.systemPrompts.clear();
  bump();
}
