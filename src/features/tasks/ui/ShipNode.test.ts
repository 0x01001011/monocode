// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ship } from "../model/ship";
import { ShipNode } from "./ShipNode";

let container: HTMLDivElement;
let root: Root;

const NOT_READY: Ship = {
  ready: false,
  items: [
    { id: "tasks", met: false, text: "2 tasks left", nodeId: "task-4" },
    { id: "final", met: false, text: "final review not done", nodeId: "final-review" },
    { id: "tests", met: "unknown", text: "no test run yet" },
    { id: "gaps", met: true, text: "no gaps" },
  ],
  left: 3,
  deferred: 2,
  commits: 4,
};

const READY: Ship = {
  ready: true,
  items: [
    { id: "tasks", met: true, text: "every task done" },
    { id: "final", met: true, text: "final review clean" },
    { id: "tests", met: true, text: "tests passed" },
    { id: "gaps", met: true, text: "no gaps" },
  ],
  left: 0,
  deferred: 0,
  commits: 14,
};

function render(props: Partial<ComponentProps<typeof ShipNode>> = {}) {
  const all = {
    ship: NOT_READY,
    tasks: 6,
    steps: 31,
    open: true,
    onToggle: vi.fn(),
    onReveal: vi.fn(),
    onCopySummary: vi.fn(),
    ...props,
  };
  act(() => root.render(createElement(ShipNode, all)));
  return all;
}

const text = () => container.textContent ?? "";
const header = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]");
const button = (name: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === name);
const click = (el: Element | undefined) => {
  expect(el).toBeDefined();
  act(() => el?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ShipNode", () => {
  it("is the Ship checklist with how many items are met (the graph row says the verdict)", () => {
    render({ open: false });
    expect(header()?.textContent).toBe("Ship checklist · 1 of 4 met");
    render({ open: false, ship: READY });
    expect(header()?.textContent).toBe("Ship checklist · 4 of 4 met");
  });

  it("is a disclosure: collapsed shows no checklist and a press asks to toggle", () => {
    const props = render({ open: false });
    expect(header()?.getAttribute("aria-expanded")).toBe("false");
    expect(text()).not.toContain("final review not done");
    click(header() ?? undefined);
    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });

  it("lists every item; unmet ones with a row are buttons that reveal it", () => {
    const props = render();
    expect(header()?.getAttribute("aria-expanded")).toBe("true");
    click(button("2 tasks left"));
    expect(props.onReveal).toHaveBeenCalledWith("task-4");
    click(button("final review not done"));
    expect(props.onReveal).toHaveBeenLastCalledWith("final-review");
    // Unknown without a row and met items are words, never buttons.
    expect(text()).toContain("no test run yet");
    expect(button("no test run yet")).toBeUndefined();
    expect(text()).toContain("no gaps");
    expect(button("no gaps")).toBeUndefined();
  });

  it("gives each item a glyph that says its state, so state is never colour alone", () => {
    render();
    const labels = Array.from(container.querySelectorAll("li [role=img]")).map((g) => g.getAttribute("aria-label"));
    expect(labels).toEqual(["not met", "not met", "unknown", "done"]);
  });

  it("names the deferred items, which never block", () => {
    render();
    expect(text()).toContain("2 deferred (not blocking)");
    render({ ship: { ...NOT_READY, deferred: 0 } });
    expect(text()).not.toContain("deferred");
  });

  it("when ready: says so with the totals and offers Copy summary", () => {
    const props = render({ ship: READY });
    expect(text()).toContain("Ready to ship · 6 tasks · 31 steps · 14 commits");
    click(button("Copy summary"));
    expect(props.onCopySummary).toHaveBeenCalledTimes(1);
    render({ ship: READY, copied: true });
    expect(button("Copied")).toBeDefined();
    render({ ship: NOT_READY });
    expect(button("Copy summary")).toBeUndefined();
  });

  it("uses 24 px targets with the inset focus ring", () => {
    render();
    for (const b of Array.from(container.querySelectorAll("button"))) {
      expect(b.className).toMatch(/min-h-6/);
      expect(b.className).toContain("focus-visible:focus-ring-inset");
    }
  });
});
