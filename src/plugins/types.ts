// Plugin system contracts: what a plugin frontend may contribute and the
// API surface (`PluginContext`) the host hands to it at activation.

import type { ComponentType, ReactNode } from "react";
import type { WindowAnchor } from "../events";

// ---------------------------------------------------------------------------
// Contributions
// ---------------------------------------------------------------------------

/** A new tab in the settings window sidebar. */
export type SettingsTabContribution = {
  id: string;
  label: string;
  group: string;
  desc: string;
  icon?: (props: { className?: string }) => ReactNode;
  /** Sort weight inside its group (core tabs use 10, 20, 30…). */
  order?: number;
  /**
   * Whole-tab body. Optional: omit it and build the body from sections
   * (`registerSection` with this tab's id) — how the core tabs work.
   */
  component?: ComponentType;
};

/** Insert a section card into an existing settings tab. */
export type SectionContribution = {
  /** Unique section id, e.g. `"notes.list"`. */
  id: string;
  tabId: string;
  slot: "top" | "bottom";
  order?: number;
  component: ComponentType;
};

/** Replace one built-in section by id (e.g. `"general.persona"`). */
export type SectionReplacementContribution = {
  id: string;
  component: ComponentType;
};

/** Replace a built-in tab body entirely (same tab id, new content). */
export type TabOverrideContribution = {
  id: string;
  component: ComponentType;
};

/** Named anchor rows in the main (avatar) window. `main.backdrop` widgets
 *  render behind the core interaction canvas: non-interactive pixel layers
 *  (the avatar engine's WebGL canvas lives there). */
export type MainSlot = "main.backdrop" | "main.top" | "main.bottom" | "main.overlay";

export type WidgetContribution = {
  slot: MainSlot;
  order?: number;
  component: ComponentType;
};

/** Replace a built-in main-window widget. Contract: same props as the builtin. */
export type WidgetTargetId =
  | "chatPanel"
  | "alarmBanner"
  | "errorOverlay";

export type WidgetOverrideContribution = {
  targetId: WidgetTargetId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
};

export type ContextMenuItemContribution = {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  order?: number;
  onSelect: () => void;
};

/** A tool the avatar's model can call, executed in the webview. */
export type ToolContribution = {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execute: (args: unknown, signal?: AbortSignal) => Promise<string> | string;
};

// ---------------------------------------------------------------------------
// Avatar & service surfaces (ABI-2 host capabilities)
// ---------------------------------------------------------------------------

/** Custom motion clip definition (mirrors the host's motion registry). */
export type MotionDef = {
  name: string;
  pose: unknown;
  duration: number;
  hipsPos?: unknown;
  version?: number;
  description?: string;
};

/** Custom emotion clip definition (mirrors the host's expression registry). */
export type EmotionDef = {
  name: string;
  preset: string;
  resetMs: number;
};

/** Emotion/motion names the avatar can currently perform. */
export type AvatarCapabilities = {
  emotions: string[];
  motions: string[];
};

/**
 * Live avatar control. In the main window these drive the real controllers;
 * elsewhere they are safe no-ops.
 */
export type AvatarSurface = {
  setEmotion: (name: string) => void;
  triggerMotion: (name: string) => void;
  setViseme: (name: string, weight?: number) => void;
  registerMotion: (def: MotionDef) => void;
  registerEmotion: (def: EmotionDef) => void;
  loadModel: (source: { id?: string; base64?: string }) => Promise<void>;
  loadVrmaBase64: (
    data: string,
    name: string,
  ) => Promise<{
    name: string;
    duration: number;
    pose: unknown;
    hipsPos?: unknown;
    version: number;
    expressions: Array<{ preset: string }>;
  }>;
  reloadLibrary: (
    motions: Array<{
      name: string;
      pose: unknown;
      duration: number;
      hipsPos?: unknown;
      version?: number;
      description?: string;
    }>,
    emotions: Array<{ name: string; preset: string; resetMs: number }>,
  ) => void;
  describeCapabilities: () => AvatarCapabilities;
  /**
   * Install the live avatar handlers (the engine side of the bus). The
   * provider is whatever plugin owns the avatar runtime (currently the vrm
   * plugin); last install wins, missing entries stay no-ops, and calls made
   * before any install are queued and replayed on install. No-op outside the
   * main window semantics: the handlers decide what works where.
   */
  provide: (handlers: AvatarEngineHandlers) => void;
};

