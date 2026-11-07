import { beforeEach, describe, expect, it } from "vitest";
import {
  avatarBus,
  resetAvatarBusForTests,
  setAvatarHandlers,
  type AvatarHandlers,
} from "./avatar-bus";

beforeEach(() => resetAvatarBusForTests());

describe("avatar bus", () => {
  it("is a no-op before handlers install", () => {
    const bus = avatarBus();
    expect(() => {
      bus.setEmotion("happy");
      bus.triggerMotion("nod");
      bus.setViseme("aa");
    }).not.toThrow();
    expect(bus.describeCapabilities()).toEqual({ emotions: [], motions: [] });
  });

  it("queues registrations made before the scene mounts and replays them", () => {
    const bus = avatarBus();
    bus.registerMotion({ name: "wave", pose: {}, duration: 1 });
    bus.registerEmotion({ name: "my_joy", preset: "happy", resetMs: 4000 });
    const calls: string[] = [];
    const handlers: AvatarHandlers = {
      setEmotion: () => {},
      triggerMotion: () => {},
      setViseme: () => {},
      registerMotion: (d) => {
        calls.push(`motion:${d.name}`);
      },
      registerEmotion: (d) => {
        calls.push(`emotion:${d.name}`);
      },
      loadModel: async () => {
        calls.push("model");
        return;
      },
      loadVrmaBase64: async () => {
        throw new Error("not implemented in test");
      },
      reloadLibrary: () => {},
      describeCapabilities: () => ({ emotions: [], motions: [] }),
      pixelAlphaAt: () => null,
    };
    setAvatarHandlers(handlers);
    expect(calls).toEqual(["motion:wave", "emotion:my_joy"]);
  });

  it("queues a model load issued before handlers exist", async () => {
    const bus = avatarBus();
    const pending = bus.loadModel({ id: "custom:x" });
    const calls: string[] = [];
    setAvatarHandlers({
      loadModel: async (s) => {
        calls.push(s.id ?? "");
        return;
      },
    } as Partial<AvatarHandlers>);
    await pending;
    expect(calls).toEqual(["custom:x"]);
  });

  it("routes calls directly once handlers are installed", () => {
    setAvatarHandlers({
      setEmotion: () => {},
      triggerMotion: () => {},
      setViseme: () => {},
      registerMotion: (d) => {
        void d;
      },
      registerEmotion: () => {},
      loadModel: async () => {},
      describeCapabilities: () => ({ emotions: ["happy"], motions: ["nod"] }),
    });
    expect(avatarBus().describeCapabilities()).toEqual({
      emotions: ["happy"],
      motions: ["nod"],
    });
  });
});
