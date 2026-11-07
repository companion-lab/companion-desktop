import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./ContextMenu.css";

export type MenuItem =
  | { separator: true }
  | {
      label: string;
      icon?: ReactNode;
      danger?: boolean;
      action: () => void;
    };

type Props = {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
};

// Keep the panel this far away from the window edge: the companion window is
// resizable down to 240×375, so a menu opened at the bottom-right corner
// would render clipped without flipping back inside.
const EDGE = 8;

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLUListElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.max(EDGE, Math.min(x, window.innerWidth - rect.width - EDGE)),
      y: Math.max(EDGE, Math.min(y, window.innerHeight - rect.height - EDGE)),
    });
  }, [x, y]);

  useEffect(() => {
    const onClick = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onBlur = () => onClose();
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <ul
      ref={ref}
      role="menu"
      className="ctx-menu"
      style={{ top: pos.y, left: pos.x }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        "separator" in item ? (
          <li key={`sep-${i}`} role="separator" className="ctx-menu-sep" />
        ) : (
          <li key={item.label} role="none">
            <button
              type="button"
              role="menuitem"
              className={`ctx-menu-item${item.danger ? " ctx-menu-item-danger" : ""}`}
              onClick={item.action}
            >
              {item.icon && <span className="ctx-menu-item-icon">{item.icon}</span>}
              {item.label}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}
