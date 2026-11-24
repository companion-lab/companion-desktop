import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { SettingsPage } from "./ui/SettingsPage";
import { installWebBridge } from "./web/bridge";
import { startEventBridge } from "./events";
import { startPluginHost } from "./plugins/host";
import "./ui/settings.css";

// Must run before anything touches the Tauri IPC: in a browser served by the
// web bridge it installs __TAURI_INTERNALS__ (inert in the native app and in
// plain non-bridge browser runs).
installWebBridge();
startEventBridge();
listen("app-reload", () => { window.location.reload(); }).catch(() => {});

// Paint immediately; plugin tabs/sections stream in afterwards via registry
// version bumps (core contributions already registered synchronously).
void startPluginHost();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SettingsPage />
  </React.StrictMode>,
);
