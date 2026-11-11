import { describe, expect, it } from "vitest";
import { createPluginContext } from "./api";

// Construction is lazy (no Tauri IPC at activation), so the context can be
// built in a plain test environment; only method calls touch the host.

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
