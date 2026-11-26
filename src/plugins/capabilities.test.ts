import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityProvider } from "./types";
import {
  listCapabilities,
  onCapabilitiesChanged,
  registerCapability,
  removePluginCapabilities,
  resetCapabilitiesForTests,
  useCapability,
} from "./capabilities";

// Minimal provider double: the registry only stores and hands it out, so
// the method bodies never run in these tests.
function fakeProvider(description?: string): CapabilityProvider {
  return {
    description,
    methods: { ping: async () => "pong" },
  };
}

beforeEach(() => {
  resetCapabilitiesForTests();
  vi.restoreAllMocks();
});

describe("registerCapability", () => {
  it("registers and hands out the provider", () => {
    registerCapability("vision", "vision.capture", fakeProvider("frames"));
    const got = useCapability("vision.capture");
    expect(got?.pluginId).toBe("vision");
    expect(got?.description).toBe("frames");
    expect(got?.methods.ping).toBeTypeOf("function");
  });

  it("is null when the name was never registered", () => {
    expect(useCapability("vision.capture")).toBeNull();
  });

  it("rejects names not namespaced by the owning plugin id", () => {
    // The prefix is the anti-spoofing rule: `vision.capture` can only ever
    // be published by the vision plugin.
    expect(() => registerCapability("vision", "capture", fakeProvider())).toThrowError(
      /must be namespaced as "vision\.<name>"/,
    );
    expect(() => registerCapability("vision", "other.capture", fakeProvider())).toThrowError(
      /must be namespaced as "vision\.<name>"/,
    );
    expect(() => registerCapability("vision", "vision.", fakeProvider())).toThrowError(
      /must be namespaced as "vision\.<name>"/,
    );
    expect(() => registerCapability("vision", "visionx.capture", fakeProvider())).toThrowError(
      /must be namespaced as "vision\.<name>"/,
    );
    expect(useCapability("vision.capture")).toBeNull();
  });

  it("re-registering the same owner replaces in place", () => {
    registerCapability("vision", "vision.capture", fakeProvider("v1"));
    registerCapability("vision", "vision.capture", fakeProvider("v2"));
    expect(useCapability("vision.capture")?.description).toBe("v2");
    expect(listCapabilities()).toHaveLength(1);
  });

  it("registering null unregisters only the owner's own capability", () => {
    registerCapability("vision", "vision.capture", fakeProvider());
    registerCapability("vision", "vision.capture", null);
    expect(useCapability("vision.capture")).toBeNull();
  });
});

describe("listCapabilities", () => {
  it("lists every registration with its owning plugin", () => {
    registerCapability("vision", "vision.capture", fakeProvider("frames"));
    registerCapability("notes", "notes.search", fakeProvider());
    expect(listCapabilities()).toEqual([
      { name: "vision.capture", pluginId: "vision", description: "frames" },
      { name: "notes.search", pluginId: "notes", description: undefined },
    ]);
  });
});

describe("removePluginCapabilities", () => {
  it("drops the removed plugin's capabilities", () => {
    registerCapability("vision", "vision.capture", fakeProvider());
    registerCapability("notes", "notes.search", fakeProvider());
    removePluginCapabilities("vision");
    expect(useCapability("vision.capture")).toBeNull();
    expect(useCapability("notes.search")).not.toBeNull();
  });

  it("leaves unrelated registrations alone", () => {
    registerCapability("vision", "vision.capture", fakeProvider());
    removePluginCapabilities("other-plugin");
    expect(useCapability("vision.capture")).not.toBeNull();
  });
});

describe("onCapabilitiesChanged", () => {
  it("notifies on every registration change", () => {
    const seen: Array<string | null> = [];
    onCapabilitiesChanged(() => seen.push(useCapability("vision.capture")?.pluginId ?? null));
    registerCapability("vision", "vision.capture", fakeProvider());
    registerCapability("vision", "vision.capture", null);
    expect(seen).toEqual(["vision", null]);
  });

  it("unsubscribes", () => {
    const calls: number[] = [];
    const off = onCapabilitiesChanged(() => calls.push(calls.length));
    registerCapability("vision", "vision.capture", fakeProvider());
    off();
    removePluginCapabilities("vision");
    expect(calls).toEqual([0]);
  });

  it("a throwing listener does not break the others", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const other = vi.fn();
    onCapabilitiesChanged(() => {
      throw new Error("boom");
    });
    onCapabilitiesChanged(other);
    registerCapability("vision", "vision.capture", fakeProvider());
    expect(other).toHaveBeenCalledTimes(1);
    // The registry swallows listener errors silently.
    expect(warn).not.toHaveBeenCalled();
  });
});
