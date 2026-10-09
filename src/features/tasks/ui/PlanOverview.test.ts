// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardNode, BoardSection, BoardStatus } from "../model/taskBoard";
import { PlanOverview } from "./PlanOverview";

let container: HTMLDivElement;
let root: Root;

const MIN = 60_000;
const T0 = 1_000_000_000_000;
const NOW = T0 + 50 * MIN;

function task(n: number, status: BoardStatus, patch: Partial<BoardNode> = {}): BoardNode {
  const started = status === "pending" ? {} : { startedAt: T0 + (n - 1) * 10 * MIN };
  const ended = status === "done" ? { endedAt: T0 + n * 10 * MIN } : {};
  return { id: `task-${n}`, title: `Step ${n} title`, index: n, status, ...started, ...ended, ...patch };
}

/** A plan whose tasks have the given statuses, in order. */
function plan(statuses: BoardStatus[], patch: Partial<BoardSection> = {}, patches: Record<number, Partial<BoardNode>> = {}): BoardSection {
  const nodes = statuses.map((s, i) => task(i + 1, s, patches[i + 1]));
  return {
    source: "sdd",
    id: "sdd:alpha",
    title: "Alpha plan",
    done: nodes.filter((n) => n.status === "done").length,
    total: nodes.length,
    startedAt: T0,
    nodes,
    finalReview: { id: "final-review", title: "Last review of the whole branch", status: "pending" },
    ...patch,
  };
}

function render(section: BoardSection, props: Partial<ComponentProps<typeof PlanOverview>> = {}) {
  const onReveal = props.onReveal ?? vi.fn();
  act(() => root.render(createElement(PlanOverview, { section, now: NOW, onReveal, ...props })));
  return onReveal;
}

const text = () => container.textContent ?? "";
const segments = () => Array.from(container.querySelectorAll("[data-strip] > [data-status]")).map((s) => s.getAttribute("data-status"));
/** What a button says, without its glyph's mark. */
const label = (b: Element) => (b.lastElementChild ?? b).textContent;
const problemButtons = () => Array.from(container.querySelectorAll("[data-problems] button")) as HTMLButtonElement[];
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

describe("PlanOverview counts line", () => {
  it("says tasks done, what is left and steps ticked", () => {
    render(plan(["done", "done", "done", "running", "pending", "pending"], { steps: { done: 14, total: 31 } }));
    expect(container.querySelector("[data-counts]")?.textContent).toBe("3 of 6 tasks · 4 left · 14 of 31 steps");
  });

  it("leaves steps out when no plan file was read", () => {
    render(plan(["done", "running", "pending"]));
    const line = container.querySelector("[data-counts]")?.textContent;
    expect(line).toBe("1 of 3 tasks · 3 left");
    expect(line).not.toContain("step");
  });

  it("drops the left count once everything is done, and says the steps once", () => {
    render(plan(["done", "done", "done", "done", "done", "done"], { steps: { done: 31, total: 31 }, finalReview: { id: "final-review", title: "Last", status: "done" } }));
    expect(container.querySelector("[data-counts]")?.textContent).toBe("6 of 6 tasks · 31 steps");
  });

  it("names the last review when it is all that is left", () => {
    render(plan(["done", "done"], { steps: { done: 4, total: 4 } }));
    expect(container.querySelector("[data-counts]")?.textContent).toBe("2 of 2 tasks · last review left · 4 of 4 steps");
  });

  it("uses the singular where there is one", () => {
    render(plan(["running"], { finalReview: undefined, steps: { done: 0, total: 1 } }));
    expect(container.querySelector("[data-counts]")?.textContent).toBe("0 of 1 task · 1 task left · 0 of 1 step");
    render(plan(["done"], { finalReview: undefined, steps: { done: 1, total: 1 } }));
    expect(container.querySelector("[data-counts]")?.textContent).toBe("1 of 1 task · 1 step");
  });

  it("counts the final review in what is left", () => {
    render(plan(["done", "done", "pending"]));
    expect(container.querySelector("[data-counts]")?.textContent).toBe("2 of 3 tasks · 2 left");
  });

  it("shows zero steps ticked as zero", () => {
    render(plan(["pending", "pending"], { steps: { done: 0, total: 8 } }));
    expect(container.querySelector("[data-counts]")?.textContent).toBe("0 of 2 tasks · 3 left · 0 of 8 steps");
  });
});

describe("PlanOverview time line", () => {
  it("reuses the elapsed and estimate text on its own line", () => {
    render(plan(["done", "done", "done", "running", "pending", "pending"]));
    expect(container.querySelector("[data-time]")?.textContent).toBe("50m so far · about 30m left");
  });

  it("has no time line when the start is unknown", () => {
    render(plan(["pending", "pending"], { startedAt: undefined }));
    expect(container.querySelector("[data-time]")).toBeNull();
  });

  it("says how long a finished plan took", () => {
    render(plan(["done", "done"], { finalReview: { id: "final-review", title: "Last", status: "done" } }));
    expect(container.querySelector("[data-time]")?.textContent).toBe("took 20m");
  });
});