/** Handler set the avatar engine provider installs via `avatar.provide`.
 *  Shape: any subset of the control surface plus engine-only probes. */
export type AvatarEngineHandlers = {
  setEmotion?: (name: string) => void;
  triggerMotion?: (name: string) => void;
  setViseme?: (name: string, weight?: number) => void;
  registerMotion?: (def: MotionDef) => void;
  registerEmotion?: (def: EmotionDef) => void;
  loadModel?: (source: { id?: string; base64?: string }) => Promise<void>;
  loadVrmaBase64?: (
    data: string,
    name: string,
  ) => Promise<{
    name: string;
    duration: number;
    pose: unknown;
    hipsPos?: unknown;
    version: number;
    expressions: Array<{ preset: string }>;
  }>;
  reloadLibrary?: (
    motions: Array<{
      name: string;
      pose: unknown;
      duration: number;
      hipsPos?: unknown;
      version?: number;
      description?: string;
    }>,
    emotions: Array<{ name: string; preset: string; resetMs: number }>,
  ) => void;
  describeCapabilities?: () => AvatarCapabilities;
  pixelAlphaAt?: (cssX: number, cssY: number) => number | null;
};

/** Streaming speech handle (mirrors the host's StreamTts contract). */
export type TtsStream = {
  push: (token: string) => void;
  flush: () => void;
  stop: () => void;
};

export type TtsSettingsLike = Record<string, unknown> & {
  volume?: number;
  ttsProvider?: string;
};

/** A text-to-speech provider a voice plugin publishes. */
export type TtsProvider = {
  id: string;
  speak: (
    text: string,
    settings: TtsSettingsLike,
    onViseme: (name: string, weight?: number) => void,
    onEnd: () => void,
    opts?: { noFallback?: boolean },
  ) => Promise<void>;
  speakLoop: (
    text: string,
    settings: TtsSettingsLike,
    onViseme: (name: string, weight?: number) => void,
    onEnd: () => void,
  ) => Promise<void>;
  createStream: (
    settings: TtsSettingsLike,
    onViseme: (name: string, weight?: number) => void,
    onAllDone: () => void,
    onSpeakingChange?: (speaking: boolean) => void,
  ) => TtsStream;
  stop: () => void;
  setVolume: (v: number) => void;
};

export type SttEngineKind = "local" | "cloud";

/** One running recognition session (mirrors NativeStt/CloudStt). */
export type SttEngine = {
  start: () => Promise<void>;
  stop: () => Promise<unknown>;
  setBargeInListener: (fn: ((energy: number) => void) | null) => void;
  discardPending: () => void;
  shouldSend: (text: string) => boolean;
};

/** A speech-to-text provider a voice plugin publishes. */
export type SttProvider = {
  id: string;
  createEngine: (
    kind: SttEngineKind,
    onLiveText: (text: string) => void,
    onSpeechEnd: (text: string) => void,
    onError?: (err: string) => void,
  ) => SttEngine;
  setSuppress: (suppress: boolean) => void | Promise<void>;
  micEnergy: () => Promise<number>;
};

/** Host service registry access: publish or consume capability providers. */
export type ServicesSurface = {
  /** Publish the TTS provider. Registering null hands a previously taken
   *  slot back to the provider underneath (takeover stack). */
  registerTts: (provider: TtsProvider | null) => void;
  registerStt: (provider: SttProvider) => void;
  /** Active TTS provider; a silent no-op when no voice plugin is installed. */
  tts: () => TtsProvider;
  /** Active STT provider; rejects engine use when no voice plugin is installed. */
  stt: () => SttProvider | null;
};

