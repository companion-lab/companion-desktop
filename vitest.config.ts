import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests are plain TypeScript modules: no JSX, no DOM.
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Cargo owns the Rust side; cargo test runs those.
    exclude: ["**/node_modules/**", "src-tauri/**", "dist/**"],
    // The provider tool-loop tests build large SSE fixture streams and OOM
    // the default ~2GB worker heap when several run in one process.
    poolOptions: {
      forks: {
        execArgv: ["--max-old-space-size=6144"],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      // Entry points that only mount the app / wire window handles.
      exclude: ["src/main.tsx", "src/**/*.test.ts"],
    },
  },
});