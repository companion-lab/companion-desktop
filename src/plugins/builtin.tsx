// Core contributions: the built-in settings tabs and sections registered
// through the exact same API plugins use. The settings page renders purely
// from the registry, which is what makes plugin overrides possible.
//
// Every feature menu now lives with its owning plugin: the vrm plugin owns
// the Model / Motion & Emotion / Graphics tabs AND the idle-mixer section
// (its engine owns the mixer), chat owns Connection (its api card plus the
// stt/tts cloud endpoint sections render there keyed by tabId), and
// mcp/alarms/calendar own their name-sake tabs. Core keeps only the tabs
// that are genuinely host-level:
//
// Section ids are the override contract for `replaceSection`:
//   general.windowSize
//   general.window
//   plugins.plugins
//   about.update
// (Feature-owned General-tab ids: general.chatbox + general.persona → chat
// plugin, general.voiceInput → stt plugin.)

import { memo } from "react";
import type { SettingsTabContribution } from "./types";
import { registerSection, registerTab } from "./registry";
import { useSettingsState } from "./settings-context";
import { PluginsSection } from "./PluginsSection";
import { WindowSizeSection } from "../ui/organisms/WindowSizeSection";
import { WindowBehaviorSection } from "../ui/organisms/WindowBehaviorSection";
import { UpdateSection } from "../ui/organisms/UpdateSection";

// Settings state lives at the page level, so any keystroke in any field
// re-renders the whole page. Memoize every section so a change only
// re-renders the section it belongs to.
const WindowSizeSectionM = memo(WindowSizeSection);
const WindowBehaviorSectionM = memo(WindowBehaviorSection);

// Bridge components: organisms stay prop-driven; these pull state from the
// settings context so core and plugin sections share one contract.
function WindowSizeViaContext() {
  const s = useSettingsState();
  return <WindowSizeSectionM winSize={s.winSize} onChange={s.setWinSize} />;
}

function WindowBehaviorViaContext() {
  const s = useSettingsState();
  return <WindowBehaviorSectionM winPrefs={s.winPrefs} onChange={s.setWinPrefs} />;
}

const CORE_TABS: (SettingsTabContribution & { order: number })[] = [
  {
    id: "general",
    label: "General",
    group: "Avatar",
    order: 10,
    desc: "Companion identity, main-window size and behavior.",
    icon: ({ className }) => (
      <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
    ),
  },
  {
    id: "plugins",
    label: "Plugins",
    group: "System",
    order: 40,
    desc: "Installed plugins, permissions, and enable/disable.",
    icon: ({ className }) => (
      <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84-.504-1.02-.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" /></svg>
    ),
  },
  {
    id: "about",
    label: "About",
    group: "System",
    order: 50,
    desc: "App version and software updates.",
    icon: ({ className }) => (
      <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
    ),
  },
];

type SectionDef = {
  id: string;
  tabId: string;
  component: React.ComponentType;
};

// Tab bodies are assembled from sections (see SettingsPage). Core sections
// sit in the order-100 band; plugin "top" contributions default to 50
// (render above) and "bottom" to 150 (render below) — see api.ts.
const CORE_SECTIONS: SectionDef[] = [
  { id: "general.windowSize", tabId: "general", component: WindowSizeViaContext },
  { id: "general.window", tabId: "general", component: WindowBehaviorViaContext },
  { id: "plugins.plugins", tabId: "plugins", component: PluginsSection },
  { id: "about.update", tabId: "about", component: UpdateSection },
];

let registered = false;

/** Idempotent: registers the built-in settings tabs/sections. */
export function registerBuiltinContributions(): void {
  if (registered) return;
  registered = true;
  for (const tab of CORE_TABS) {
    registerTab("core", tab);
  }
  for (const section of CORE_SECTIONS) {
    registerSection("core", {
      id: section.id,
      tabId: section.tabId,
      slot: "top",
      order: 100,
      component: section.component,
    });
  }
}
