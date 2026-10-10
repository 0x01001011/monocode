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

/** Opens the row at `index` the way a user does, with a click. */
function openRow(index: number) {
  act(() => {
    items()[index]?.querySelector<HTMLElement>("[data-row]")?.click();
  });
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

  it("a glyph label override replaces the default name", () => {
    act(() => root.render(createElement(TaskGlyph, { kind: "pending", label: "not ticked" })));
    expect(container.querySelector("[aria-label='not ticked']")).not.toBeNull();
    expect(container.querySelector("[aria-label='not started']")).toBeNull();
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
    render({ nodes: [node("a", { children: [node("a1")] }), node("b")] });
    openRow(0);
    const [a, a1] = items();
    focus(a1);
    press(a1, "ArrowDown");
    // Only the child's handler ran: focus moved once, to b (not twice).
    expect(document.activeElement).toBe(items()[2]);
    expect(a.getAttribute("aria-expanded")).toBe("true");
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
    });
    openRow(0);
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
    render({ nodes });
    openRow(0);
    const a1 = items()[1];
    focus(a1);
    expect(a1.tabIndex).toBe(0);
    openRow(0);
    const [a, b] = items();
    expect(a.tabIndex).toBe(0);
    expect(b.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(a);
  });

  describe("steps", () => {
    const steps = (done: boolean[]) => done.map((d, i) => ({ text: `Step text ${i + 1}`, done: d }));
    const running = (patch: Partial<BoardNode> = {}) =>
      node("a", { status: "running", startedAt: 0, steps: steps([true, true, false, false, false]), ...patch });

    it("a node with steps is expandable and lists them as leaf treeitems", () => {
      render({ nodes: [running(), node("b")] });
      openRow(0);
      const all = items();
      expect(all[0].getAttribute("aria-expanded")).toBe("true");
      expect(all[0].querySelector("[data-chevron]")).not.toBeNull();
      expect(all.map((el) => el.querySelector("[data-row]")?.textContent?.includes("Step text"))).toEqual([
        false, true, true, true, true, true, false,
      ]);
      const step = all[1];
      expect(step.hasAttribute("aria-expanded")).toBe(false);
      expect(step.closest("ul")?.getAttribute("role")).toBe("group");
    });

    it("steps follow the stage rows, in order, with the right glyph labels", () => {
      render({ nodes: [running({ stages: [{ kind: "implement", label: "Code written", status: "done" }] })] });
      openRow(0);
      const texts = items().map((el) => el.querySelector("[data-row]")?.textContent ?? "");
      expect(texts[1]).toContain("Code written");
      expect(texts.slice(2).map((t) => t.replace(/\D/g, ""))).toEqual(["1", "2", "3", "4", "5"]);
      const marks = items()
        .slice(2)
        .map((el) => el.querySelector("[role=img]")?.getAttribute("aria-label"));
      expect(marks).toEqual(["done", "done", "not ticked", "not ticked", "not ticked"]);
      expect(container.querySelector("[aria-label='not started']")).toBeNull();
    });

    it("gives step rows stable ids, a 2-line clamp and the full text in the title", () => {
      const long = "A long step ".repeat(20).trim();
      render({
        nodes: [node("a", { status: "running", startedAt: 0, steps: [{ text: long, done: false, ticked: false }] })],
      });
      openRow(0);
      const text = items()[1].querySelector(`[title='${long}']`);
      expect(text?.className).toContain("line-clamp-2");
      expect(text?.className).not.toContain("truncate");
    });

    it("labels the steps group and shows the caption once", () => {
      render({ nodes: [running()] });
      openRow(0);
      const group = container.querySelector("ul[role=group][aria-label]");
      expect(group?.getAttribute("aria-label")).toBe("Steps, 2 of 5 ticked");
      const caption = Array.from(group?.querySelectorAll("li") ?? []).filter((li) => li.getAttribute("role") !== "treeitem");
      expect(caption).toHaveLength(1);
      expect(caption[0].textContent).toBe("Steps 2 of 5");
      expect(caption[0].getAttribute("aria-hidden")).toBe("true");
      expect(container.textContent?.match(/Steps 2 of 5/g)).toHaveLength(1);
      // The caption is not a treeitem.
      expect(items()).toHaveLength(6);
    });

    it("keeps stage rows out of the labelled steps group", () => {
      render({ nodes: [running({ stages: [{ kind: "implement", label: "Code written", status: "done" }] })] });
      openRow(0);
      const group = container.querySelector("ul[role=group][aria-label]");
      expect(group?.textContent).not.toContain("Code written");
    });

    it("counts a done task's steps as all ticked", () => {
      render({
        nodes: [node("a", { startedAt: 0, endedAt: 60_000, steps: steps([true, true, true]) })],
      });
      openRow(0);
      expect(container.querySelector("ul[role=group]")?.getAttribute("aria-label")).toBe("Steps, 3 of 3 ticked");
    });

    it("Enter on a step does nothing and click does not open", () => {
      const onOpen = vi.fn();
      render({ nodes: [running()], onOpen });
      openRow(0);
      const step = items()[1];
      focus(step);
      press(step, "Enter");
      act(() => {
        step.querySelector<HTMLElement>("[data-row]")?.click();
      });
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("ArrowLeft on a step goes to the task, ArrowRight on a step does nothing", () => {
      render({ nodes: [running()] });
      openRow(0);
      const [a, s1, s2] = items();
      focus(s2);
      press(s2, "ArrowRight");
      expect(document.activeElement).toBe(s2);
      press(s2, "ArrowLeft");
      expect(document.activeElement).toBe(a);
      expect(a.getAttribute("aria-expanded")).toBe("true");
      // ArrowRight on the open task walks to the first step.
      press(a, "ArrowRight");
      expect(document.activeElement).toBe(s1);
    });

    it("Home and End span the task and its steps", () => {
      render({ nodes: [running(), node("b")] });
      openRow(0);
      const all = items();
      focus(all[3]);
      press(all[3], "End");
      expect(document.activeElement).toBe(all[6]);
      press(all[6], "Home");
      expect(document.activeElement).toBe(all[0]);
      press(all[0], "ArrowDown");
      expect(document.activeElement).toBe(all[1]);
    });

    it("right arrow opens a collapsed task with steps and left collapses it", () => {
      render({ nodes: [running(), node("b")] });
      const a = items()[0];
      expect(items()).toHaveLength(2);
      focus(a);
      press(a, "ArrowRight");
      expect(items()).toHaveLength(7);
      press(a, "ArrowLeft");
      expect(items()).toHaveLength(2);
    });

    it("collapsing a task with the focus on a step moves focus to the task", () => {
      render({ nodes: [running()] });
      openRow(0);
      focus(items()[2]);
      openRow(0);
      expect(document.activeElement).toBe(items()[0]);
    });

    it("shows N steps on a pending task, singular for one", () => {
      render({
        nodes: [
          node("a", { status: "pending", steps: steps([false, false, false]) }),
          node("b", { status: "pending", steps: steps([false]) }),
          node("c", { status: "pending" }),
        ],
      });
      const [a, b, c] = items();
      expect(a.querySelector("[data-meta=steps]")?.textContent).toBe("3 steps");
      expect(a.querySelector("[data-meta=steps]")?.className).toContain("text-muted");
      expect(b.querySelector("[data-meta=steps]")?.textContent).toBe("1 step");
      expect(c.querySelector("[data-meta=steps]")).toBeNull();
      expect(a.querySelector("[data-duration]")).toBeNull();
    });

    it("shows k/N before the duration on a started task that is not done", () => {
      render({ now: 134_000, nodes: [running(), node("b", { status: "attention", startedAt: 0, steps: steps([true, false]) })] });
      const [a, b] = items();
      const row = a.querySelector("[data-row]") as HTMLElement;
      const progress = row.querySelector("[data-meta=progress]");
      expect(progress?.querySelector("[aria-hidden=true]")?.textContent).toBe("2/5");
      expect(progress?.textContent).toContain("2 of 5 steps ticked");
      expect(progress?.className).toContain("tabular-nums");
      const duration = row.querySelector("[data-duration]");
      expect(duration?.textContent).toBe("2m 14s");
      expect(progress?.compareDocumentPosition(duration as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(b.querySelector("[data-meta=progress] [aria-hidden=true]")?.textContent).toBe("1/2");
    });

    it("a done task shows the duration only", () => {
      render({ nodes: [node("a", { startedAt: 0, endedAt: 120_000, steps: steps([true, true]) })] });
      const a = items()[0];
      expect(a.querySelector("[data-meta]")).toBeNull();
      expect(a.querySelector("[data-duration]")?.textContent).toBe("2m");
    });

    it("steps carry no duration or fix tag", () => {
      render({ nodes: [running()] });
      openRow(0);
      expect(items()[1].querySelector("[data-duration]")).toBeNull();
    });

    it("a steps task nested under a parent task still works", () => {
      render({
        nodes: [node("p", { children: [running({ id: "k" })] })],
      });
      openRow(0);
      openRow(1);
      expect(items()).toHaveLength(7);
      expect(items()[2].textContent).toContain("Step text 1");
    });

    it("renders 50 tasks x 40 steps fully expanded quickly", () => {
      const many = Array.from({ length: 50 }, (_, t) =>
        node(`t${t}`, {
          status: "running",
          startedAt: 0,
          steps: Array.from({ length: 40 }, (_, i) => ({ text: `Step ${i}`, done: i % 2 === 0 })),
        }),
      );
      render({ nodes: many });
      const started = performance.now();
      // One click per task in one batch: React renders the fully open tree once.
      const rows = items().map((el) => el.querySelector<HTMLElement>("[data-row]")!);
      act(() => rows.forEach((row) => row.click()));
      expect(items()).toHaveLength(50 * 41);
      const [first, second] = [items()[1], items()[2]];
      focus(first);
      press(first, "ArrowDown");
      expect(document.activeElement).toBe(second);
      expect(performance.now() - started).toBeLessThan(5_000);
    });
  });
});
