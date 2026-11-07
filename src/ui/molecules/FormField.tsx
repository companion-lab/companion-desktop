import type { ReactNode } from "react";

type Props = {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
};

export function FormField({ label, children, hint }: Props) {
  return (
    <label className="st-field">
      <span className="st-field-label">{label}</span>
      {children}
      {hint && <span className="st-field-hint">{hint}</span>}
    </label>
  );
}
