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

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

const render = () =>
  act(async () =>
    root.render(
      createElement(HtmlFrame, {
        source: { kind: "artifact", id: "artifact-1" },
        title: "Dashboard",
      }),
    ),
  );

it("shows a visible loading state while the preview opens", async () => {
  let open!: (token: string) => void;
  vi.mocked(invoke).mockImplementation(
    (command) =>
      new Promise((resolve) => {
        if (command === "preview_open") open = resolve as (token: string) => void;
        else resolve(undefined);
      }),
  );
  await render();
  const status = container.querySelector('[role="status"]')!;
  expect(status.textContent).toContain("Loading preview");
  // Visible, not just announced to screen readers.
  expect(status.className).not.toContain("sr-only");
  await act(async () => open("tok1"));
  expect(container.querySelector("iframe")).not.toBeNull();
});

it("offers Retry when the preview cannot open, and recovers", async () => {
  let attempts = 0;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command !== "preview_open") return undefined;
    attempts += 1;
    if (attempts === 1) throw new Error("not ready");
    return "tok1";
  });
  await render();
  await act(async () => {});
  const alert = container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("Could not open this preview");
  const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
  expect(retry).toBeDefined();
  await act(async () => retry.click());
  await act(async () => {});
  expect(attempts).toBe(2);
  expect(container.querySelector("iframe")).not.toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
