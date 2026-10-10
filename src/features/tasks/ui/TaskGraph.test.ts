// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gapsFor } from "../model/gaps";
import { buildGraph, type Graph, type GraphRow } from "../model/graph";
import { shipReadiness } from "../model/ship";
import type { BoardNode, BoardSection, BoardStage, BoardStatus } from "../model/taskBoard";
import { GraphGutter } from "./GraphGutter";
import { TaskGraph } from "./TaskGraph";

const MIN = 60_000;
const NOW = 100 * MIN;

let container: HTMLDivElement;
let root: Root;

function task(n: number, status: BoardStatus, over: Partial<BoardNode> = {}): BoardNode {
  return { id: `task-${n}`, title: `Task ${n}`, index: n, status, ...over };
}

function plan(nodes: BoardNode[], over: Partial<BoardSection> = {}): BoardSection {
  return {
    source: "sdd",
    id: "sdd:p",
    title: "P",
    done: nodes.filter((n) => n.status === "done").length,
    total: nodes.length,
    nodes,
    ...over,
  };
}

const stage = (kind: BoardStage["kind"], status: BoardStatus, over: Partial<BoardStage> = {}): BoardStage => ({
  kind,
  label: kind,
  status,
  ...over,
});

function graphOf(nodes: BoardNode[], expanded: string[] = []): Graph {
  const section = plan(nodes);
  return buildGraph({
    section,
    gaps: gapsFor(section),
    ship: shipReadiness(section, undefined),
    expanded: new Set(expanded),
    filter: "all",
    now: NOW,
  });
}

/** Task 1 done and clean, task 2 done after one fix round, task 3 running with steps. */
function fixture(): BoardNode[] {
  return [
    task(1, "done", {
      startedAt: 0,
      endedAt: 3 * MIN,
      commits: "1111111aaaa",
      stages: [stage("implement", "done", { sha: "1111111" }), stage("review", "done")],
      target: { kind: "report", ref: "task-1-report.md" },
    }),
    task(2, "done", {
      startedAt: 0,
      endedAt: 8 * MIN,
      fixRounds: 1,
      commits: "2222222..3333333",
      stages: [
        stage("implement", "done", { sha: "2222222" }),
        stage("review", "attention", { verdict: "2 issues" }),
        stage("fix", "done", { label: "fix 1", sha: "3333333" }),
      ],
    }),
    task(3, "running", {
      startedAt: NOW - MIN,
      steps: [
        { text: "Write the failing test", done: true, ticked: true },
        { text: "Draw the rail", done: false, ticked: false },
      ],
      target: { kind: "brief", ref: "task-3-brief.md" },
    }),
  ];
}

type Props = ComponentProps<typeof TaskGraph>;

function render(props: Partial<Props> = {}) {
  const full: Props = {
    graph: graphOf(fixture()),
    label: "Plan tasks",
    onToggle: vi.fn(),
    onOpen: vi.fn(),
    onOpenCommit: vi.fn(),
    onCopySha: vi.fn(),
    ...props,
  };
  act(() => root.render(createElement(TaskGraph, full)));
  return full;
}

const items = () => Array.from(container.querySelectorAll<HTMLElement>("[role=treeitem]"));
const item = (id: string) => container.querySelector<HTMLElement>(`[data-row-id='${id}']`)!;

function focus(el: HTMLElement) {
  act(() => el.focus());
}

function press(el: Element, key: string, init: KeyboardEventInit = {}) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function row(over: Partial<GraphRow> & { id: string }): GraphRow {
  return { kind: "task", lane: 0, cells: ["node"], status: "done", title: over.id, refs: [], shas: [], expandable: false, now: false, ...over };
}

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

