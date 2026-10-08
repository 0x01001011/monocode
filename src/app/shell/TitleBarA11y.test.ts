// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TitleBar, type Tab } from "./TitleBar";

vi.mock("./WindowControls", () => ({ WindowControls: () => null }));

let container: HTMLDivElement;
let root: Root;

function tab(id: string, overrides: Partial<Tab> = {}): Tab {
  return {
    id,
    project: "project",
    title: id,
    more: [],
    sessionCount: 1,
    harnesses: ["codex"],
    busyHarnesses: [],
    doneHarnesses: [],
    files: [],
    ...overrides,
  };
}

function render(tabs: Tab[]) {
  act(() =>
    root.render(
      createElement(TitleBar, {
        tabs,
        activeId: "active",
        cwd: "/project",
        onToggleSidebar: vi.fn(),
        onSelect: vi.fn(),
        onClose: vi.fn(),
        onCloseMany: vi.fn(),
        onReorder: vi.fn(),
      }),
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const tabButton = (id: string) =>
  container.querySelector<HTMLElement>(
    `[data-title-tab-id="${id}"] button:not([data-no-drag])`,
  )!;

describe("title bar tab accessibility", () => {
  it("marks only the active session tab as current", () => {
    render([tab("one"), tab("active")]);

    expect(tabButton("active").getAttribute("aria-current")).toBe("page");
    expect(tabButton("one").hasAttribute("aria-current")).toBe(false);
  });

  it("includes unsaved changes in the tab's accessible name", () => {
    render([tab("one", { dirty: true }), tab("active")]);

    expect(tabButton("one").getAttribute("aria-label")).toContain(
      "Unsaved changes",
    );
    expect(tabButton("active").getAttribute("aria-label")).not.toContain(
      "Unsaved changes",
    );
    expect(
      tabButton("one").querySelector("[aria-label='Unsaved changes']"),
    ).toBeNull();
  });

  it("reveals the close button on keyboard focus and uses a sentence-case tooltip", () => {
    render([tab("one"), tab("active")]);
    const close = container.querySelector<HTMLElement>(
      '[data-title-tab-id="one"] button[data-no-drag]',
    )!;

    expect(close.getAttribute("title")).toBe("Close tab");
    expect(close.classList).toContain("opacity-0");
    expect(close.classList).toContain("focus-visible:opacity-100");
    expect(close.classList).toContain("group-has-[:focus-visible]:opacity-100");
    expect(close.classList).toContain("hit-area");
  });
});
