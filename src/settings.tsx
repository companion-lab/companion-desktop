import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { SettingsPage } from "./ui/SettingsPage";
import { startEventBridge } from "./events";
import { startPluginHost } from "./plugins/host";
import "./ui/settings.css";

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
