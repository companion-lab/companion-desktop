import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createPluginContext } from "./api";
import { registerCapability, resetCapabilitiesForTests } from "./capabilities";

// Construction is lazy (no Tauri IPC at activation), so the context can be
// built in a plain test environment; only method calls touch the host.

// The capability remote path routes through host commands; mock the IPC
// bridge so tests can assert the routing without Tauri.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The mocked module is aliased to a vi.fn; cast for per-test setup.
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetCapabilitiesForTests();
  invokeMock.mockReset();
});

describe("createPluginContext window permission gate", () => {
  it("throws a descriptive error without the window permission", () => {
    const ctx = createPluginContext("notes", ["storage", "events"]);
    expect(() => ctx.window.getSize()).toThrowError(
      /\[plugin:notes\].*"window" permission/,
    );
    expect(() => ctx.window.setPosition("bottom-right")).toThrowError(
      /"window" permission/,
    );
    expect(() => ctx.window.onMoved(() => {})).toThrowError(
      /"window" permission/,
    );
  });

  it("exposes a callable surface with the window permission", () => {
    const ctx = createPluginContext("notes", ["storage", "window"]);
    // Outside Tauri the routed calls fail asynchronously (logged, not thrown
    // synchronously); the contract here is just "no permission wall".
    expect(() => ctx.window.setClickThrough(true)).not.toThrow();
    expect(typeof ctx.window.getSize).toBe("function");
  });
});

describe("createPluginContext capabilities permission gate", () => {
  it("throws a descriptive error without the capabilities permission", () => {
    const ctx = createPluginContext("notes", ["storage", "events"]);
    expect(() => ctx.capabilities.provide("notes.search", { methods: {} })).toThrowError(
      /\[plugin:notes\].*"capabilities" permission/,
    );
    expect(() => ctx.capabilities.consume("vision.capture")).toThrowError(
      /"capabilities" permission/,
    );
    expect(() => ctx.capabilities.list()).toThrowError(/"capabilities" permission/);
    expect(() => ctx.capabilities.callCapability("vision.capture", "screen")).toThrowError(
      /"capabilities" permission/,
    );
    expect(() => ctx.capabilities.listRemote()).toThrowError(/"capabilities" permission/);
  });

  it("exposes a live surface with the capabilities permission", () => {
    const ctx = createPluginContext("notes", ["storage", "capabilities"]);
    // Read-only here: no registration, so the module registry stays clean.
    expect(typeof ctx.capabilities.provide).toBe("function");
    expect(ctx.capabilities.consume("vision.capture")).toBeNull();
    expect(ctx.capabilities.list()).toEqual([]);
  });
});

describe("ctx.capabilities.callCapability routing", () => {
  it("answers in-process when a frontend provider owns the capability", async () => {
    registerCapability("vision", "vision.capture", {
      methods: { screen: async (p) => ({ echoed: p, from: "frontend" }) },
    });
    const ctx = createPluginContext("consumer", ["capabilities"]);
    const out = await ctx.capabilities.callCapability<{ from: string }>(
      "vision.capture",
      "screen",
      { max_width: 1280 },
    );
    expect(out).toEqual({ echoed: { max_width: 1280 }, from: "frontend" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("routes through the host when no frontend provider exists", async () => {
    invokeMock.mockResolvedValueOnce({ companion_media: { text: "remote frame" } });
    const ctx = createPluginContext("consumer", ["capabilities"]);
    const out = await ctx.capabilities.callCapability("vision.capture", "screen", {
      display_id: 1,
    });
    expect(out).toEqual({ companion_media: { text: "remote frame" } });
    expect(invokeMock).toHaveBeenCalledWith("plugin_capability_call", {
      capability: "vision.capture",
      method: "screen",
      payload: { display_id: 1 },
    });
  });

  it("still tries the host when a frontend provider lacks the method", async () => {
    registerCapability("vision", "vision.capture", {
      methods: { camera: async () => "camera" },
    });
    invokeMock.mockResolvedValueOnce("backend answered");
    const ctx = createPluginContext("consumer", ["capabilities"]);
    await expect(ctx.capabilities.callCapability("vision.capture", "screen", {})).resolves.toBe(
      "backend answered",
    );
  });

  it("names the missing method when the host has no backend provider either", async () => {
    registerCapability("vision", "vision.capture", {
      methods: { camera: async () => "camera" },
    });
    invokeMock.mockRejectedValueOnce('capability "vision.capture" is not provided by any backend');
    const ctx = createPluginContext("consumer", ["capabilities"]);
    await expect(ctx.capabilities.callCapability("vision.capture", "screen", {})).rejects.toThrow(
      /capability "vision\.capture" has no method "screen"/,
    );
  });

  it("propagates unrelated host errors untouched", async () => {
    invokeMock.mockRejectedValueOnce("backend exploded");
    const ctx = createPluginContext("consumer", ["capabilities"]);
    await expect(ctx.capabilities.callCapability("vision.capture", "screen", {})).rejects.toThrow(
      "backend exploded",
    );
  });
});

describe("ctx.capabilities.listRemote", () => {
  it("maps the host's (name, owner) pairs", async () => {
    invokeMock.mockResolvedValueOnce([
      ["vision.capture", "vision"],
      ["encryptor.seal", "encryptor"],
    ]);
    const ctx = createPluginContext("consumer", ["capabilities"]);
    await expect(ctx.capabilities.listRemote()).resolves.toEqual([
      { name: "vision.capture", pluginId: "vision" },
      { name: "encryptor.seal", pluginId: "encryptor" },
    ]);
  });
});
