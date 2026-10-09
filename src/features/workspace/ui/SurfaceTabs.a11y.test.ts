// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newFileTab } from "../model/layout";
import { SurfaceTabs } from "./SurfaceTabs";

let container: HTMLDivElement;
let root: Root;

const files = [
  newFileTab("/repo/a.ts", "/repo"),
  newFileTab("/repo/b.ts", "/repo"),
  newFileTab("/repo/c.ts", "/repo"),
];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(
  activeFileId: string,
  overrides: Partial<Parameters<typeof SurfaceTabs>[0]> = {},
) {
  const onSelectFile = vi.fn();
  act(() =>
    root.render(
      createElement(SurfaceTabs, {
        files,
        activeFileId,
        dirtyFileIds: new Set<string>(),
        fileErrorCounts: new Map<string, number>(),
        onSelectFile,
        onCloseFile: vi.fn(),
        onCloseOtherFiles: vi.fn(),
        onReorder: vi.fn(),
        onPaneDragStart: vi.fn(),
        ...overrides,
      }),
    ),
  );
  return { onSelectFile };
}

const tabs = () =>
  Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));

function press(target: HTMLElement, key: string) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("SurfaceTabs keyboard and semantics", () => {
  it("keeps one tab stop on the active tab", () => {
    render(files[1]!.id);

    expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("falls back to the first tab when the active id is not in the strip", () => {
    render("elsewhere");

    expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
  });

  it("moves focus and selection with Left, Right, Home and End", () => {
    const { onSelectFile } = render(files[0]!.id);
    const [first, second, third] = tabs();

    const right = press(first!, "ArrowRight");
    expect(right.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(second);
    expect(onSelectFile).toHaveBeenLastCalledWith(files[1]!.id);

    press(second!, "End");
    expect(document.activeElement).toBe(third);
    expect(onSelectFile).toHaveBeenLastCalledWith(files[2]!.id);

    press(third!, "ArrowRight");
    expect(document.activeElement).toBe(first);
    expect(onSelectFile).toHaveBeenLastCalledWith(files[0]!.id);

    press(first!, "ArrowLeft");
    expect(document.activeElement).toBe(third);
  });

  it("leaves arrow keys alone on the close buttons", () => {
    const { onSelectFile } = render(files[0]!.id);
    const close = container.querySelector<HTMLElement>(
      'button[aria-label^="Close"]',
    )!;

    const event = press(close, "ArrowRight");

    expect(event.defaultPrevented).toBe(false);
    expect(onSelectFile).not.toHaveBeenCalled();
  });

  it("hides the drag handle and tab wrappers from the tablist", () => {
    render(files[0]!.id);
    const list = container.querySelector('[role="tablist"]')!;

    expect(list.querySelector('[role="button"]')).toBeNull();
    expect(
      list.querySelector('[role="presentation"][title="Drag to reorder pane"]'),
    ).not.toBeNull();
    expect(list.querySelector("[data-tab-slot-id]")?.getAttribute("role")).toBe(
      "presentation",
    );
  });

  it("reveals the close button when its tab has keyboard focus", () => {
    render(files[0]!.id);
    const close = container.querySelector<HTMLElement>(
      `[data-tab-slot-id="${files[1]!.id}"] button[aria-label^="Close"]`,
    )!;

    expect(close.classList).toContain("opacity-0");
    expect(close.classList).toContain("focus-visible:opacity-100");
    expect(close.classList).toContain("group-has-[:focus-visible]:opacity-100");
  });

  it("puts unsaved state in the tab's accessible name, not on a bare span", () => {
    render(files[0]!.id, { dirtyFileIds: new Set([files[0]!.id]) });
    const tab = tabs()[0]!;

    expect(tab.textContent).toContain("unsaved changes");
    expect(tab.querySelector("[aria-label]")).toBeNull();
    expect(tab.querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(tabs()[1]!.textContent).not.toContain("unsaved");
  });
});
