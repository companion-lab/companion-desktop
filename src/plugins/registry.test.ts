import { describe, it, expect, beforeEach } from "vitest";
import {
  getSectionsForTab,
  getTabs,
  getTabOverride,
  getWidgets,
  getWidgetOverride,
  getContextMenuItems,
  getTools,
  markPluginsSettled,
  pluginsSettled,
  removePluginContributions,
  resetRegistryForTests,
  subscribeRegistry,
} from "../plugins/registry";

describe("plugin registry", () => {
  beforeEach(() => resetRegistryForTests());

  it("registers core tabs and sections", () => {
    // builtin.ts registers through the same API; pages call registerBuiltinContributions.
    // Here we exercise the raw registry contract.
    expect(getTabs().length).toBe(0);
  });

  it("markPluginsSettled flips once and bumps listeners; reset clears it", () => {
    expect(pluginsSettled()).toBe(false);
    let bumps = 0;
    const unsubscribe = subscribeRegistry(() => { bumps += 1; });
    markPluginsSettled();
    markPluginsSettled(); // idempotent
    expect(pluginsSettled()).toBe(true);
    expect(bumps).toBe(1);
    unsubscribe();
    resetRegistryForTests();
    expect(pluginsSettled()).toBe(false);
  });

  it("registerTab / registerSection / ordering bands", async () => {
    const { registerTab, registerSection } = await import("../plugins/registry");
    registerTab("p", { id: "t1", label: "T1", group: "g", desc: "d" });
    registerSection("p", { id: "s1", tabId: "t1", slot: "top", order: 50, component: () => null as any });
    registerSection("p", { id: "s2", tabId: "t1", slot: "bottom", order: 150, component: () => null as any });
    registerSection("p", { id: "s3", tabId: "t1", slot: "top", order: 100, component: () => null as any });
    const sections = getSectionsForTab("t1");
    expect(sections.map((s) => s.id)).toEqual(["s1", "s3", "s2"]);
  });

  it("overrideTab replaces a tab body", async () => {
    const { registerTab, overrideTab } = await import("../plugins/registry");
    registerTab("core", { id: "g", label: "G", group: "g", desc: "d" });
    expect(getTabOverride("g")).toBeUndefined();
    const Override = () => null as any;
    overrideTab("plugin", "g", Override);
    expect(getTabOverride("g")).toBe(Override);
  });

  it("overrideWidget / context menu / tools", async () => {
    const { registerWidget, overrideWidget, registerContextMenuItem, registerTool } =
      await import("../plugins/registry");
    registerWidget("p", { slot: "main.bottom", order: 10, component: () => null as any });
    expect(getWidgets("main.bottom").length).toBe(1);
    const Override = () => null as any;
    overrideWidget("p", "chatPanel", Override);
    expect(getWidgetOverride("chatPanel")).toBe(Override);

    registerContextMenuItem("p", { id: "ctx1", label: "Hi", onSelect: () => {} });
    expect(getContextMenuItems().map((i) => i.label)).toEqual(["Hi"]);

    registerTool("p", { name: "do", description: "d", execute: () => "ok" });
    const tools = getTools();
    expect(tools.has("p__do")).toBe(true);
  });

  it("removePluginContributions drops everything owned by a plugin", async () => {
    const { registerTab, registerSection, registerTool } = await import("../plugins/registry");
    registerTab("p", { id: "p-tab", label: "P", group: "g", desc: "d" });
    registerSection("p", { id: "p-s", tabId: "p-tab", slot: "top", component: () => null as any });
    registerTool("p", { name: "t", description: "d", execute: () => "ok" });
    removePluginContributions("p");
    expect(getTabs().some((t) => t.id === "p-tab")).toBe(false);
    expect(getTools().has("p__t")).toBe(false);
  });

  it("systemPrompt fragments: ordered merge, replace by id, removal drops plugin only", async () => {
    const { registerSystemPrompt, getSystemPrompts, removePluginContributions } =
      await import("../plugins/registry");
    registerSystemPrompt("a", { id: "a1", text: "  from-a  ", order: 200 });
    registerSystemPrompt("b", { id: "b1", text: "from-b", order: 10 });
    expect(getSystemPrompts()).toEqual(["from-b", "from-a"]);

    // Re-register with same (plugin, id) replaces instead of duplicating.
    registerSystemPrompt("a", { id: "a1", text: "from-a-v2" });
    expect(getSystemPrompts()).toEqual(["from-b", "from-a-v2"]);

    removePluginContributions("a");
    expect(getSystemPrompts()).toEqual(["from-b"]);
    removePluginContributions("b");
    expect(getSystemPrompts()).toEqual([]);
  });

  it("reply shapes: last registration wins, replace by id, removal drops live", async () => {
    const { registerReply, getReply, removePluginContributions } =
      await import("../plugins/registry");
    const shape = (id: string) => ({
      id,
      prompt: "pick fields",
      schema: { type: "object", properties: { text: { type: "string" } } },
      apply: () => {},
    });
    expect(getReply()).toBeNull();

    registerReply("vrm", shape("r1"));
    expect(getReply()?.id).toBe("r1");
    // Two different plugins: last registration wins.
    registerReply("l2d", shape("r2"));
    expect(getReply()?.id).toBe("r2");
    // Re-register with same (plugin, id) replaces instead of duplicating.
    registerReply("vrm", shape("r3"));
    expect(getReply()?.id).toBe("r3");

    // Disabling the owning plugin drops its shape live.
    removePluginContributions("vrm");
    expect(getReply()?.id).toBe("r2");
    removePluginContributions("l2d");
    expect(getReply()).toBeNull();
  });
});
