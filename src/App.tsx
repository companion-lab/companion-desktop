import { useCallback, useEffect, useRef, useState } from "react";
import { initClickThrough } from "./ui/click-through";
import { avatarBus } from "./avatar-bus";
import { invoke } from "@tauri-apps/api/core";
import { applyWindowSize } from "./window-size";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onUiPrefsChanged, onWindowPrefsChanged, type UiPrefs, type WindowPrefs } from "./events";
import { loadUiPrefs } from "./ui-prefs";
import { loadWindowPrefs, DEFAULT_WINDOW_PREFS } from "./window-prefs";
import {
  applyWindowBehavior,
  armPositionTracking,
  clickThroughEnabled,
  persistCurrentPosition,
  restoreWindowLayout,
  snapToAnchor,
} from "./window-control";
import { applyAccent } from "./theme";
import { MainWindowLayout } from "./ui/templates/MainWindowLayout";
import { SlotOutlet, WidgetHost } from "./plugins/slots";

const WINDOW_SIZE_STORE = "companion:window-size";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [uiPrefs, setUiPrefs] = useState<UiPrefs>(loadUiPrefs);
  // Live window prefs for the click-through gate; also the diff base for
  // applying preference changes arriving from the settings window. The
  // startup effect below assigns the loaded value before the click-through
  // effect (declaration order) starts polling.
  const winPrefsRef = useRef<WindowPrefs | null>(null);

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

    // Window layout prefs (position restore, always-on-top, follow-Spaces,
    // accent) + arm debounced position saving once the restore is done, so
    // the OS's pre-restore placement can't overwrite the stored position.
    const winPrefs = loadWindowPrefs();
    winPrefsRef.current = winPrefs;
    applyAccent(winPrefs.accent);
    void restoreWindowLayout(winPrefs).finally(() => armPositionTracking());
    void applyWindowBehavior(winPrefs);

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
    // Persist the position after a drag settles (saved physical px, restored
    // on the next launch).
    let posTimer: number | null = null;
    const scheduleSavePosition = () => {
      if (posTimer !== null) window.clearTimeout(posTimer);
      posTimer = window.setTimeout(() => {
        posTimer = null;
        void persistCurrentPosition();
      }, 500);
    };
    let unlistenMoved: (() => void) | null = null;
    let unlistenScale: (() => void) | null = null;
    const win = getCurrentWindow();
    void win.onMoved(() => {
      scheduleReapply();
      scheduleSavePosition();
    }).then((u) => { unlistenMoved = u; });
    void win.onScaleChanged(scheduleReapply).then((u) => { unlistenScale = u; });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      if (posTimer !== null) window.clearTimeout(posTimer);
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

  // Window prefs changed (settings window or a prefs write here): apply the
  // diff, not everything — e.g. a position save must not re-snap the window.
  useEffect(() => {
    return onWindowPrefsChanged((p) => {
      const prev = winPrefsRef.current ?? DEFAULT_WINDOW_PREFS;
      winPrefsRef.current = p;
      applyAccent(p.accent);
      if (p.alwaysOnTop !== prev.alwaysOnTop || p.followSpaces !== prev.followSpaces) {
        void applyWindowBehavior(p);
      }
      if (p.anchor !== prev.anchor && p.anchor !== "free") {
        void snapToAnchor(p.anchor);
      }
      // clickThrough is read live by the click-through poll via winPrefsRef.
    });
  }, []);

  // Click-through polls the cursor and reads pixel alpha through the avatar
  // bus (the avatar engine provider answers; no-ops until one is installed).
  // Controlled by the General-tab pref (live) plus the plugin runtime
  // override (ctx.window.setClickThrough); the poll reads both live.
  useEffect(() => {
    return initClickThrough({
      canvas: () => canvasRef.current,
      alphaAt: (x, y) => avatarBus().pixelAlphaAt(x, y),
      enabled: () =>
        clickThroughEnabled(winPrefsRef.current ?? DEFAULT_WINDOW_PREFS),
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
