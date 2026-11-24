import type { ReactNode } from "react";
import { isWebBridge } from "../../web/bridge";

// Tab ids are open strings: built-ins are registered by src/plugins/builtin.tsx
// and plugins can add more at runtime.
export type SettingsTabId = string;

export type SettingsTab = {
  id: SettingsTabId;
  label: string;
  icon?: (props: { className?: string }) => ReactNode;
  desc: string;
  group: string;
};

type Props = {
  savedAt: number | null;
  tabs: SettingsTab[];
  active: SettingsTabId;
  onSelect: (id: SettingsTabId) => void;
  children: ReactNode;
};

function groupTabs(
  tabs: SettingsTab[],
): { name: string; tabs: SettingsTab[] }[] {
  const groups: { name: string; tabs: SettingsTab[] }[] = [];
  for (const tab of tabs) {
    const last = groups[groups.length - 1];
    if (last && last.name === tab.group) {
      last.tabs.push(tab);
    } else {
      groups.push({ name: tab.group, tabs: [tab] });
    }
  }
  return groups;
}

export function SettingsLayout({
  savedAt,
  tabs,
  active,
  onSelect,
  children,
}: Props) {
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  // The web client navigates between routes (/app pet, /app/settings), so it
  // needs an in-page way back to the character window; the desktop settings
  // window just closes over the always-running main window instead.
  const web = isWebBridge();

  return (
    <>
      {/* Ambient background: the landing page's drifting blobs, data motes
          and radar glow, fixed behind the whole shell (see settings.css). */}
      <div className="st-ambient" aria-hidden="true">
        <div className="st-blob st-blob-a" />
        <div className="st-blob st-blob-b" />
        <div className="st-blob st-blob-c" />
        <div className="st-motes st-motes-far" />
        <div className="st-motes st-motes-near" />
        <div className="st-radar" />
      </div>

      <div className="st-shell">
      <nav className="st-side" aria-label="Settings sections">
        <div className="st-brand">
          <img
            style={{ width: "40px", height: "40px" }}
            src="/image/icon.png"
          />
          <div>
            <div className="st-brand-title">Companion</div>
            <div className="st-brand-sub">Settings</div>
          </div>
        </div>

        {groupTabs(tabs).map((group) => (
          <div key={group.name} className="st-nav-group" role="presentation">
            <div className="st-nav-group-label">{group.name}</div>
            {group.tabs.map((t) => {
              const Icon = t.icon;
              const isSelected = t.id === active;
              return (
                <button
                  key={t.id}
                  className="st-tab"
                  aria-selected={isSelected}
                  role="tab"
                  onClick={() => onSelect(t.id)}
                >
                  {Icon && (
                    <span className="st-tab-icon">
                      <Icon />
                    </span>
                  )}
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>
        ))}

        <div className="st-side-spacer" />

        <div className="st-side-status">
          <span className="st-side-status-dot" />
          <span>
            {savedAt
              ? `Saved ${new Date(savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
              : "Autosaved"}
          </span>
        </div>
      </nav>

      <main className="st-main" role="tabpanel">
        <header className="st-view-header">
          {web && (
            <button
              type="button"
              className="st-back"
              onClick={() => {
                // Same route style as the forward jump in App.tsx; the saved
                // password (per-origin localStorage) reconnects the bridge.
                window.location.href = "/app";
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
              Back to character
            </button>
          )}
          {/* HUD breadcrumb strip, matching the landing hero's cmp:// line */}
          <div className="st-hud-line">
            <span>cmp://settings/{current.id}</span>
            <span className="st-hud-status">
              <span className="st-hud-dot" aria-hidden="true" />
              autosave: on
            </span>
          </div>
          <h2 className="st-view-title">
            {current.label}
            <span className="st-cursor" aria-hidden="true">_</span>
          </h2>
          <p className="st-view-desc">{current.desc}</p>
        </header>

        {children}

        <footer className="st-foot">
          Settings persist in local storage. Secrets are isolated in your OS
          keychain.
        </footer>
      </main>
      </div>
    </>
  );
}
