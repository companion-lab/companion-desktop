import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentWindow = vi.fn();
const getByLabel = vi.fn();
const setMinSize = vi.fn();
const setSize = vi.fn();

vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalSize: class {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => getCurrentWindow(),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: (l: string) => getByLabel(l) },
}));

import { applyWindowSize, MIN_WIDTH, MIN_HEIGHT, BASE_WIDTH, BASE_HEIGHT } from "./window-size";

function fakeWin() {
  return { setMinSize, setSize };
}

beforeEach(() => {
  vi.clearAllMocks();
  setMinSize.mockResolvedValue(undefined);
  setSize.mockResolvedValue(undefined);
  getByLabel.mockResolvedValue(fakeWin());
});

describe("applyWindowSize", () => {
  it("resizes the current window when it is already the main one", async () => {
    getCurrentWindow.mockReturnValue({ label: "main", ...fakeWin() });
    await applyWindowSize({ width: 600, height: 900 });
    expect(setMinSize).toHaveBeenCalledWith(expect.objectContaining({ width: MIN_WIDTH, height: MIN_HEIGHT }));
    expect(setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 600, height: 900 }));
    expect(getByLabel).not.toHaveBeenCalled();
  });

  // The settings window is a separate webview, so it has to reach across.
  it("looks up the main window when called from another window", async () => {
    getCurrentWindow.mockReturnValue({ label: "settings" });
    await applyWindowSize({ width: 600, height: 900 });
    expect(getByLabel).toHaveBeenCalledWith("main");
    expect(setSize).toHaveBeenCalled();
  });

  it("warns and returns when the main window is gone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getCurrentWindow.mockReturnValue({ label: "settings" });
    getByLabel.mockResolvedValue(null);
    await applyWindowSize({ width: 600, height: 900 });
    expect(warn).toHaveBeenCalled();
    expect(setSize).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // A silent reject here looks exactly like the GTK min-size bug this guards
  // against, so the failure is logged rather than swallowed.
  it("logs but does not throw when the platform rejects the resize", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    getCurrentWindow.mockReturnValue({ label: "main", ...fakeWin() });
    setSize.mockRejectedValue(new Error("gtk refused"));
    await expect(applyWindowSize({ width: 600, height: 900 })).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("scale constants", () => {
  it("derives the minimum size from the base size and min scale", () => {
    expect(MIN_WIDTH).toBe(Math.round(BASE_WIDTH * 0.5));
    expect(MIN_HEIGHT).toBe(Math.round(BASE_HEIGHT * 0.5));
  });
});