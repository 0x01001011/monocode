// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PREVIEW_CHANGED_EVENT } from "../htmlPreview";
import { HtmlFrame } from "./HtmlFrame";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
let emit: (token: string) => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "preview_open" ? "tok1" : undefined,
  );
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    if (event === PREVIEW_CHANGED_EVENT)
      emit = (payload) => (handler as (e: { payload: string }) => void)({ payload });
    return () => {};
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const frames = () => [...container.querySelectorAll<HTMLIFrameElement>("iframe")];
const visible = () => frames().filter((f) => f.style.visibility !== "hidden");
const load = (frame: HTMLIFrameElement) => act(() => void frame.dispatchEvent(new Event("load")));

async function mount(props: { version?: number; reloadKey?: number } = {}) {
  await act(async () =>
    root.render(
      createElement(HtmlFrame, {
        source: { kind: "file", path: "/repo/site/index.html" },
        title: "Site",
        ...props,
      }),
    ),
  );
  await act(async () => {});
}

it("keeps the loaded page visible while the next one loads, then swaps", async () => {
  await mount();
  const [first] = frames();
  load(first);
  act(() => emit("tok1"));
  expect(frames()).toHaveLength(2);
  // The old page is still the one on screen, and it is a loaded one.
  expect(visible()).toEqual([first]);
  expect(first.getAttribute("data-loaded")).toBe("true");
  const next = frames()[1];
  expect(next.style.visibility).toBe("hidden");
  load(next);
  expect(frames()).toEqual([next]);
  expect(next.style.visibility).not.toBe("hidden");
});

it("never shows a frame that has not loaded once a loaded one exists", async () => {
  await mount();
  load(frames()[0]);
  const check = () => {
    const shown = visible();
    expect(shown).toHaveLength(1);
    expect(shown[0].getAttribute("data-loaded")).toBe("true");
  };
  check();
  for (let i = 0; i < 3; i += 1) {
    act(() => emit("tok1"));
    check();
    load(frames()[frames().length - 1]);
    check();
  }
});

it("swaps anyway when the new page never reports loading", async () => {
  await mount();
  const [first] = frames();
  load(first);
  act(() => emit("tok1"));
  expect(frames()).toHaveLength(2);
  await act(async () => void vi.advanceTimersByTime(2000));
  expect(frames()).toHaveLength(1);
  expect(frames()[0]).not.toBe(first);
});

it("replaces a pending page instead of stacking up while saves keep coming", async () => {
  await mount();
  load(frames()[0]);
  act(() => emit("tok1"));
  act(() => emit("tok1"));
  act(() => emit("tok1"));
  expect(frames()).toHaveLength(2);
  expect(visible()).toHaveLength(1);
});

it("treats a version change and a Reload press the same way", async () => {
  await mount({ version: 1, reloadKey: 0 });
  load(frames()[0]);
  await mount({ version: 2, reloadKey: 0 });
  expect(frames()).toHaveLength(2);
  load(frames()[1]);
  await mount({ version: 2, reloadKey: 1 });
  expect(frames()).toHaveLength(2);
  load(frames()[1]);
  expect(frames()).toHaveLength(1);
});

it("accepts the page's messages from whichever of its frames sent them", async () => {
  await mount();
  load(frames()[0]);
  act(() => emit("tok1"));
  const next = frames()[1];
  const fake = {} as Window;
  Object.defineProperty(next, "contentWindow", { value: fake });
  const seen = vi.fn();
  window.addEventListener("keydown", seen);
  act(() => {
    window.dispatchEvent(
      Object.assign(
        new MessageEvent("message", {
          data: { mcp: 1, n: next.getAttribute("name"), type: "escape" },
        }),
        { source: fake },
      ),
    );
  });
  window.removeEventListener("keydown", seen);
  expect(seen).toHaveBeenCalledTimes(1);
});
