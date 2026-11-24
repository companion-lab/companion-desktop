import { afterEach, describe, expect, it, vi } from "vitest";
import { canStream, doFetch, throwIfHttpError } from "./fetch";

// The Tauri path exercises the REAL @tauri-apps/plugin-http fetch() against a
// mocked __TAURI_INTERNALS__, so the test pins the exact wire protocol the
// web bridge serves (web_bridge/http_fetch.rs): create -> send -> read_body
// with data chunks trailing 0 and a [1] end sentinel. If plugin-http or the
// bridge protocol ever drifts, this fails.

const invokes: Array<{ cmd: string; args: Record<string, unknown> }> = [];

function fakeInternals(): Record<string, unknown> {
  let rid = 1;
  let reads = 0;
  return {
    metadata: { currentWindow: { label: "test" }, currentWebview: { label: "test" } },
    plugins: {},
    transformCallback: () => 0,
    runCallback: () => {},
    convertFileSrc: (path: string) => path,
    invoke: (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
      invokes.push({ cmd, args: args ?? {} });
      switch (cmd) {
        case "plugin:http|fetch":
          return Promise.resolve(rid++);
        case "plugin:http|fetch_send":
          return Promise.resolve({
            status: 200,
            statusText: "OK",
            url: "http://example.test/v1/ping",
            headers: [["content-type", "text/plain"]],
            rid: 999,
          });
        case "plugin:http|fetch_read_body": {
          reads += 1;
          // First read: one data chunk with the trailing 0 sentinel; then the
          // [1] end sentinel — the wire format web_bridge/http_fetch.rs emits.
          return Promise.resolve(reads === 1 ? [72, 105, 0] : [1]);
        }
        default:
          return Promise.reject(new Error(`unexpected command ${cmd}`));
      }
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  invokes.length = 0;
});

describe("doFetch", () => {
  it("rides plugin:http|fetch when a Tauri IPC surface exists", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const internals = fakeInternals();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: internals });

    const init = { method: "POST", body: "hi", headers: { "x-token": "t" }, maxRedirections: 3 };
    const res = await doFetch("http://example.test/v1/ping", init);

    // Consume the body first: the body reads ride pull (and the Response may
    // pre-buffer eagerly), so the fetch_read_body calls only settle once the
    // stream is done — sequence assertions come after this.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("Hi");

    // The request never touched the browser's fetch — it rode the IPC.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(invokes.map((i) => i.cmd)).toEqual([
      "plugin:http|fetch",
      "plugin:http|fetch_send",
      "plugin:http|fetch_read_body",
      "plugin:http|fetch_read_body",
    ]);
    const config = invokes[0].args.clientConfig as Record<string, unknown>;
    expect(config.method).toBe("POST");
    expect(config.url).toBe("http://example.test/v1/ping");
    expect(config.data).toEqual([104, 105]); // "hi" as the IPC byte array
    expect(config.maxRedirections).toBe(3);
    expect(config.headers).toContainEqual(["x-token", "t"]);

    // The defensive init copy keeps plugin-http's key deletes off the caller.
    expect(init.maxRedirections).toBe(3);
  });

  it("falls back to the browser fetch without a Tauri IPC surface", async () => {
    const fetchSpy = vi.fn(
      (_url: RequestInfo | URL) => Promise.resolve(new Response("ok", { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchSpy);
    // node env: no window global here — a plain-browser run without the bridge.

    const res = await doFetch("http://example.test/x", { method: "GET" });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe("http://example.test/x");
    expect(await res.text()).toBe("ok");
  });
});

describe("canStream", () => {
  it("detects a readable body", () => {
    expect(canStream(new Response("x"))).toBe(true);
    expect(canStream(new Response(null, { status: 204 }))).toBe(false);
  });
});

describe("throwIfHttpError", () => {
  it("passes 2xx through and throws with status + body on errors", async () => {
    await expect(throwIfHttpError(new Response("", { status: 200 }))).resolves.toBeUndefined();
    await expect(throwIfHttpError(new Response("nope", { status: 500 }))).rejects.toThrow(
      "HTTP 500: nope",
    );
  });
});