describe("PlanOverview strip", () => {
  it("is one image with the counts spelled in words", () => {
    render(plan(["done", "done", "done", "running", "attention", "blocked", "pending"], {}, { 5: { fixRounds: 1 } }));
    const img = container.querySelector("[data-strip]");
    expect(img?.getAttribute("role")).toBe("img");
    // Seven tasks plus the final review that has not started.
    expect(img?.getAttribute("aria-label")).toBe("3 done, 1 running, 1 needs a look, 1 blocked, 2 not started");
  });

  it("leaves out the kinds that are zero", () => {
    render(plan(["done", "done"], { finalReview: undefined }));
    expect(container.querySelector("[data-strip]")?.getAttribute("aria-label")).toBe("2 done");
  });

  it("names failed tasks", () => {
    render(plan(["failed", "done"], { finalReview: undefined }));
    expect(container.querySelector("[data-strip]")?.getAttribute("aria-label")).toBe("1 done, 1 failed");
  });

  it("has one segment per task in plan order, then the final review", () => {
    render(plan(["done", "running", "attention", "failed", "blocked", "pending"]));
    expect(segments()).toEqual(["done", "running", "attention", "failed", "blocked", "pending", "pending"]);
    expect(container.querySelectorAll("[data-strip] > [data-status]")).toHaveLength(7);
  });

  it("has no final review segment when the plan has none", () => {
    render(plan(["done", "pending"], { finalReview: undefined }));
    expect(segments()).toEqual(["done", "pending"]);
  });

  it("colours segments with status tokens only, and only the colour changes in motion", () => {
    render(plan(["done", "running", "attention", "failed", "blocked", "pending"]));
    const classes = Array.from(container.querySelectorAll("[data-strip] > [data-status]")).map((s) => s.className);
    expect(classes[0]).toContain("bg-success");
    expect(classes[1]).toContain("bg-focus");
    expect(classes[2]).toContain("bg-warning");
    expect(classes[3]).toContain("bg-danger");
    expect(classes[4]).toContain("bg-danger");
    expect(classes[5]).toMatch(/bg-muted\//);
    // The unfilled track is marked, so a contrast check knows it is not a status mark.
    const tracks = Array.from(container.querySelectorAll("[data-strip] > [data-track]")).map((t) => t.getAttribute("data-status"));
    expect(tracks).toEqual(["pending", "pending"]);
    for (const c of classes) {
      expect(c).toContain("transition-colors");
      expect(c).toContain("motion-reduce:transition-none");
      expect(c).not.toContain("transition-all");
      expect(c).not.toMatch(/gradient/);
    }
  });
});

describe("PlanOverview problems", () => {
  const trouble = plan(
    ["done", "attention", "blocked", "failed", "pending"],
    {},
    { 2: { fixRounds: 3 }, 3: {} },
  );

  it("has no problems row when nothing is wrong", () => {
    render(plan(["done", "running", "attention", "pending"], {}, { 3: { fixRounds: 2 } }));
    expect(container.querySelector("[data-problems]")).toBeNull();
    expect(text()).not.toContain("Needs a look");
  });

  it("lists failed, blocked and heavily fixed tasks in plan order", () => {
    render(trouble);
    expect(text()).toContain("Needs a look");
    expect(problemButtons().map(label)).toEqual(["Task 2 · fix 3 of 5", "Task 3 · blocked", "Task 4 · failed"]);
  });

  it("gives each button a glyph that says why", () => {
    render(trouble);
    const names = problemButtons().map((b) => b.querySelector('[role="img"]')?.getAttribute("aria-label"));
    expect(names).toEqual(["struggling", "blocked", "failed"]);
  });

  it("calls onReveal with the task id", () => {
    const onReveal = render(trouble);
    click(problemButtons()[1]);
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(onReveal).toHaveBeenCalledWith("task-3");
  });

  it("shows three and folds the rest into a +N more button that expands in place", () => {
    const many = plan(["blocked", "blocked", "blocked", "failed", "failed"], { finalReview: undefined });
    const onReveal = render(many);
    expect(problemButtons().map(label)).toEqual(["Task 1 · blocked", "Task 2 · blocked", "Task 3 · blocked", "+2 more"]);
    const more = problemButtons()[3];
    expect(more.getAttribute("aria-expanded")).toBe("false");
    click(more);
    expect(problemButtons().map(label)).toEqual([
      "Task 1 · blocked",
      "Task 2 · blocked",
      "Task 3 · blocked",
      "Task 4 · failed",
      "Task 5 · failed",
      "Show fewer",
    ]);
    expect(problemButtons()[5].getAttribute("aria-expanded")).toBe("true");
    expect(onReveal).not.toHaveBeenCalled();
    click(problemButtons()[4]);
    expect(onReveal).toHaveBeenCalledWith("task-5");
    click(problemButtons()[5]);
    expect(problemButtons()).toHaveLength(4);
  });

  it("has no +N more with three or fewer", () => {
    render(plan(["blocked", "blocked", "blocked"], { finalReview: undefined }));
    expect(problemButtons().map(label)).toEqual(["Task 1 · blocked", "Task 2 · blocked", "Task 3 · blocked"]);
  });

  it("makes every button a 24px target with a focus ring and a subtle fill", () => {
    render(plan(["blocked", "blocked", "blocked", "failed"], { finalReview: undefined }));
    for (const b of problemButtons()) {
      expect(b.className).toContain("min-h-6");
      expect(b.className).toContain("bg-selection-subtle");
      expect(b.className).toContain("focus-visible:focus-ring-inset");
      expect(b.getAttribute("type")).toBe("button");
    }
  });
});

describe("PlanOverview layout", () => {
  it("puts counts, time, strip and problems in that order", () => {
    render(plan(["done", "blocked", "pending"]));
    const order = ["[data-counts]", "[data-time]", "[data-strip]", "[data-problems]"].map((s) => container.querySelector(s));
    for (const el of order) expect(el).not.toBeNull();
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("uses no borders, cards or em dashes", () => {
    render(plan(["done", "blocked", "pending"], { steps: { done: 1, total: 4 } }));
    expect(text()).not.toContain("—");
    // The glyphs keep their own rings; the overview's own elements have no borders, shadows or fills of a card.
    const own = Array.from(container.querySelectorAll("*")).filter((el) => !el.closest('[role="img"]:not([data-strip])'));
    for (const el of own) expect(el.className).not.toMatch(/border|shadow|gradient/);
  });
});
