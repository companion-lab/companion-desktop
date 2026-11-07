import { useCallback, useState, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ContextMenu, type MenuItem } from "../organisms/ContextMenu";
import { SlotOutlet } from "../../plugins/slots";
import { getContextMenuItems, useRegistryVersion } from "../../plugins/registry";

type Props = {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onContextMenuAction: (action: string) => void;
  children: ReactNode;
};

const iconProps = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const gearIcon = (
  <svg {...iconProps}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const inspectIcon = (
  <svg {...iconProps}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const quitIcon = (
  <svg {...iconProps}>
    <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
    <line x1="12" y1="2" x2="12" y2="12" />
  </svg>
);

export function MainWindowLayout({ canvasRef, onContextMenuAction, children }: Props) {
  useRegistryVersion(); // plugin context-menu items may arrive late
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const pluginItems: MenuItem[] = getContextMenuItems().map((item) => ({
    label: item.label,
    icon: item.icon,
    danger: item.danger,
    action: () => {
      closeCtxMenu();
      try {
        item.onSelect();
      } catch (e) {
        console.error("[plugins] context menu item failed:", item.id ?? item.label, e);
      }
    },
  }));

  const menuItems: MenuItem[] = [
    {
      label: "Settings…",
      icon: gearIcon,
      action: () => { closeCtxMenu(); onContextMenuAction("settings"); },
    },
    ...(import.meta.env.DEV
      ? [
          {
            label: "Inspect Element",
            icon: inspectIcon,
            action: () => { closeCtxMenu(); onContextMenuAction("inspect"); },
          },
        ]
      : []),
    ...pluginItems,
    { separator: true },
    {
      label: "Quit",
      icon: quitIcon,
      danger: true,
      action: () => { closeCtxMenu(); invoke("quit_app").catch(console.error); },
    },
  ];

  return (
    <>
      {/* Plugin backdrop widgets (avatar engine canvas): pixel layers behind
          the interaction canvas. They must set pointer-events: none. */}
      <SlotOutlet slot="main.backdrop" />
      <canvas
        ref={canvasRef as any}
        onPointerDown={() => getCurrentWindow().startDragging()}
        onContextMenu={onContextMenu}
        style={{
          position: "fixed",
          inset: 0,
          width: "100%",
          height: "100%",
          background: "transparent",
        }}
      />
      {children}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={menuItems}
          onClose={closeCtxMenu}
        />
      )}
    </>
  );
}