/** Keychain access namespaced to this plugin (`{pluginId}:{name}` accounts). */
export type SecretsSurface = {
  set: (name: string, value: string) => Promise<void>;
  get: (name: string) => Promise<string | null>;
  remove: (name: string) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Window surface (requires the "window" manifest permission)
// ---------------------------------------------------------------------------

/** Position or size in logical (CSS) pixels. */
export type LogicalPoint = { x: number; y: number };
export type LogicalSizeLike = { width: number; height: number };

/**
 * Control of the companion (main) window. Every method routes to the main
 * window even when called from the settings window. Changes are
 * runtime-only: the user's General-tab preferences win at the next startup.
 * Requires the `"window"` permission in manifest.json — without it every
 * method throws.
 */
export type WindowSurface = {
  /** Logical size of the companion window. */
  getSize: () => Promise<LogicalSizeLike>;
  /** Resize the companion window (logical px; clamped by its min size). */
  setSize: (size: LogicalSizeLike) => Promise<void>;
  /** Logical top-left of the companion window (global coordinates). */
  getPosition: () => Promise<LogicalPoint>;
  /** Move the companion window: absolute logical coordinates or a preset
   *  anchor on the current monitor's work area. */
  setPosition: (pos: LogicalPoint | WindowAnchor) => Promise<void>;
  /** Keep the companion above other windows. */
  setAlwaysOnTop: (on: boolean) => Promise<void>;
  /** Temporarily toggle cursor pass-through over transparent pixels (the
   *  Settings > General "Click-through" switch, runtime-only). */
  setClickThrough: (on: boolean) => void;
  /** Observe the companion window moving (logical px). */
  onMoved: (cb: (pos: LogicalPoint) => void) => () => void;
  /** Observe the companion window resizing (logical px). */
  onResized: (cb: (size: LogicalSizeLike) => void) => () => void;
};

// ---------------------------------------------------------------------------
// Host data
// ---------------------------------------------------------------------------

/** Mirror of the Rust `PluginInfo` (camelCase over IPC). */
export type PluginInfo = {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: string[];
  enabled: boolean;
  hasFrontend: boolean;
  hasBackend: boolean;
  backendLoaded: boolean;
  loadError: string | null;
  frontendPath: string | null;
  dir: string;
  /** Ships with the app; uninstalling is reversible via Restore. */
  bundled: boolean;
};

/** Mirror of the Rust `PluginToolInfo`. */
export type PluginToolInfo = {
  pluginId: string;
  name: string;
  description: string;
  inputSchema: unknown;
};

/** Instruction text a plugin contributes to the chat system prompt. Appended
 *  while the plugin is enabled; dropped live when it is disabled. */
export type SystemPromptContribution = {
  /** Stable id within the plugin — re-registering replaces the fragment. */
  id: string;
  text: string;
  /** Sort weight among all plugin fragments (lower renders earlier). */
  order?: number;
};

// ---------------------------------------------------------------------------
// UI helpers re-exported to plugins
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UiExports = Record<string, any>;

// ---------------------------------------------------------------------------
// Plugin context: the only surface a plugin frontend touches
// ---------------------------------------------------------------------------

export interface PluginContext {
  readonly id: string;
  readonly log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  readonly settings: {
    registerTab: (tab: SettingsTabContribution) => void;
    overrideTab: (id: string, component: ComponentType) => void;
    registerSection: (section: SectionContribution) => void;
    replaceSection: (id: string, component: ComponentType) => void;
  };
  readonly main: {
    registerWidget: (widget: WidgetContribution) => void;
    overrideWidget: (
      targetId: WidgetTargetId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      component: ComponentType<any>,
    ) => void;
    registerContextMenuItem: (item: ContextMenuItemContribution) => void;
  };
  readonly tools: {
    register: (tool: ToolContribution) => void;
  };
  /** Contribute instruction text to the chat system prompt. Re-registering
   *  with the same id replaces the fragment; disabling the plugin drops it
   *  live (applied on the next chat turn). */
  readonly systemPrompt: {
    register: (fragment: SystemPromptContribution) => void;
  };
  /** Talk to this plugin's Rust backend (routed via the `plugin_call` host command). */
  readonly backend: {
    call: <T = unknown>(method: string, payload?: unknown) => Promise<T>;
  };
  /** Events namespaced as `plugin:{id}:{event}`. */
  readonly events: {
    on: (event: string, cb: (payload: unknown) => void) => () => void;
    emit: (event: string, payload?: unknown) => void;
  };
  /** Host-side key/value storage scoped to this plugin. */
  readonly storage: {
    get: <T = unknown>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<void>;
    remove: (key: string) => Promise<void>;
  };
  /** Control of the companion window (position, size, behavior). Gated by
   *  the `"window"` manifest permission — methods throw without it. */
  readonly window: WindowSurface;
  /** Live avatar control (no-op outside the main window). */
  readonly avatar: AvatarSurface;
  /** Publish/consume capability providers (TTS, STT). */
  readonly services: ServicesSurface;
  /** OS keychain scoped to this plugin. */
  readonly secrets: SecretsSurface;
  /** Shared UI kit (atoms, molecules) so plugins match the app design. */
  readonly ui: UiExports;
}

/** What a plugin frontend bundle must export. */
export type CompanionPlugin = {
  activate: (ctx: PluginContext) => void | Promise<void>;
};
