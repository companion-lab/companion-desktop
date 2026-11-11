import { SectionCard } from "../molecules/SectionCard";
import type { WindowPrefs } from "../../events";
import { ACCENT_CHOICES, DEFAULT_ACCENT } from "../../theme";

type Anchor = WindowPrefs["anchor"];

const ANCHOR_PRESETS: { value: Anchor; label: string }[] = [
  { value: "free", label: "Free" },
  { value: "top-left", label: "↖" },
  { value: "top-right", label: "↗" },
  { value: "bottom-left", label: "↙" },
  { value: "bottom-right", label: "↘" },
];

/** The follow-Spaces toggle only means something on macOS. */
const IS_MACOS =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

type ToggleRowProps = {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
};

function ToggleRow({ label, hint, checked, onChange }: ToggleRowProps) {
  return (
    <label className="st-window-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="st-window-toggle-text">
        <span className="st-window-toggle-label">{label}</span>
        <span className="st-field-hint">{hint}</span>
      </span>
    </label>
  );
}

type Props = {
  winPrefs: WindowPrefs;
  onChange: (prefs: WindowPrefs) => void;
};

/**
 * Main-window position and behavior: corner snap presets, position memory,
 * always-on-top, click-through, macOS follow-Spaces, and the accent color.
 * Overridable by plugins via the `general.window` section id.
 */
export function WindowBehaviorSection({ winPrefs, onChange }: Props) {
  const set = (patch: Partial<WindowPrefs>) => onChange({ ...winPrefs, ...patch });

  return (
    <SectionCard title="Window Behavior">
      <label className="st-field">
        <span className="st-field-label">
          <span>Position Preset</span>
          <span className="st-field-value">
            {winPrefs.anchor === "free" ? "free" : winPrefs.anchor}
          </span>
        </span>
        <div className="preset-bar" role="group" aria-label="Window position preset">
          {ANCHOR_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              title={p.value === "free" ? "Free placement" : `Snap to ${p.value.replace("-", " ")}`}
              onClick={() => set({ anchor: p.value })}
              className={`preset-btn ${winPrefs.anchor === p.value ? "preset-btn-active" : ""}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className="st-field-hint">
          Corners snap the window immediately (keeps its size). Free leaves
          placement to dragging.
        </span>
      </label>

      <ToggleRow
        label="Remember position"
        hint="Restore the window's last position when the app starts."
        checked={winPrefs.rememberPosition}
        onChange={(v) => set({ rememberPosition: v })}
      />
      <ToggleRow
        label="Always on top"
        hint="Keep the companion above every other window."
        checked={winPrefs.alwaysOnTop}
        onChange={(v) => set({ alwaysOnTop: v })}
      />
      <ToggleRow
        label="Click-through"
        hint="Clicks pass through transparent pixels to the app behind the companion. Turn off if the pet ever swallows clicks it shouldn't."
        checked={winPrefs.clickThrough}
        onChange={(v) => set({ clickThrough: v })}
      />
      {IS_MACOS && (
        <ToggleRow
          label="Follow across Spaces"
          hint="macOS: show the companion on every desktop Space and alongside fullscreen apps."
          checked={winPrefs.followSpaces}
          onChange={(v) => set({ followSpaces: v })}
        />
      )}

      <label className="st-field">
        <span className="st-field-label">
          <span>Accent Color</span>
        </span>
        <div className="st-accent-row" role="group" aria-label="Accent color">
          {ACCENT_CHOICES.map((color) => (
            <button
              key={color}
              type="button"
              title={color}
              aria-label={`Accent color ${color}`}
              onClick={() => set({ accent: color })}
              className={`st-accent-swatch ${(winPrefs.accent ?? DEFAULT_ACCENT) === color ? "st-accent-swatch-active" : ""}`}
              style={{ background: color }}
            />
          ))}
        </div>
        <span className="st-field-hint">
          Tints the companion window's headings and highlights.
        </span>
      </label>
    </SectionCard>
  );
}
