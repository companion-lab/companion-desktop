import { useEffect, useState, type ReactNode } from "react";
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
  // Pages running in a browser navigate between routes (/app pet,
  // /app/settings), so they need an in-page way back to the character
  // window; the desktop settings window just closes over the always-running
  // main window instead. That's the bridge client (isWebBridge) but also a
  // plain browser tab (e.g. the dev page without ?web=1) — anything without
  // the native webview's __TAURI_INTERNALS__ (same runtime check as
  // plugins/host.ts isTauri(); the polyfill defines it too, but then
  // isWebBridge() is already true).
  const web = isWebBridge() || !("__TAURI_INTERNALS__" in window);

  // On narrow screens the sidebar is an off-canvas drawer toggled by the ☰
  // button in the view header (the button is display:none on desktop, see
  // the narrow-screen block in settings.css).
  const [navOpen, setNavOpen] = useState(false);

  // Escape closes the drawer (hardware keyboards on the web client).
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  // Resizing past the drawer breakpoint while it's open leaves a stale open
  // state (and the hidden backdrop div would block clicks again if the
  // window shrinks later) — drop the state when the viewport leaves mobile.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 680px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (!e.matches) setNavOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

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
      {navOpen && (
        // Scrim behind the drawer; click anywhere outside the drawer to
        // close. aria-hidden: keyboard users close via Escape or a tab.
        <div className="st-nav-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />
      )}
      <nav
        id="st-side-nav"
        className={`st-side${navOpen ? " st-nav-open" : ""}`}
        aria-label="Settings sections"
      >
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
                  onClick={() => {
                    onSelect(t.id);
                    setNavOpen(false); // drawer: jump + dismiss in one tap
                  }}
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
          {/* HUD breadcrumb strip, matching the landing hero's cmp:// line.
              The ☰ toggle lives here on mobile (hidden on desktop). */}
          <div className="st-hud-line">
            <button
              type="button"
              className="st-menu-btn"
              aria-label="Open settings navigation"
              aria-expanded={navOpen}
              aria-controls="st-side-nav"
              onClick={() => setNavOpen(true)}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></svg>
            </button>
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
