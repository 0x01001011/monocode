// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { HtmlFrame } from "./HtmlFrame";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "preview_open" ? "tok1" : undefined,
  );
  vi.mocked(listen).mockResolvedValue(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
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
