import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import App from "./App";
import { installWebBridge } from "./web/bridge";
import { startEventBridge } from "./events";
import { startPluginHost } from "./plugins/host";
import { installConsoleCapture } from "./logs";

// Must run before anything touches the Tauri IPC: in a browser served by the
// web bridge it installs __TAURI_INTERNALS__ (inert in the native app and in
// plain non-bridge browser runs).
installWebBridge();
startEventBridge();
// Capture console before the plugin host starts, so plugin frontends' logs
// land in the Settings > Logs sink too.
installConsoleCapture();
listen("app-reload", () => { window.location.reload(); }).catch(() => {});
// Paint immediately; plugin contributions stream in afterwards via registry
// version bumps (slots/widgets re-render on each bump). Early ctx.avatar
// calls are buffered by the avatar bus until the engine's handlers install.
void startPluginHost();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
