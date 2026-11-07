// Avatar bus: the seam between plugin-contributed code and the live avatar
// engine provided by the vrm plugin (main window only).
//
// The engine plugin installs real handlers via ctx.avatar.provide() once its
// scene is up. Everywhere else (settings window, no model yet) the bus
// defaults to safe no-ops, so plugin code can call it unconditionally.
//
// This is deliberately not the Tauri event bus: avatar control is a direct,
// ordered call path, not a broadcast.

export type MotionDef = {
  name: string;
  pose: unknown;
  duration: number;
  hipsPos?: unknown;
  version?: number;
  description?: string;
};

export type EmotionDef = {
  name: string;
  preset: string;
  resetMs: number;
};

export type LoadModelSource = {
  /** Library id, e.g. "custom:abc" or "builtin:demo". */
  id?: string;
  /** Raw VRM/glb bytes (base64) to load directly. */
  base64?: string;
};

/** Result of parsing a .vrma clip against the loaded model (parsed by the
 * engine provider; three-vrm stays in the vrm plugin). Shape mirrors the
 * engine's idle/vrma-loader.ts. */
export type VrmaResult = {
  name: string;
  duration: number;
  pose: unknown;
  hipsPos?: unknown;
  version: number;
  expressions: Array<{ preset: string }>;
};

export type AvatarCapabilities = {
  emotions: string[];
  motions: string[];
};

export type AvatarHandlers = {
  setEmotion: (name: string) => void;
  triggerMotion: (name: string) => void;
  /** Drive the mouth while a plugin speaks ("neutral" stops the lipsync). */
  setViseme: (name: string, weight?: number) => void;
  registerMotion: (def: MotionDef) => void;
  registerEmotion: (def: EmotionDef) => void;
  loadModel: (source: LoadModelSource) => Promise<void>;
  /** Parse a .vrma clip against the live model. Main window only; rejects
   *  elsewhere (no model loaded). */
  loadVrmaBase64: (data: string, name: string) => Promise<VrmaResult>;
  /** Replace the whole custom library (clears customs, registers the given
   *  sets). Used after any library add/delete. */
  reloadLibrary: (
    motions: MotionDef[],
    emotions: EmotionDef[],
  ) => void;
  describeCapabilities: () => AvatarCapabilities;
  /** Alpha byte (0-255) of the rendered pixel at a window-local CSS point,
   *  or null when it can't be read (no scene, readback failure). Backs the
   *  core click-through hit test; null means "stay interactive". */
  pixelAlphaAt: (cssX: number, cssY: number) => number | null;
};

const noopHandlers: AvatarHandlers = {
  setEmotion: () => {},
  triggerMotion: () => {},
  setViseme: () => {},
  registerMotion: () => {},
  registerEmotion: () => {},
  loadModel: async () => {},
  loadVrmaBase64: async () => {
    throw new Error("avatar is not available in this window");
  },
  reloadLibrary: () => {},
  describeCapabilities: () => ({ emotions: [], motions: [] }),
  pixelAlphaAt: () => null,
};

let handlers: AvatarHandlers = noopHandlers;

// Plugins activate before the main window's scene mounts, so registration
// and load calls can arrive while only no-op handlers exist. Buffer them and
// replay in order once real handlers install.
type Deferred =
  | { kind: "registerMotion"; def: MotionDef }
  | { kind: "registerEmotion"; def: EmotionDef }
  | { kind: "loadModel"; source: LoadModelSource; resolve?: () => void }
  | { kind: "reloadLibrary"; motions: MotionDef[]; emotions: EmotionDef[] };
let deferred: Deferred[] = [];

/** Install (or replace) the live handlers. Missing entries stay no-ops. */
export function setAvatarHandlers(patch: Partial<AvatarHandlers>): void {
  handlers = { ...noopHandlers, ...patch };
  {
    const queued = deferred;
    deferred = [];
    for (const d of queued) {
      if (d.kind === "registerMotion") handlers.registerMotion(d.def);
      else if (d.kind === "registerEmotion") handlers.registerEmotion(d.def);
      else if (d.kind === "reloadLibrary") handlers.reloadLibrary(d.motions, d.emotions);
      else
        void handlers
          .loadModel(d.source)
          .catch(() => {})
          .finally(() => d.resolve?.());
    }
  }
}

/** Current handlers; never null — consumers need no existence checks. */
export function avatarBus(): AvatarHandlers {
  return {
    ...handlers,
    registerMotion: (def) => {
      if (handlers === noopHandlers) {
        deferred.push({ kind: "registerMotion", def });
        return;
      }
      handlers.registerMotion(def);
    },
    registerEmotion: (def) => {
      if (handlers === noopHandlers) {
        deferred.push({ kind: "registerEmotion", def });
        return;
      }
      handlers.registerEmotion(def);
    },
    loadModel: (source) => {
      if (handlers === noopHandlers) {
        // Resolve only once the queued call actually replays against the
        // live handlers, so awaiters observe the real load.
        return new Promise<void>((resolve) => {
          deferred.push({ kind: "loadModel", source, resolve });
        });
      }
      return handlers.loadModel(source);
    },
    reloadLibrary: (motions, emotions) => {
      if (handlers === noopHandlers) {
        deferred.push({ kind: "reloadLibrary", motions, emotions });
        return;
      }
      handlers.reloadLibrary(motions, emotions);
    },
  };
}

/** Test helper: back to no-ops, drop any queued calls. */
export function resetAvatarBusForTests(): void {
  handlers = noopHandlers;
  deferred = [];
}
