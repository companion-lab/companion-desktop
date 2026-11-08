import { useCallback, useEffect, useRef, useState } from "react";
import { initClickThrough } from "./ui/click-through";
import { avatarBus } from "./avatar-bus";
import { invoke } from "@tauri-apps/api/core";
import { applyWindowSize } from "./window-size";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onUiPrefsChanged, type UiPrefs } from "./events";
import { loadUiPrefs } from "./ui-prefs";
import { MainWindowLayout } from "./ui/templates/MainWindowLayout";
import { SlotOutlet, WidgetHost } from "./plugins/slots";

const WINDOW_SIZE_STORE = "companion:window-size";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [uiPrefs, setUiPrefs] = useState<UiPrefs>(loadUiPrefs);

  useEffect(() => {
    const applySaved = () => {
      try {
        const raw = localStorage.getItem(WINDOW_SIZE_STORE);
        if (!raw) return;
        const { width, height } = JSON.parse(raw);
        if (typeof width === "number" && typeof height === "number") {
          void applyWindowSize({ width, height });
        }
      } catch {
        /* ignore */
      }
    };
    applySaved();

    // Moving the window between monitors (especially across different DPIs)
    // can make the OS/Tauri resize it. Re-apply the user's chosen size so it
    // doesn't silently change.
    let timer: number | null = null;
    const scheduleReapply = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        applySaved();
      }, 150);
    };
    let unlistenMoved: (() => void) | null = null;
    let unlistenScale: (() => void) | null = null;
    const win = getCurrentWindow();
    void win.onMoved(scheduleReapply).then((u) => { unlistenMoved = u; });
    void win.onScaleChanged(scheduleReapply).then((u) => { unlistenScale = u; });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unlistenMoved?.();
      unlistenScale?.();
    };
  }, []);

  useEffect(() => {
    const offUi = onUiPrefsChanged((p) => {
      setUiPrefs(p);
    });
    return () => {
      offUi();
    };
  }, []);

  // Click-through polls the cursor and reads pixel alpha through the avatar
  // bus (the avatar engine provider answers; no-ops until one is installed).
  useEffect(() => {
    return initClickThrough({
      canvas: () => canvasRef.current,
      alphaAt: (x, y) => avatarBus().pixelAlphaAt(x, y),
    });
  }, []);

  const onContextMenuAction = useCallback((action: string) => {
    if (action === "settings") {
      invoke("open_settings").catch(console.error);
    } else if (action === "inspect") {
      if (import.meta.env.DEV) {
        invoke("open_devtools").catch((e) => console.error(String(e)));
      }
    }
  }, []);

  return (
    <MainWindowLayout canvasRef={canvasRef} onContextMenuAction={onContextMenuAction}>
      {/* Plugin widgets: overlay widgets position themselves (fixed/absolute). */}
      <SlotOutlet slot="main.overlay" />
      <SlotOutlet slot="main.top" />
      <div style={uiPrefs.hideChat ? { display: "none" } : undefined}>
        {/* The chat plugin overrides this target; the avatar callbacks are
            the only contract it needs — they route through the bus to the
            avatar engine provider. */}
        <WidgetHost
          targetId="chatPanel"
          onEmotion={(e: unknown) => avatarBus().setEmotion(e as string)}
          onMotion={(m: unknown) => avatarBus().triggerMotion(m as string)}
        />
      </div>
      <SlotOutlet slot="main.bottom" />
    </MainWindowLayout>
  );
}
