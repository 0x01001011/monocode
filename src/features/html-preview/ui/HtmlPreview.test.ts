// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { HtmlPreview } from "./HtmlPreview";
import { clearPreviewLogs, recordPreviewLog } from "../previewLogs";
import { copyMessage } from "../../../platform/tauri/clipboard";

vi.mock("../../../platform/tauri/clipboard", () => ({
  copyMessage: vi.fn().mockResolvedValue(undefined),
}));

const LOG_KEY = "artifact:artifact-1";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

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
  clearPreviewLogs(LOG_KEY);
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount() {
  await act(async () =>
    root.render(
      createElement(HtmlPreview, {
        source: { kind: "artifact", id: "artifact-1" },
        title: "Dashboard",
        version: 1,
      }),
    ),
  );
  await act(async () => {});
}
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const press = (key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
};

it("shows the page with reload and expand controls", async () => {
  await mount();
  expect(container.querySelector("iframe")).not.toBeNull();
  expect(button("Reload preview")).not.toBeNull();
  expect(button("Expand preview")).not.toBeNull();
});

it("reloads the page on demand without opening a second preview", async () => {
  await mount();
  const before = container.querySelector("iframe");
  act(() => button("Reload preview")!.click());
  await act(async () => {});
  const after = container.querySelector("iframe");
  expect(after).not.toBeNull();
  expect(after).not.toBe(before);
  expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "preview_open")).toHaveLength(1);
});

it("expands to fill the reader and collapses with Escape before anything else sees it", async () => {
  await mount();
  const outer = container.querySelector("[data-html-preview-root]")!;
  expect(outer.getAttribute("data-expanded")).toBeNull();
  act(() => button("Expand preview")!.click());
  expect(outer.getAttribute("data-expanded")).toBe("true");
  expect(button("Collapse preview")).not.toBeNull();
  const bubbled = vi.fn();
  window.addEventListener("keydown", bubbled);
  const event = press("Escape");
  window.removeEventListener("keydown", bubbled);
  expect(outer.getAttribute("data-expanded")).toBeNull();
  // The reader behind it must stay open: this Escape was spent collapsing.
  expect(event.defaultPrevented).toBe(true);
  expect(bubbled).not.toHaveBeenCalled();
});

it("leaves Escape alone while the preview is not expanded", async () => {
  await mount();
  const event = press("Escape");
  expect(event.defaultPrevented).toBe(false);
});

const text = (selector: string) => container.querySelector(selector)?.textContent ?? "";

it("shows no error count until the page reports an error", async () => {
  await mount();
  expect(button("Console")).not.toBeNull();
  recordPreviewLog(LOG_KEY, "log", "just a note");
  await act(async () => {});
  expect(button("Console")).not.toBeNull();
  expect(container.querySelector("[data-console-errors]")).toBeNull();
});

it("counts errors on the Console button and lists the output in a drawer", async () => {
  await mount();
  await act(async () => {
    recordPreviewLog(LOG_KEY, "log", "loaded");
    recordPreviewLog(LOG_KEY, "error", "Uncaught ReferenceError: chart is not defined");
    recordPreviewLog(LOG_KEY, "error", "Unhandled rejection: 404");
  });
  const toggle = button("Console, 2 errors")!;
  expect(toggle).not.toBeNull();
  expect(text("[data-console-errors]")).toBe("2");
  expect(container.querySelector("[data-preview-console]")).toBeNull();
  act(() => toggle.click());
  const drawer = container.querySelector("[data-preview-console]")!;
  expect(drawer.getAttribute("role")).toBe("log");
  expect(drawer.textContent).toContain("loaded");
  expect(drawer.textContent).toContain("chart is not defined");
  expect(drawer.querySelectorAll("[data-level=error]")).toHaveLength(2);
});

it("clears the output and copies it as text", async () => {
  await mount();
  await act(async () => {
    recordPreviewLog(LOG_KEY, "warn", "slow image");
    recordPreviewLog(LOG_KEY, "error", "boom");
  });
  act(() => button("Console, 1 error")!.click());
  await act(async () => button("Copy console")!.click());
  expect(copyMessage).toHaveBeenCalledWith("[warn] slow image\n[error] boom");
  act(() => button("Clear console")!.click());
  expect(container.querySelector("[data-preview-console]")?.textContent).toContain(
    "No console output",
  );
  expect(container.querySelector("[data-console-errors]")).toBeNull();
});

// --- width presets ----------------------------------------------------------

const radio = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${label}"]`);
const stage = () => container.querySelector<HTMLElement>("[data-preview-stage]")!;

it("offers Full, Tablet and Phone widths as a labelled radio group, defaulting to Full", async () => {
  await mount();
  const group = container.querySelector('[role="radiogroup"]')!;
  expect(group.getAttribute("aria-label")).toBe("Preview width");
  expect(radio("Full width")?.getAttribute("aria-checked")).toBe("true");
  expect(radio("Tablet width, 768 pixels")?.getAttribute("aria-checked")).toBe("false");
  expect(radio("Phone width, 375 pixels")?.getAttribute("aria-checked")).toBe("false");
  expect(stage().style.maxWidth).toBe("");
});

it("narrows the page to the chosen device width and back", async () => {
  await mount();
  act(() => radio("Phone width, 375 pixels")!.click());
  expect(radio("Phone width, 375 pixels")!.getAttribute("aria-checked")).toBe("true");
  expect(radio("Full width")!.getAttribute("aria-checked")).toBe("false");
  expect(stage().style.maxWidth).toBe("375px");
  expect(stage().getAttribute("data-width")).toBe("phone");
  act(() => radio("Tablet width, 768 pixels")!.click());
  expect(stage().style.maxWidth).toBe("768px");
  act(() => radio("Full width")!.click());
  expect(stage().style.maxWidth).toBe("");
});

it("keeps the same page when the width changes, instead of reopening it", async () => {
  await mount();
  const before = container.querySelector("iframe");
  act(() => radio("Phone width, 375 pixels")!.click());
  expect(container.querySelector("iframe")).toBe(before);
  expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "preview_open")).toHaveLength(1);
});

it("lets the arrow keys move between widths, as a radio group should", async () => {
  await mount();
  const full = radio("Full width")!;
  act(() => {
    full.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(radio("Tablet width, 768 pixels")!.getAttribute("aria-checked")).toBe("true");
  act(() => {
    radio("Tablet width, 768 pixels")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
  });
  expect(radio("Full width")!.getAttribute("aria-checked")).toBe("true");
});
