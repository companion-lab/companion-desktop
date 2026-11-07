import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import App from "./App";
import { startEventBridge } from "./events";
import { startPluginHost } from "./plugins/host";

startEventBridge();
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