describe("TaskGraph", () => {
  it("is a labelled tree with one tab stop and a treeitem per row", () => {
    render();
    const tree = container.querySelector("[role=tree]");
    expect(tree?.getAttribute("aria-label")).toBe("Plan tasks");
    expect(items().map((el) => el.dataset.rowId)).toEqual(["task-1", "task-2", "task-3", "ship"]);
    expect(items().map((el) => el.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it("sets aria-level by kind and aria-expanded only on expandable rows", () => {
    const graph = graphOf(fixture(), ["task-2", "task-3"]);
    render({ graph, expandedIds: new Set(["task-2", "task-3"]) });
    const levels = Object.fromEntries(items().map((el) => [el.dataset.rowId, el.getAttribute("aria-level")]));
    expect(levels["task-1"]).toBe("1");
    expect(levels["task-2:stage:1"]).toBe("2");
    expect(levels["task-2:merge"]).toBe("2");
    expect(levels["task-3:step:0"]).toBe("2");
    expect(levels.ship).toBe("1");
    expect(item("task-1").getAttribute("aria-expanded")).toBe("false");
    expect(item("task-2").getAttribute("aria-expanded")).toBe("true");
    expect(item("task-2:stage:0").hasAttribute("aria-expanded")).toBe(false);
    // A flat tree: each row says where it sits among its siblings.
    expect(item("task-3").getAttribute("aria-posinset")).toBe("3");
    expect(item("task-3").getAttribute("aria-setsize")).toBe("4");
    expect(item("task-2:merge").getAttribute("aria-posinset")).toBe("4");
    expect(item("task-2:merge").getAttribute("aria-setsize")).toBe("4");
    expect(item("task-3:step:1").getAttribute("aria-setsize")).toBe("2");
  });

  it("without expandedIds, a row reads expanded when its children are shown", () => {
    render({ graph: graphOf(fixture(), ["task-3"]) });
    expect(item("task-3").getAttribute("aria-expanded")).toBe("true");
    expect(item("task-2").getAttribute("aria-expanded")).toBe("false");
  });

  it("names each row by title, status, refs and meta", () => {
    render();
    expect(item("task-2").getAttribute("aria-label")).toBe("Task 2, done, fixed in 1 round, 8m");
    expect(item("task-1").getAttribute("aria-label")).toBe("Task 1, done, review clean, 3m");
    expect(item("ship").getAttribute("aria-label")).toBe("Ship, not ready, 3 things before ship");
  });

  it("adds the task number when the title does not carry it", () => {
    const rows = [
      row({ id: "a", index: 4, title: "Graph view", meta: "1m" }),
      row({ id: "b", index: 1, title: "Task 10" }),
    ];
    render({ graph: { rows, width: 1, counts: { all: 2, left: 0, problems: 0 } } });
    expect(item("a").getAttribute("aria-label")).toBe("Task 4, Graph view, done, 1m");
    expect(item("b").getAttribute("aria-label")).toBe("Task 1, Task 10, done");
  });

  it("gives the final review, worker lanes and hidden runs level 1", () => {
    const section = plan(
      [task(1, "done", { commits: "abcdef0" }), task(2, "running", { startedAt: NOW - MIN })],
      { finalReview: { id: "final-review", title: "Final review", status: "pending" } },
    );
    const graph = buildGraph({
      section,
      gaps: gapsFor(section),
      ship: shipReadiness(section, undefined),
      expanded: new Set(),
      filter: "left",
      now: NOW,
      workers: [{ id: "w1", title: "Worker", status: "running", startedAt: NOW - MIN }],
    });
    render({ graph });
    expect(item("final-review").getAttribute("aria-level")).toBe("1");
    expect(item("worker:w1").getAttribute("aria-level")).toBe("1");
    expect(item("hidden:task-1").getAttribute("aria-level")).toBe("1");
  });

  it("labels an unticked step as not ticked", () => {
    render({ graph: graphOf(fixture(), ["task-3"]) });
    expect(item("task-3:step:1").getAttribute("aria-label")).toBe("Draw the rail, not ticked");
    expect(item("task-3:step:0").getAttribute("aria-label")).toBe("Write the failing test, done");
    expect(item("task-3:step:1").querySelector("[role=img]")?.getAttribute("aria-label")).toBe("not ticked");
  });

  it("hides every gutter from assistive tech", () => {
    render({ graph: graphOf(fixture(), ["task-2"]) });
    const gutters = container.querySelectorAll("[data-gutter]");
    expect(gutters.length).toBe(items().length);
    for (const g of gutters) expect(g.getAttribute("aria-hidden")).toBe("true");
  });

  it("arrow keys, Home and End move the roving focus", () => {
    render();
    const [a, b, , ship] = items();
    focus(a!);
    press(a!, "ArrowDown");
    expect(document.activeElement).toBe(b);
    expect(items().map((el) => el.tabIndex)).toEqual([-1, 0, -1, -1]);
    press(b!, "End");
    expect(document.activeElement).toBe(ship);
    press(ship!, "ArrowDown");
    expect(document.activeElement).toBe(ship);
    press(ship!, "Home");
    expect(document.activeElement).toBe(a);
    press(a!, "ArrowUp");
    expect(document.activeElement).toBe(a);
  });

  it("right asks to expand, walks into children, and left returns to the parent or asks to collapse", () => {
    const onToggle = vi.fn();
    render({ onToggle });
    const t2 = item("task-2");
    focus(t2);
    press(t2, "ArrowRight");
    expect(onToggle).toHaveBeenCalledWith("task-2");
    render({ onToggle, graph: graphOf(fixture(), ["task-2"]), expandedIds: new Set(["task-2"]) });
    press(item("task-2"), "ArrowRight");
    expect(document.activeElement).toBe(item("task-2:stage:0"));
    press(item("task-2:stage:0"), "ArrowLeft");
    expect(document.activeElement).toBe(item("task-2"));
    press(item("task-2"), "ArrowLeft");
    expect(onToggle).toHaveBeenLastCalledWith("task-2");
    expect(onToggle).toHaveBeenCalledTimes(2);
    // A leaf at the top does nothing on either arrow.
    press(item("task-1"), "ArrowLeft");
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("collapsing the parent of the focused child moves focus to the parent", () => {
    render({ graph: graphOf(fixture(), ["task-3"]), expandedIds: new Set(["task-3"]) });
    focus(item("task-3:step:1"));
    render({ graph: graphOf(fixture()), expandedIds: new Set() });
    expect(document.activeElement).toBe(item("task-3"));
    expect(item("task-3").tabIndex).toBe(0);
  });

  it("Enter opens a row that stands for a node; a stage does nothing", () => {
    const props = render({ graph: graphOf(fixture(), ["task-2"]) });
    focus(item("task-2"));
    press(item("task-2"), "Enter");
    expect(props.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "task-2" }));
    press(item("task-2:stage:0"), "Enter");
    expect(props.onOpen).toHaveBeenCalledTimes(1);
  });

  it("o opens the row's target only when it has one", () => {
    const props = render();
    press(item("task-2"), "o");
    expect(props.onOpen).not.toHaveBeenCalled();
    press(item("task-3"), "o");
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    expect((props.onOpen as ReturnType<typeof vi.fn>).mock.calls[0]![0].id).toBe("task-3");
  });

  it("c copies the row's last sha when it has any", () => {
    const props = render();
    press(item("task-2"), "c");
    expect(props.onCopySha).toHaveBeenCalledWith("3333333");
    press(item("task-3"), "c");
    expect(props.onCopySha).toHaveBeenCalledTimes(1);
  });

  it("o, c and n leave the event alone when they do nothing", () => {
    const rows = [row({ id: "a" })];
    render({ graph: { rows, width: 1, counts: { all: 1, left: 0, problems: 0 } } });
    const a = item("a");
    for (const key of ["o", "c", "n"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      act(() => {
        a.dispatchEvent(event);
      });
      expect(event.defaultPrevented, key).toBe(false);
    }
  });

  it("n jumps to the now row", () => {
    render();
    focus(item("task-1"));
    press(item("task-1"), "n");
    expect(document.activeElement).toBe(item("task-3"));
    expect(item("task-3").tabIndex).toBe(0);
  });

  it("does not swallow modified keys or keys from inner buttons", () => {
    const props = render();
    const t2 = item("task-2");
    focus(t2);
    const event = new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      t2.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(props.onCopySha).not.toHaveBeenCalled();
    const button = t2.querySelector("button")!;
    press(button, "ArrowDown");
    expect(document.activeElement).toBe(t2);
  });

  it("a sha link opens the commit with the full row and the sha", () => {
    const props = render();
    const link = item("task-2").querySelector<HTMLButtonElement>("[data-sha='2222222']")!;
    expect(link.textContent).toBe("2222222");
    expect(link.getAttribute("aria-label")).toBe("Open commit 2222222");
    click(link);
    expect(props.onOpenCommit).toHaveBeenCalledWith(expect.objectContaining({ id: "task-2", kind: "task" }), "2222222");
    expect(props.onToggle).not.toHaveBeenCalled();
  });

  it("the copy button copies its sha", () => {
    const props = render();
    click(item("task-2").querySelector("[aria-label='Copy 3333333']")!);
    expect(props.onCopySha).toHaveBeenCalledWith("3333333");
    expect(props.onToggle).not.toHaveBeenCalled();
  });

  it("offers Open report or Open brief only for rows with a target", () => {
    const props = render();
    expect(item("task-1").querySelector("[aria-label='Open report']")).not.toBeNull();
    expect(item("task-3").querySelector("[aria-label='Open brief']")).not.toBeNull();
    expect(item("task-2").querySelector("[aria-label^='Open r'], [aria-label^='Open b']")).toBeNull();
    expect(item("ship").querySelectorAll("button")).toHaveLength(0);
    click(item("task-3").querySelector("[aria-label='Open brief']")!);
    expect(props.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "task-3" }));
  });

  it("row actions show on hover or with focus inside them, and are tabbable only on the active row", () => {
    render();
    const actions = item("task-1").querySelector<HTMLElement>("[data-actions]")!;
    expect(actions.className).toContain("opacity-0");
    expect(actions.className).toContain("group-hover/row:opacity-100");
    expect(actions.className).toContain("group-has-[[data-actions]:focus-within]/row:opacity-100");
    // Zero-width rather than display:none, so Tab from the focused row still reaches the buttons.
    expect(actions.className).toContain("max-w-0");
    expect(actions.className.split(" ")).not.toContain("hidden");
    expect(Array.from(actions.querySelectorAll("button")).map((b) => b.tabIndex)).toEqual([0, 0, 0]);
    expect(Array.from(item("task-2").querySelectorAll("button")).every((b) => b.tabIndex === -1)).toBe(true);
  });

  it("actions sit in the row's flow and replace the meta, never the title", () => {
    render();
    const t1 = item("task-1");
    const title = t1.querySelector<HTMLElement>("[title='Task 1']")!;
    const actions = t1.querySelector<HTMLElement>("[data-actions]")!;
    expect(actions.parentElement).toBe(title.parentElement);
    const meta = t1.querySelector<HTMLElement>("[data-meta]")!;
    expect(meta.className).toContain("group-hover/row:hidden");
    expect(meta.className).toContain("group-has-[[data-actions]:focus-within]/row:hidden");
    expect(t1.querySelector("[data-ref]")?.className).toContain("group-hover/row:hidden");
    // A row with nothing to offer keeps its meta on hover.
    expect(item("ship").querySelector("[data-meta]")?.className).not.toContain("group-hover/row:hidden");
  });

  it("focusing a row does not hide its title or anything else", () => {
    render();
    const t1 = item("task-1");
    focus(t1);
    expect(document.activeElement).toBe(t1);
    const title = t1.querySelector<HTMLElement>("[title='Task 1']")!;
    expect(title.textContent).toBe("Task 1");
    // Nothing in the row reacts to the treeitem's own focus; only hover or focus inside the actions.
    for (const el of t1.querySelectorAll<HTMLElement>("*")) {
      expect(el.getAttribute("class") ?? "").not.toMatch(/group-focus(-within|-visible)?:/);
    }
    expect(title.className).toContain("min-w-16");
  });

  it("refs shrink before the title, and a narrow tab drops the second", () => {
    const rows = [
      row({
        id: "a",
        refs: [
          { text: "fix 3 of 5", tone: "warn" },
          { text: "no commit", tone: "warn" },
        ],
      }),
    ];
    render({ graph: { rows, width: 1, counts: { all: 1, left: 1, problems: 1 } } });
    expect(container.querySelector("[role=tree]")?.className).toContain("@container");
    const [first, second] = Array.from(item("a").querySelectorAll<HTMLElement>("[data-ref]"));
    expect(first!.className).toContain("min-w-0");
    expect(first!.className).toContain("truncate");
    expect(first!.className).not.toContain("@max-[300px]:hidden");
    expect(second!.className).toContain("@max-[300px]:hidden");
    expect(item("a").querySelector("[title='a']")?.className).toContain("min-w-16");
  });

  it("draws a review stage hollow and an implement stage solid", () => {
    render({ graph: graphOf(fixture(), ["task-1", "task-2"]) });
    const node = (id: string) => item(id).querySelector("[data-node]")!.getAttribute("class") ?? "";
    // A clean review is hollow too, outlined in the done colour.
    expect(node("task-1:stage:1")).toContain("fill-background-base");
    expect(node("task-1:stage:1")).toContain("stroke-success");
    expect(node("task-2:stage:1")).toContain("fill-background-base");
    expect(node("task-2:stage:1")).toContain("stroke-warning");
    expect(node("task-2:stage:0")).toContain("fill-success");
  });

  it("expanded stage rows always show their sha links", () => {
    render({ graph: graphOf(fixture(), ["task-2"]) });
    const link = item("task-2:stage:2").querySelector<HTMLElement>("[data-sha='3333333']")!;
    expect(link.closest("[data-actions]")).toBeNull();
  });

  it("renders at most two refs and a NOW pill only on the now row", () => {
    const rows = [
      row({
        id: "a",
        refs: [
          { text: "fix 3 of 5", tone: "warn" },
          { text: "no commit", tone: "warn" },
          { text: "2 deferred", tone: "muted" },
        ],
      }),
      row({ id: "b", status: "running", now: true }),
      row({ id: "c" }),
    ];
    render({ graph: { rows, width: 1, counts: { all: 3, left: 1, problems: 1 } } });
    expect(Array.from(item("a").querySelectorAll("[data-ref]")).map((el) => el.textContent)).toEqual(["fix 3 of 5", "no commit"]);
    expect(item("a").querySelector("[data-ref]")?.className).toContain("text-warning");
    const nows = container.querySelectorAll("[data-now-pill]");
    expect(nows).toHaveLength(1);
    expect(nows[0]?.textContent).toBe("NOW");
    expect(nows[0]?.closest("[role=treeitem]")).toBe(item("b"));
  });

  it("clicking an expandable row asks to toggle; a hidden row is a plain muted item", () => {
    const rows = [row({ id: "a", expandable: true }), row({ id: "hidden:x", kind: "hidden", cells: ["dashed"], title: "3 done hidden" })];
    const props = render({ graph: { rows, width: 1, counts: { all: 4, left: 0, problems: 0 } } });
    click(item("a").querySelector("[data-row]")!);
    expect(props.onToggle).toHaveBeenCalledWith("a");
    const hidden = item("hidden:x");
    expect(hidden.getAttribute("aria-label")).toBe("3 done hidden");
    expect(hidden.querySelector("[data-row]")?.className).toContain("text-muted");
    click(hidden.querySelector("[data-row]")!);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  describe("reveal", () => {
    const scrollIntoView = vi.fn();

    beforeEach(() => {
      scrollIntoView.mockReset();
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, writable: true, value: scrollIntoView });
      vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q }));
    });
    afterEach(() => {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    });

    it("scrolls the row into view and focuses it on a new token only", () => {
      render({ reveal: { id: "task-2", token: 1 } });
      expect(scrollIntoView).not.toHaveBeenCalled();
      render({ reveal: { id: "task-2", token: 2 } });
      expect(document.activeElement).toBe(item("task-2"));
      expect(item("task-2").tabIndex).toBe(0);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
      expect(scrollIntoView.mock.contexts[0]).toBe(item("task-2").querySelector("[data-row]"));
    });

    it("asks the parent to open a collapsed task, then focuses its child once shown", () => {
      const onToggle = vi.fn();
      render({ onToggle, reveal: { id: "task-3:step:1", token: 1 } });
      render({ onToggle, reveal: { id: "task-3:step:1", token: 2 } });
      expect(onToggle).toHaveBeenCalledWith("task-3");
      render({ onToggle, graph: graphOf(fixture(), ["task-3"]), reveal: { id: "task-3:step:1", token: 2 } });
      expect(document.activeElement).toBe(item("task-3:step:1"));
    });

    it("jumps without animation under reduced motion", () => {
      vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q }));
      render({ reveal: { id: "task-1", token: 1 } });
      render({ reveal: { id: "task-1", token: 2 } });
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "auto" });
    });

    it("ignores an unknown id", () => {
      const onToggle = vi.fn();
      render({ onToggle, reveal: { id: "nope", token: 1 } });
      render({ onToggle, reveal: { id: "nope", token: 2 } });
      expect(onToggle).not.toHaveBeenCalled();
      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });

  it("renders 200 tasks under budget", () => {
    const nodes = Array.from({ length: 200 }, (_, i) =>
      task(i + 1, i < 120 ? "done" : i === 120 ? "running" : "pending", {
        startedAt: 0,
        endedAt: i < 120 ? MIN : undefined,
        commits: i < 120 ? "abcdef0" : undefined,
        steps: [{ text: "one", done: i < 120, ticked: i < 120 }],
      }),
    );
    const graph = graphOf(nodes, nodes.map((n) => n.id));
    const started = performance.now();
    render({ graph });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(items()).toHaveLength(graph.rows.length);
  });
});

