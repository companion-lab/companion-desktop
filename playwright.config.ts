import { defineConfig } from "@playwright/test";

// E2E for the settings UI, served by its own Vite instance on a dedicated
// port so these tests never collide with a running `pnpm tauri dev` (port
// 1420) and never share its localStorage.
export default defineConfig({
  testDir: "./e2e",
  timeout: 20_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1024, height: 768 },
  },
  webServer: {
    command: "npx vite --port 4173 --strictPort",
    url: "http://127.0.0.1:4173/settings.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
