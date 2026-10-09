// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { copyMessage } from "../../../platform/tauri/clipboard";
import { HtmlFrame } from "./HtmlFrame";
import { clearPreviewLogs, getPreviewLogs, recordPreviewLog } from "../previewLogs";

const LOG_KEY = "file:/repo/site/index.html";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../../platform/tauri/clipboard", () => ({
  copyMessage: vi.fn().mockResolvedValue(undefined),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "preview_open" ? "tok1" : undefined,
  );
  vi.mocked(listen).mockResolvedValue(() => {});
  vi.mocked(openUrl).mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  clearPreviewLogs(LOG_KEY);
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount() {
  await act(async () =>
    root.render(
      createElement(HtmlFrame, {
        source: { kind: "file", path: "/repo/site/index.html" },
        title: "Site",
      }),
    ),
  );
  await act(async () => {});
  const iframe = container.querySelector("iframe")!;
  // happy-dom does not run the framed document; give the frame a window to post from.
  const framed = {} as Window;
  Object.defineProperty(iframe, "contentWindow", { value: framed });
  return { iframe, framed };
}

const post = (source: unknown, data: unknown) =>
  act(() => {
    window.dispatchEvent(Object.assign(new MessageEvent("message", { data }), { source }));
  });

it("names the frame with a channel nonce the page can read from window.name", async () => {
  const { iframe } = await mount();
  expect(iframe.getAttribute("name")).toMatch(/^mc:[0-9a-f-]{8,}$/);
});

it("lets Escape pressed inside the page reach the app's own handlers", async () => {
  const { iframe, framed } = await mount();
  const seen = vi.fn();
  window.addEventListener("keydown", seen);
  const nonce = iframe.getAttribute("name")!;
  const blur = vi.spyOn(iframe, "blur");
  await post(framed, { mcp: 1, n: nonce, type: "escape" });
  window.removeEventListener("keydown", seen);
  expect(seen).toHaveBeenCalledTimes(1);
  expect((seen.mock.calls[0][0] as KeyboardEvent).key).toBe("Escape");
  expect(blur).toHaveBeenCalled();
});

it("ignores messages that are not from this frame with this nonce", async () => {
  const { iframe, framed } = await mount();
  const seen = vi.fn();
  window.addEventListener("keydown", seen);
  const nonce = iframe.getAttribute("name")!;
  await post({} as Window, { mcp: 1, n: nonce, type: "escape" }); // another window
  await post(framed, { mcp: 1, n: "mc:guess", type: "escape" }); // wrong nonce
  await post(framed, { mcp: 1, n: nonce, type: "unknown" }); // not in the allowlist
  window.removeEventListener("keydown", seen);
  expect(seen).not.toHaveBeenCalled();
});

const activation = (isActive: boolean | undefined) =>
  vi.stubGlobal("navigator", {
    ...navigator,
    ...(isActive === undefined ? {} : { userActivation: { isActive } }),
  });

it("opens a link the page asked for in the system browser after a real click", async () => {
  activation(true);
  const { iframe, framed } = await mount();
  const nonce = iframe.getAttribute("name")!;
  await post(framed, { mcp: 1, n: nonce, type: "open", url: "https://example.com/docs" });
  expect(openUrl).toHaveBeenCalledTimes(1);
  expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
});

it.each([false, undefined] as const)(
  "does not open links without recent user activation (isActive: %s)",
  async (state) => {
    activation(state);
    const { iframe, framed } = await mount();
    const nonce = iframe.getAttribute("name")!;
    await post(framed, { mcp: 1, n: nonce, type: "open", url: "https://example.com/" });
    expect(openUrl).not.toHaveBeenCalled();
  },
);

it("does not open dangerous schemes or a burst of links", async () => {
  activation(true);
  const { iframe, framed } = await mount();
  const nonce = iframe.getAttribute("name")!;
  await post(framed, { mcp: 1, n: nonce, type: "open", url: "javascript:alert(1)" });
  await post(framed, { mcp: 1, n: nonce, type: "open", url: "file:///etc/passwd" });
  expect(openUrl).not.toHaveBeenCalled();
  await post(framed, { mcp: 1, n: nonce, type: "open", url: "https://a.example/" });
  await post(framed, { mcp: 1, n: nonce, type: "open", url: "https://b.example/" });
  await post(framed, { mcp: 1, n: nonce, type: "open", url: "https://c.example/" });
  expect(openUrl).toHaveBeenCalledTimes(1);
});

it("records console output and errors the page sends, per preview", async () => {
  const { iframe, framed } = await mount();
  const nonce = iframe.getAttribute("name")!;
  await post(framed, { mcp: 1, n: nonce, type: "console", level: "log", text: "hello" });
  await post(framed, { mcp: 1, n: nonce, type: "console", level: "error", text: "Uncaught TypeError" });
  expect(getPreviewLogs(LOG_KEY).map((e) => [e.level, e.text])).toEqual([
    ["log", "hello"],
    ["error", "Uncaught TypeError"],
  ]);
});

it("ignores console messages from another window, a wrong nonce or a bad level", async () => {
  const { iframe, framed } = await mount();
  const nonce = iframe.getAttribute("name")!;
  await post({} as Window, { mcp: 1, n: nonce, type: "console", level: "log", text: "x" });
  await post(framed, { mcp: 1, n: "mc:guess", type: "console", level: "log", text: "x" });
  await post(framed, { mcp: 1, n: nonce, type: "console", level: "fatal", text: "x" });
  expect(getPreviewLogs(LOG_KEY)).toEqual([]);
});

it("starts a fresh log when a new page loads in the frame", async () => {
  const { iframe, framed } = await mount();
  const nonce = iframe.getAttribute("name")!;
  recordPreviewLog(LOG_KEY, "error", "from the previous load");
  await post(framed, { mcp: 1, n: nonce, type: "ready" });
  expect(getPreviewLogs(LOG_KEY)).toEqual([]);
});

it("copies text a page asked for after a real click", async () => {
  activation(true);
  const { iframe, framed } = await mount();
  const nonce = iframe.getAttribute("name")!;
  await post(framed, { mcp: 1, n: nonce, type: "copy", text: "npm install thing" });
  expect(copyMessage).toHaveBeenCalledWith("npm install thing");
});

it.each([false, undefined] as const)(
  "does not touch the clipboard without recent user activation (isActive: %s)",
  async (state) => {
    activation(state);
    const { iframe, framed } = await mount();
    const nonce = iframe.getAttribute("name")!;
    await post(framed, { mcp: 1, n: nonce, type: "copy", text: "secret-looking" });
    expect(copyMessage).not.toHaveBeenCalled();
  },
);

it("does not let a page spam the clipboard", async () => {
  activation(true);
  const { iframe, framed } = await mount();
  const nonce = iframe.getAttribute("name")!;
  for (const text of ["a", "b", "c"]) await post(framed, { mcp: 1, n: nonce, type: "copy", text });
  expect(copyMessage).toHaveBeenCalledTimes(1);
});
