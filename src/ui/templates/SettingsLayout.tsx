import type { ReactNode } from "react";

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

  return (
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
          <h2 className="st-view-title">{current.label}</h2>
          <p className="st-view-desc">{current.desc}</p>
        </header>

        {children}

        <footer className="st-foot">
          Settings persist in local storage. Secrets are isolated in your OS
          keychain.
        </footer>
      </main>
    </div>
  );
}
