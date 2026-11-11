// Main-window theme tokens. The accent color is the one user-facing token
// for now; styles.ts and the ui kit read it via `var(--c-accent, …)`. More
// tokens (panel opacity, fonts) can ride the same mechanism later.

import type { WindowPrefs } from "./events";

export const DEFAULT_ACCENT = "#8ab4f8";

/** Swatch palette offered in Settings > General. First entry = default. */
export const ACCENT_CHOICES: NonNullable<WindowPrefs["accent"]>[] = [
  DEFAULT_ACCENT,
  "#a855f7",
  "#f472b6",
  "#34d399",
  "#fbbf24",
  "#f87171",
];

/** Apply the accent token to the document (no-op outside a DOM). Invalid or
 *  missing values fall back to the CSS default in index.html. */
export function applyAccent(accent: WindowPrefs["accent"]): void {
  if (typeof document === "undefined") return;
  const value = accent ?? DEFAULT_ACCENT;
  // Only accept hex colors — the token lands in inline styles set by the
  // user (indirectly via settings/prefs JSON), so stay strict.
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) return;
  document.documentElement.style.setProperty("--c-accent", value);
}