describe("GraphGutter", () => {
  function gutter(props: Partial<ComponentProps<typeof GraphGutter>> = {}) {
    act(() =>
      root.render(createElement(GraphGutter, { cells: ["node"], status: "done", kind: "task", now: false, ...props })),
    );
    return container.querySelector("svg")!;
  }

  it("is 12 px per lane and hidden from assistive tech", () => {
    const svg = gutter({ cells: ["line", "fork", "none"] });
    expect(svg.getAttribute("width")).toBe("36");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.closest(".text-muted")).not.toBeNull();
  });

  it("fills a done node with the success token and pulses only the now node", () => {
    gutter();
    expect(container.querySelector("[data-node]")?.getAttribute("class")).toContain("fill-success");
    expect(container.querySelector(".motion-safe\\:animate-pulse")).toBeNull();
    gutter({ status: "running", now: true });
    expect(container.querySelector(".motion-safe\\:animate-pulse")).not.toBeNull();
  });

  it("draws Ship as a diamond and a pending node as a ring", () => {
    gutter({ kind: "ship", status: "pending" });
    expect(container.querySelector("[data-node]")?.tagName.toLowerCase()).toBe("polygon");
    gutter({ status: "pending" });
    const ring = container.querySelector("[data-node]")!;
    expect(ring.getAttribute("class")).toContain("fill-background-base");
    expect(ring.getAttribute("stroke")).toBe("currentColor");
  });

  it("draws half lines only toward neighbouring lanes", () => {
    gutter({ above: undefined, below: ["line"] });
    expect(container.querySelectorAll("[data-line='below']")).toHaveLength(1);
    expect(container.querySelectorAll("[data-line='above']")).toHaveLength(0);
    gutter({ cells: ["line", "node"], above: ["line", "fork"], below: ["line", "none"] });
    expect(container.querySelectorAll("[data-line='above']")).toHaveLength(1);
    expect(container.querySelectorAll("[data-line='below']")).toHaveLength(0);
    gutter({ cells: ["node", "merge"], above: ["line", "node"], below: ["node", "none"] });
    expect(container.querySelectorAll("[data-curve]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-node]")).toHaveLength(1);
  });

  it("draws a hollow node in the status colour", () => {
    gutter({ kind: "stage", status: "done", hollow: true });
    const node = container.querySelector("[data-node]")!;
    expect(node.tagName.toLowerCase()).toBe("circle");
    expect(node.getAttribute("class")).toContain("fill-background-base");
    expect(node.getAttribute("class")).toContain("stroke-success");
    gutter({ kind: "stage", status: "pending", hollow: true });
    expect(container.querySelector("[data-node]")?.getAttribute("stroke")).toBe("currentColor");
  });

  it("fills a non-review attention node with the warning token and keeps review stages hollow", () => {
    gutter({ kind: "task", status: "attention" });
    const task = container.querySelector("[data-node]")!;
    expect(task.getAttribute("class")).toContain("fill-warning");
    expect(task.getAttribute("class")).not.toContain("fill-background-base");
    gutter({ kind: "ship", status: "attention" });
    expect(container.querySelector("[data-node]")?.getAttribute("class")).toContain("fill-warning");
    gutter({ kind: "stage", status: "attention", hollow: true });
    const review = container.querySelector("[data-node]")!;
    expect(review.getAttribute("class")).toContain("fill-background-base");
    expect(review.getAttribute("class")).toContain("stroke-warning");
  });

  it("draws a dashed rail for hidden rows", () => {
    gutter({ cells: ["dashed"], kind: "hidden" });
    expect(container.querySelector("[stroke-dasharray]")).not.toBeNull();
    expect(container.querySelector("[data-node]")).toBeNull();
  });
});
