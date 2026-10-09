// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardNode } from "../model/taskBoard";
import { TaskGlyph, glyphForStatus, type GlyphKind } from "./TaskGlyph";
import { TaskTree } from "./TaskTree";

let container: HTMLDivElement;
let root: Root;

function node(id: string, patch: Partial<BoardNode> = {}): BoardNode {
  return { id, title: `Task ${id}`, status: "done", ...patch };
}

function render(props: Partial<ComponentProps<typeof TaskTree>> = {}) {
  act(() =>
    root.render(
      createElement(TaskTree, {
        nodes: [node("a"), node("b"), node("c")],
        label: "Plan tasks",
        now: 100_000,
        ...props,
      }),
    ),
  );
}

function items(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[role=treeitem]"));
}

function focus(el: HTMLElement) {
  act(() => el.focus());
}

function press(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("TaskTree", () => {
  it("renders one tab stop", () => {
    render();
    const tree = container.querySelector("ul[role=tree]");
    expect(tree?.getAttribute("aria-label")).toBe("Plan tasks");
    expect(items().map((el) => el.tabIndex)).toEqual([0, -1, -1]);
    expect(container.querySelectorAll("[tabindex='0']")).toHaveLength(1);
  });

  it("arrow keys move the roving focus", () => {
    render();
    const [a, b, c] = items();
    focus(a);
    press(a, "ArrowDown");
    expect(document.activeElement).toBe(b);
    expect(items().map((el) => el.tabIndex)).toEqual([-1, 0, -1]);
    press(b, "End");
    expect(document.activeElement).toBe(c);
    press(c, "ArrowDown");
    expect(document.activeElement).toBe(c);
    press(c, "ArrowUp");
    expect(document.activeElement).toBe(b);
    press(b, "Home");
    expect(document.activeElement).toBe(a);
    press(a, "ArrowUp");
    expect(document.activeElement).toBe(a);
  });

  it("right arrow expands a node with a summary and left collapses it", () => {
    render({ nodes: [node("a", { summary: "Review found 3 issues." }), node("b")] });
    const [a, b] = items();
    expect(a.getAttribute("aria-expanded")).toBe("false");
    expect(b.hasAttribute("aria-expanded")).toBe(false);
    expect(container.textContent).not.toContain("Review found 3 issues.");
    focus(a);
    press(a, "ArrowRight");
    expect(a.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Review found 3 issues.");
    press(a, "ArrowLeft");
    expect(a.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Review found 3 issues.");
  });

  it("walks into children and left returns to the parent", () => {
    render({ nodes: [node("a", { children: [node("a1"), node("a2")] }), node("b")] });
    const a = items()[0];
    focus(a);
    press(a, "ArrowRight");
    expect(items().map((el) => el.textContent?.includes("Task a1"))).toContain(true);
    press(a, "ArrowRight");
    const a1 = items()[1];
    expect(document.activeElement).toBe(a1);
    expect(a1.closest("ul")?.getAttribute("role")).toBe("group");
    press(a1, "ArrowDown");
    expect(document.activeElement).toBe(items()[2]);
    press(items()[2], "ArrowLeft");
    expect(document.activeElement).toBe(a);
  });

  it("enter calls onOpen with the node", () => {
    const onOpen = vi.fn();
    const nodes = [node("a"), node("b")];
    render({ nodes, onOpen });
    const b = items()[1];
    focus(b);
    press(b, "Enter");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(nodes[1]);
  });

  it("glyphs carry aria-labels", () => {
    const labels: Record<GlyphKind, string> = {
      done: "done",
      pending: "not started",
      running: "running",
      ask: "needs you",
      struggling: "struggling",
      quiet: "quiet",
      failed: "failed",
      blocked: "blocked",
      cancelled: "cancelled",
      issues: "review found issues",
    };
    for (const [kind, label] of Object.entries(labels)) {
      act(() => root.render(createElement(TaskGlyph, { kind: kind as GlyphKind })));
      expect(container.querySelector(`[aria-label='${label}']`), kind).not.toBeNull();
    }
    expect(glyphForStatus("pending")).toBe("pending");
    expect(glyphForStatus("running")).toBe("running");
    expect(glyphForStatus("done")).toBe("done");
    expect(glyphForStatus("attention")).toBe("issues");
    expect(glyphForStatus("failed")).toBe("failed");
    expect(glyphForStatus("blocked")).toBe("blocked");
    expect(glyphForStatus("cancelled")).toBe("cancelled");
    render({ nodes: [node("a", { status: "pending" })] });
    expect(items()[0].querySelector("[aria-label='not started']")).not.toBeNull();
  });

  it("no chevron on a plain finished task", () => {
    render({ nodes: [node("a", { startedAt: 0, endedAt: 120_000 })] });
    expect(items()[0].hasAttribute("aria-expanded")).toBe(false);
    expect(container.querySelector("[data-chevron]")).toBeNull();
  });

  it("running node shows a live duration and a pending node shows none", () => {
    render({
      now: 134_000,
      nodes: [
        node("a", { status: "running", startedAt: 0 }),
        node("b", { status: "pending" }),
        node("c", { status: "done", startedAt: 0, endedAt: 19 * 60_000 }),
      ],
    });
    const [a, b, c] = items();
    expect(a.textContent).toContain("2m 14s");
    expect(b.querySelector("[data-duration]")?.textContent ?? "").toBe("");
    expect(c.textContent).toContain("19m");
    expect(container.textContent).not.toContain("NaN");
  });

  it("shows a dash for a running node with no start time", () => {
    render({ nodes: [node("a", { status: "running" })] });
    expect(items()[0].querySelector("[data-duration]")?.textContent).toBe("—");
    expect(container.textContent).not.toContain("NaN");
  });

  it("fix-round tag shows for fixRounds 3", () => {
    render({
      nodes: [
        node("a", { status: "attention", fixRounds: 3 }),
        node("b", { status: "attention", fixRounds: 2 }),
      ],
    });
    const [a, b] = items();
    expect(a.textContent).toContain("fix 3 of 5");
    expect(b.textContent).not.toContain("fix 2 of 5");
  });

  it("an unfinished attention task ticks from its start; a blocked one with no end shows a dash", () => {
    render({
      nodes: [
        node("a", { status: "attention", fixRounds: 3, startedAt: 100_000 - 74_000 }),
        node("b", { status: "blocked", startedAt: 10_000 }),
        node("c", { status: "attention", startedAt: 0, endedAt: 3 * 60_000 }),
      ],
    });
    const [a, b, c] = items().map((el) => el.querySelector("[data-duration]")?.textContent);
    expect(a).toBe("1m 14s");
    expect(b).toBe("—");
    expect(c).toBe("3m");
  });

  it("the fix tag is clamped at 5 of 5, and a blocked task gets an amber blocked tag", () => {
    render({ nodes: [node("a", { status: "attention", fixRounds: 6 }), node("b", { status: "blocked" })] });
    const [a, b] = items();
    expect(a.textContent).toContain("fix 5 of 5");
    expect(a.textContent).not.toContain("fix 6");
    const tag = b.querySelector("[data-tag=blocked]");
    expect(tag?.textContent).toBe("blocked");
    expect(tag?.className).toContain("text-warning");
  });

  it("puts the full title on the title attribute", () => {
    render({ nodes: [node("a", { title: "A very long task title" })] });
    expect(container.querySelector("[title='A very long task title']")).not.toBeNull();
  });

  it("respects controlled expansion", () => {
    const onToggle = vi.fn();
    render({
      nodes: [node("a", { summary: "Details here" })],
      expandedIds: new Set(["a"]),
      onToggle,
    });
    const a = items()[0];
    expect(a.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Details here");
    focus(a);
    press(a, "ArrowLeft");
    expect(onToggle).toHaveBeenCalledWith("a");
  });

  it("does not swallow Escape, Tab or modified keys", () => {
    const seen: string[] = [];
    const listener = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", listener);
    try {
      render({ nodes: [node("a", { summary: "x" }), node("b")] });
      const [a] = items();
      focus(a);
      for (const key of ["Escape", "Tab"]) {
        const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        act(() => {
          a.dispatchEvent(ev);
        });
        expect(ev.defaultPrevented, key).toBe(false);
      }
      expect(seen).toEqual(["Escape", "Tab"]);
      const alt = new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true });
      act(() => {
        a.dispatchEvent(alt);
      });
      expect(alt.defaultPrevented).toBe(false);
      press(a, "ArrowRight");
      const ctrl = new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true, bubbles: true, cancelable: true });
      act(() => {
        a.dispatchEvent(ctrl);
      });
      expect(a.getAttribute("aria-expanded")).toBe("true");
    } finally {
      window.removeEventListener("keydown", listener);
    }
  });

  it("a nested treeitem key event does not run the parent handler", () => {
    render({
      nodes: [node("a", { children: [node("a1")] }), node("b")],
      expandedIds: new Set(["a"]),
    });
    const [a, a1] = items();
    focus(a1);
    press(a1, "ArrowDown");
    // Only the child's handler ran: focus moved once, to b (not twice).
    expect(document.activeElement).toBe(items()[2]);
    expect(a.getAttribute("aria-expanded")).toBe("true");
  });

  it("a steps-only node has no chevron and no aria-expanded", () => {
    render({ nodes: [node("a", { steps: [{ text: "s", done: false }] })] });
    expect(items()[0].hasAttribute("aria-expanded")).toBe(false);
    expect(container.querySelector("[data-chevron]")).toBeNull();
  });

  it("stage rows are not openable", () => {
    const onOpen = vi.fn();
    render({
      onOpen,
      nodes: [
        node("a", {
          status: "running",
          startedAt: 0,
          stages: [{ kind: "implement", label: "Code written", status: "done" }],
        }),
      ],
      expandedIds: new Set(["a"]),
    });
    const stage = items()[1];
    expect(stage.textContent).toContain("Code written");
    focus(stage);
    press(stage, "Enter");
    expect(onOpen).not.toHaveBeenCalled();
    act(() => {
      stage.querySelector<HTMLElement>("[data-row]")?.click();
    });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("clicking an expandable row toggles it; a plain row opens", () => {
    const onOpen = vi.fn();
    const nodes = [node("a", { summary: "More" }), node("b")];
    render({ nodes, onOpen });
    const [a, b] = items();
    act(() => {
      a.querySelector<HTMLElement>("[data-row]")?.click();
    });
    expect(a.getAttribute("aria-expanded")).toBe("true");
    expect(onOpen).not.toHaveBeenCalled();
    act(() => {
      b.querySelector<HTMLElement>("[data-row]")?.click();
    });
    expect(onOpen).toHaveBeenCalledWith(nodes[1]);
  });

  it("left arrow on a collapsed root item does nothing", () => {
    render({ nodes: [node("a", { summary: "x" }), node("b")] });
    const a = items()[0];
    focus(a);
    press(a, "ArrowLeft");
    expect(document.activeElement).toBe(a);
    expect(a.getAttribute("aria-expanded")).toBe("false");
  });

  it("collapsing the parent of the focused child moves the tab stop and focus to the parent", () => {
    const nodes = [node("a", { children: [node("a1")] }), node("b")];
    render({ nodes, expandedIds: new Set(["a"]) });
    const a1 = items()[1];
    focus(a1);
    expect(a1.tabIndex).toBe(0);
    render({ nodes, expandedIds: new Set() });
    const [a, b] = items();
    expect(a.tabIndex).toBe(0);
    expect(b.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(a);
  });
});
