import type { ReactNode } from "react";

type Props = {
  title: string;
  badge?: string;
  action?: ReactNode;
  children: ReactNode;
};

export function SectionCard({ title, badge, action, children }: Props) {
  return (
    <section className="st-card">
      <div className="st-card-head">
        <div className="st-card-title">
          <span>{title}</span>
          {badge && <span className="st-card-badge">{badge}</span>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
