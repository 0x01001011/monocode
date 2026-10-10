// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { HtmlFrame } from "./HtmlFrame";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const path = "remote://m1/home/k/site/index.html";
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "preview_open" ? "tok1" : undefined,
  );
  vi.mocked(listen).mockImplementation(async () => () => {});
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

async function show(html: string) {
  await act(async () =>
    root.render(
      createElement(HtmlFrame, {
        source: { kind: "page", path, html },
        title: "index.html",
      }),
    ),
  );
  await act(async () => {});
}

const calls = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

it("opens a remote page from its markup, not from a local folder", async () => {
  await show("<h1>One</h1>");
  expect(calls("preview_open")).toEqual([
    ["preview_open", { source: { kind: "html", html: "<h1>One</h1>" } }],
  ]);
  expect(container.querySelector("iframe")?.getAttribute("src")).toMatch(
    /\/tok1\/index\.html$/,
  );
});

it("sends later markup to the open preview and loads it behind the page on screen", async () => {
  await show("<h1>One</h1>");
  expect(calls("preview_update")).toHaveLength(0);
  const first = container.querySelector("iframe")!;
  act(() => void first.dispatchEvent(new Event("load")));
  await show("<h1>Two</h1>");
  expect(calls("preview_update")).toEqual([
    ["preview_update", { token: "tok1", html: "<h1>Two</h1>" }],
  ]);
  // The preview is reused: no second registration, and a fresh frame loads.
  expect(calls("preview_open")).toHaveLength(1);
  // The loaded page stays on screen until the new one is ready.
  const all = [...container.querySelectorAll("iframe")];
  expect(all).toHaveLength(2);
  expect(all[0]).toBe(first);
  expect(all[1].style.visibility).toBe("hidden");
});

it("does not resend markup that did not change", async () => {
  await show("<h1>One</h1>");
  await show("<h1>One</h1>");
  expect(calls("preview_update")).toHaveLength(0);
});

it("offers Retry when the markup cannot be shown", async () => {
  await show("<h1>One</h1>");
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "preview_update") throw new Error("Preview is not open");
    return command === "preview_open" ? "tok2" : undefined;
  });
  await show("<h1>Two</h1>");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not open this preview",
  );
});
