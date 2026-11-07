import type { LabelHTMLAttributes, ReactNode } from "react";
import { label as base } from "../styles";

type Props = LabelHTMLAttributes<HTMLLabelElement> & {
  children: ReactNode;
};

export function Label({ style, children, ...rest }: Props) {
  return (
    <label style={{ ...base, ...style }} {...rest}>
      {children}
    </label>
  );
}
