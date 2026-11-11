import { expect, test } from "@playwright/test";

// E2E for the settings window shell. Tauri IPC is unavailable in a plain
// browser, so the plugin host runs in its degraded mode: core contributions
// only (General + Plugins tabs). The feature tabs (Voice, Alarms, Calendar,
// MCP, Model, …) come from plugin frontends and are covered by their owning
// plugins — see PLUGINS.md.

test.describe("settings page", () => {
  test("renders the grouped sidebar and switches tabs", async ({ page }) => {
    await page.goto("/settings.html");
    await expect(page.getByRole("tab", { name: "General" })).toBeVisible();
    // Sidebar groups render in order with their tabs nested. Core keeps only
    // host-level tabs (General, Plugins, About); everything else arrives from
    // plugin frontends (not loaded in a plain browser).
    const groups = page.locator(".st-nav-group-label");
    await expect(groups).toHaveText(["Avatar", "System"]);
    await expect(page.locator(".st-tab")).toHaveCount(3);

    await page.getByRole("tab", { name: "Plugins" }).click();
    // The title carries a blinking "_" caret span, so match the label only.
    await expect(page.locator(".st-view-title")).toContainText("Plugins");
    // Active tab persists for the next launch.
    const stored = await page.evaluate(() =>
      localStorage.getItem("companion:settings-tab"),
    );
    expect(stored).toBe("plugins");
  });

  test("general tab renders the core sections", async ({ page }) => {
    await page.goto("/settings.html");
    // The title carries a blinking "_" caret span, so match the label only.
    await expect(page.locator(".st-view-title")).toContainText("General");
    await expect(page.getByText("Window Size")).toBeVisible();
    // Window behavior (position presets, toggles, accent) is core too.
    await expect(page.getByText("Window Behavior")).toBeVisible();
    await expect(page.getByText("Position Preset")).toBeVisible();
    // Core keeps only host-level sections (Window Size, Window Behavior). The
    // mic shortcut / voice interrupt (stt plugin) and chat box / persona
    // (chat plugin) are plugin-owned and only render while their plugin is
    // enabled — in this degraded plain-browser run no plugin frontends load.
    await expect(page.getByText("Microphone shortcut")).toHaveCount(0);
  });
});
