import { useCallback, useEffect, useState, type ReactNode } from "react";
import { applyWindowSize, BASE_HEIGHT, BASE_WIDTH, type WindowSize } from "../window-size";
import { SettingsLayout, type SettingsTab } from "./templates/SettingsLayout";
import { DEFAULT_PERF, loadPerf, savePerf, type PerformanceConfig } from "../perf";
import type { WindowPrefs } from "../events";
import { loadWindowPrefs, saveWindowPrefs } from "../window-prefs";
// Plugin system: tabs/sections come from the contribution registry.
import { useRegistryVersion, getTabs, getSectionsForTab, getTab, getTabOverride } from "../plugins/registry";
import { SettingsStateProvider } from "../plugins/settings-context";
import type { SettingsTabId } from "./templates/SettingsLayout";

const WINDOW_SIZE_KEY = "companion:window-size";
const TAB_KEY = "companion:settings-tab";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return fallback;
}

// Tabs mount on first visit and then stay alive (hidden) so their state
// survives switching; opening the window no longer pays for all tabs' IPC
// and rendering at once.
function TabBody({
  id,
  active,
  visited,
  children,
}: {
  id: SettingsTabId;
  active: SettingsTabId;
  visited: ReadonlySet<SettingsTabId>;
  children: ReactNode;
}) {
  if (!visited.has(id)) return null;
  return <div hidden={active !== id}>{children}</div>;
}

export function SettingsPage() {
  useRegistryVersion(); // re-render when tabs/sections register
  const tabs = getTabs();
  const tabIds = tabs.map((t) => t.id).join(",");

  const [active, setActive] = useState<SettingsTabId>(() => {
    try {
      const raw = localStorage.getItem(TAB_KEY);
      if (raw) return raw;
    } catch {
      /* ignore */
    }
    return "general";
  });
  const [savedAt] = useState<number | null>(null);
  const [perf, setPerf] = useState<PerformanceConfig>({ ...DEFAULT_PERF });
  const [winSize, setWinSize] = useState<WindowSize>(() =>
    load(WINDOW_SIZE_KEY, { width: BASE_WIDTH, height: BASE_HEIGHT }),
  );
  const [winPrefs, setWinPrefs] = useState<WindowPrefs>(loadWindowPrefs);
  const [visited, setVisited] = useState<ReadonlySet<SettingsTabId>>(() => new Set([active]));

  useEffect(() => {
    let alive = true;
    loadPerf().then((cfg) => {
      if (alive) setPerf(cfg);
    });
    return () => { alive = false; };
  }, []);

  const onPerfChange = useCallback((next: PerformanceConfig) => {
    setPerf(next);
    savePerf(next)
      .then((saved) => {
        setPerf(saved);
      })
      .catch((e) => console.error("perf save failed", e));
  }, []);

  useEffect(() => {
    localStorage.setItem(WINDOW_SIZE_KEY, JSON.stringify(winSize));
    void applyWindowSize(winSize);
  }, [winSize]);

  // Window prefs: persist + broadcast; the main window applies the diff
  // (snapping, always-on-top, …) when it receives the event.
  const onWinPrefsChange = useCallback((next: WindowPrefs) => {
    setWinPrefs(next);
    saveWindowPrefs(next);
  }, []);

  // If the active tab disappears (e.g. its plugin was disabled), fall back to
  // the first available tab instead of leaving a dangling selection.
  useEffect(() => {
    if (tabs.length === 0) return;
    if (tabs.some((t) => t.id === active)) return;
    const next = tabs[0].id;
    setActive(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      /* ignore */
    }
  }, [tabIds, active]);

  const select = useCallback((id: SettingsTabId) => {
    setActive(id);
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    try {
      localStorage.setItem(TAB_KEY, id);
    } catch {
      /* ignore */
    }
  }, []);

  const settingsState = {
    perf, setPerf: onPerfChange,
    winSize, setWinSize,
    winPrefs, setWinPrefs: onWinPrefsChange,
  };

  return (
    <SettingsLayout savedAt={savedAt} tabs={tabs as SettingsTab[]} active={active} onSelect={select}>
      <SettingsStateProvider value={settingsState}>
        {tabs.map((tab) => (
          <TabBody key={tab.id} id={tab.id} active={active} visited={visited}>
            <TabContent tabId={tab.id} />
          </TabBody>
        ))}
      </SettingsStateProvider>
    </SettingsLayout>
  );
}

/**
 * Body of one tab, resolved from the registry:
 * 1. a plugin `overrideTab` wins,
 * 2. else the tab's own `component` if it declared one,
 * 3. else the ordered section list (core sections in the 100 band, plugin
 *    "top" contributions above them, "bottom" below).
 */
function TabContent({ tabId }: { tabId: SettingsTabId }) {
  useRegistryVersion();
  const Override = getTabOverride(tabId);
  if (Override) {
    // Overriding components own their memoization (documented in the SDK).
    return <Override />;
  }
  // A tab that declared its own whole-tab body renders it directly; core
  // tabs (and most plugins, mirroring mcp/vrm) are section-assembled and
  // have no component, so they fall through to the ordered section list.
  const TabBody = getTab(tabId)?.component;
  if (TabBody) {
    return <TabBody />;
  }
  const sections = getSectionsForTab(tabId);
  return (
    <>
      {sections.map((section) => (
        <section.component key={section.id} />
      ))}
    </>
  );
}
