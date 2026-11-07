import type { ButtonHTMLAttributes, ReactNode } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost";
};

export function Button({ variant = "secondary", className, children, ...rest }: Props) {
  const cls = `btn-${variant} ${className ?? ""}`.trim();
  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  );
}
