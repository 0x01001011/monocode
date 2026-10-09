// @vitest-environment happy-dom
// Frozen acceptance spec for HTML previews (autoresearch metric). Do not edit.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PREVIEW_CHANGED_EVENT } from "../htmlPreview";
import { HtmlFrame } from "./HtmlFrame";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
let emit: (payload: string) => void;
const unlisten = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "preview_open" ? "tok1" : undefined,
  );
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    if (event === PREVIEW_CHANGED_EVENT)
      emit = (payload) =>
        (handler as (e: { payload: string }) => void)({ payload });
    return unlisten;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const frame = () => container.querySelector("iframe");

async function render(props: Parameters<typeof HtmlFrame>[0]) {
  await act(async () => root.render(createElement(HtmlFrame, props)));
  await act(async () => {});
}

it("serves a file's folder so relative links resolve, in an isolated sandbox", async () => {
  await render({ source: { kind: "file", path: "/repo/site/index.html" }, title: "Site" });
  expect(invoke).toHaveBeenCalledWith("preview_open", {
    source: { kind: "dir", path: "/repo/site" },
  });
  const iframe = frame()!;
  expect(iframe).not.toBeNull();
  expect(iframe.getAttribute("src")).toMatch(
    /^(preview:\/\/localhost|http:\/\/preview\.localhost)\/tok1\/index\.html/,
  );
  expect(iframe.getAttribute("title")).toBe("Site");
  const sandbox = (iframe.getAttribute("sandbox") ?? "").split(/\s+/);
  expect(sandbox).toContain("allow-scripts");
  for (const forbidden of [
    "allow-same-origin",
    "allow-top-navigation",
    "allow-top-navigation-by-user-activation",
    "allow-popups-to-escape-sandbox",
  ])
    expect(sandbox).not.toContain(forbidden);
  expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
});

it("reloads only when its own preview root changes", async () => {
  await render({ source: { kind: "file", path: "/repo/site/index.html" }, title: "Site" });
  const first = frame()!;
  const firstSrc = first.getAttribute("src");
  await act(async () => emit("other-token"));
  expect(frame()).toBe(first);
  expect(frame()!.getAttribute("src")).toBe(firstSrc);
  await act(async () => emit("tok1"));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
  const reloaded = frame()!;
  expect(reloaded !== first || reloaded.getAttribute("src") !== firstSrc).toBe(true);
  expect(reloaded.getAttribute("src")).toContain("/tok1/index.html");
});

it("releases the preview root and listener on unmount", async () => {
  await render({ source: { kind: "file", path: "/repo/site/index.html" }, title: "Site" });
  act(() => root.unmount());
  await act(async () => {});
  expect(invoke).toHaveBeenCalledWith("preview_close", { token: "tok1" });
  expect(unlisten).toHaveBeenCalled();
  root = createRoot(container);
});

it("renders stored artifacts and reloads them when they are saved again", async () => {
  await render({ source: { kind: "artifact", id: "artifact-1" }, title: "Chart", version: 1 });
  expect(invoke).toHaveBeenCalledWith("preview_open", {
    source: { kind: "artifact", id: "artifact-1" },
  });
  const first = frame()!;
  const firstSrc = first.getAttribute("src");
  expect(firstSrc).toMatch(/\/tok1\//);
  await render({ source: { kind: "artifact", id: "artifact-1" }, title: "Chart", version: 2 });
  const reloaded = frame()!;
  expect(reloaded !== first || reloaded.getAttribute("src") !== firstSrc).toBe(true);
});

it("shows an error instead of a blank frame when the preview cannot open", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("missing"));
  await render({ source: { kind: "file", path: "/gone/index.html" }, title: "Gone" });
  expect(frame()).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/preview/i);
});
