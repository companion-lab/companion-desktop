import type { CSSProperties, InputHTMLAttributes } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label?: string;
  valueLabel?: string;
};

// --fill drives the filled-track gradient in settings.css
function fillPercent(attrs: Pick<InputHTMLAttributes<HTMLInputElement>, "min" | "max" | "value">): string {
  const lo = Number(attrs.min ?? 0);
  const hi = Number(attrs.max ?? 100);
  const v = Number(attrs.value ?? lo);
  if (!Number.isFinite(v) || hi <= lo) return "50%";
  return `${Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100))}%`;
}

export function RangeSlider({ label, valueLabel, style, ...rest }: Props) {
  const fill = { ["--fill" as string]: fillPercent(rest) } as CSSProperties;
  const content = <input type="range" style={{ ...fill, ...style }} {...rest} />;

  if (!label && !valueLabel) return content;

  return (
    <label className="st-field">
      <span className="st-field-label">
        <span>{label}</span>
        {valueLabel && <span className="st-field-value">{valueLabel}</span>}
      </span>
      {content}
    </label>
  );
}
