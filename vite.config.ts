import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    // Web development against the live desktop backend: open
    // http://127.0.0.1:1420/?web=1 with the app running (`tauri dev` or a
    // built app) and the bridge server on :1421 backs this page.
    proxy: {
      "/__bridge": {
        target: "http://127.0.0.1:1421",
        ws: true,
      },
    },
  },
  build: {
    target: "es2020",
    minify: "esbuild",
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        settings: resolve(import.meta.dirname, "settings.html"),
      },
    },
  },
});
