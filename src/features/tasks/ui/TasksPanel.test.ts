// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoard } from "../hooks/useTaskBoard";
import type { FlowPhase } from "../model/flow";
import { shipReadiness } from "../model/ship";
import { planSummaryMarkdown } from "../model/summary";
import type { StatusCard } from "../model/statusCard";
import type { BoardNode, BoardSection } from "../model/taskBoard";
import { TasksPanel } from "./TasksPanel";

// Records what the panel asks the graph to reveal, then renders the real graph.
const seen = vi.hoisted(() => ({ reveals: [] as unknown[] }));
vi.mock("./TaskGraph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./TaskGraph")>();
  return {
    ...actual,
    TaskGraph: (props: Parameters<typeof actual.TaskGraph>[0]) => {
      seen.reveals.push(props.reveal);
      return actual.TaskGraph(props);
    },
  };
});

let container: HTMLDivElement;
let root: Root;

const MIN = 60_000;
const T0 = 1_000_000_000_000;

const runningCard: StatusCard = {
  kind: "running",
  sessionId: "s1",
  headline: "A reviewer is checking Task 6",
  detail: "Desktop remote wiring · 2m 14s so far",
  reassurance: "Nothing needs you",
  actions: ["stop-after-task", "open-session"],
};
const idleCard: StatusCard = { kind: "idle", headline: "", actions: [] };

function task(n: number, patch: Partial<BoardNode> = {}): BoardNode {
  return {
    id: `task-${n}`,
    title: `Step ${n} title`,
    index: n,
    status: "done",
    startedAt: T0 + (n - 1) * 10 * MIN,
    endedAt: T0 + n * 10 * MIN,
    ...patch,
  };
}

function plan(patch: Partial<BoardSection> = {}): BoardSection {
  const nodes = [task(1), task(2), task(3), task(4, { status: "running", endedAt: undefined }), task(5, { status: "pending", startedAt: undefined, endedAt: undefined })];
  return {
    source: "sdd",
    id: "sdd:alpha",
    title: "Alpha plan",
    done: 3,
    total: 5,
    startedAt: T0,
    nodes,
    finalReview: { id: "final-review", title: "Last review of the whole branch", status: "pending" },
    ...patch,
  };
}

function board(over: Partial<TaskBoard> = {}): TaskBoard {
  const p = over.plan;
  return {
    sections: p ? [p] : [],
    statusCard: runningCard,
    flow: [],
    gaps: [],
    workspaces: [],
    selectWorkspace: () => {},
    loading: false,
    loaded: true,
    ...over,
  };
}

function render(props: Partial<ComponentProps<typeof TasksPanel>> = {}) {
  act(() => root.render(createElement(TasksPanel, { board: board(), now: T0 + 50 * MIN, ...props })));
}

const text = () => container.textContent ?? "";
const button = (name: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === name || b.getAttribute("aria-label") === name);
const click = (el: Element | undefined) => {
  expect(el).toBeDefined();
  act(() => el?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};

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

describe("TasksPanel", () => {
  it("shows the running headline and Nothing needs you", () => {
    render();
    const status = container.querySelectorAll("[role=status]");
    expect(status).toHaveLength(1);
    expect(status[0].textContent).toBe("A reviewer is checking Task 6");
    expect(text()).toContain("Desktop remote wiring · 2m 14s so far");
    expect(text()).toContain("Nothing needs you");
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(button("Stop after this task")).toBeDefined();
    expect(button("Open session")).toBeDefined();
  });

  it("needs-you card is an alert and its action fires onAction(\"answer-in-session\")", () => {
    const card: StatusCard = {
      kind: "needs-you",
      sessionId: "s2",
      sessionTitle: "ssh-hardening",
      headline: "ssh-hardening is waiting for your answer",
      detail: "Task 3 asks: “Keep password login as a fallback?” · 3m ago",
      actions: ["answer-in-session", "remind-later"],
    };
    const onAction = vi.fn();
    render({ board: board({ statusCard: card }), onAction });
    // Only the headline is live: the detail carries a ticking "3m ago" and the actions are controls.
    const alerts = container.querySelectorAll("[role=alert]");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toBe("ssh-hardening is waiting for your answer");
    expect(container.querySelector("[role=status]")).toBeNull();
    expect(text()).toContain("3m ago");
    expect(container.querySelector("[data-status-kind]")?.getAttribute("role")).toBeNull();
    click(button("Answer in ssh-hardening"));
    expect(onAction).toHaveBeenCalledWith("answer-in-session", card);
    click(button("Remind me in 10m"));
    expect(onAction).toHaveBeenLastCalledWith("remind-later", card);
  });

  it("the answer button falls back to a generic label without a session title", () => {
    const card: StatusCard = { kind: "needs-you", sessionId: "s2", headline: "Waiting", actions: ["answer-in-session"] };
    render({ board: board({ statusCard: card }) });
    expect(button("Answer in session")).toBeDefined();
  });

  it("quiet card: minutes and the last activity time sit outside the live headline", () => {
    const since = new Date(2026, 9, 9, 15, 2).getTime();
    const card: StatusCard = {
      kind: "quiet",
      sessionId: "s1",
      headline: "No activity on Task 6",
      detail: "Quiet for 6m.",
      actions: ["open-session", "keep-waiting"],
      since,
    };
    render({ board: board({ statusCard: card }) });
    expect(text()).toContain("Quiet for 6m. Last activity at 15:02.");
    const live = container.querySelector('[role="status"]');
    expect(live?.textContent).toBe("No activity on Task 6");
    expect(text()).not.toContain("reviewer last wrote");
  });

  it("the headline remounts when the card's kind changes, so a new state is announced", () => {
    render({ board: board({ statusCard: runningCard }) });
    const first = container.querySelector('[role="status"]');
    render({ board: board({ statusCard: { ...runningCard, kind: "quiet", headline: "No activity on Task 6", actions: [] } }) });
    expect(container.querySelector('[role="status"]')).not.toBe(first);
  });

  it("a long session title in Answer in wraps instead of overflowing", () => {
    const title = "a-very-long-session-title-that-goes-on-and-on-and-on-and-on";
    const card: StatusCard = { kind: "needs-you", sessionId: "s2", sessionTitle: title, headline: "x", actions: ["answer-in-session"] };
    render({ board: board({ statusCard: card }) });
    const answer = button(`Answer in ${title}`);
    expect(answer?.className).not.toContain("whitespace-nowrap");
    expect(answer?.className).toContain("break-words");
  });

  it("hides Review decisions when the plan has no decisions", () => {
    const done: StatusCard = { kind: "done", headline: "Plan finished in 50m", actions: ["review-decisions"] };
    render({ board: board({ statusCard: done, plan: plan({ done: 5, decisions: [] }) }) });
    expect(button("Review decisions")).toBeUndefined();
    render({ board: board({ statusCard: done, plan: plan({ done: 5, decisions: [{ taskIndex: 1, text: "Use X" }] }) }) });
    expect(button("Review decisions")).toBeDefined();
  });

  it("renders the others line when the card has one and nothing when it does not", () => {
    const withOthers: StatusCard = { ...runningCard, others: { count: 2, kind: "quiet", text: "2 other runs · docs quiet 6m" } };
    render({ board: board({ statusCard: withOthers }) });
    expect(text()).toContain("2 other runs · docs quiet 6m");
    render({ board: board({ statusCard: runningCard }) });
    expect(text()).not.toContain("other run");
  });

  it("ETA appears only after three tasks are done", () => {
    const time = () => container.querySelector("[data-time]")?.textContent;
    render({ board: board({ plan: plan({ done: 2 }) }) });
    expect(time()).toBe("50m so far");
    render({ board: board({ plan: plan({ done: 3 }) }) });
    // Three tasks took 10m each and two remain.
    expect(time()).toBe("50m so far · about 20m left");
    render({ board: board({ plan: plan({ done: 5 }) }) });
    expect(time()).toBe("took 30m");
  });

  it("replaces the progress line with the overview: counts, strip and no old wording", () => {
    render({ board: board({ plan: plan() }) });
    expect(container.querySelector("[data-counts]")?.textContent).toBe("3 of 5 tasks · 3 left");
    expect(container.querySelector("[data-strip]")?.getAttribute("aria-label")).toBe("3 done, 1 running, 2 not started");
    expect(text()).not.toContain("done ·");
    expect(text()).not.toMatch(/\d of \d done/);
  });

  it("shows the step totals when the plan file was read", () => {
    render({ board: board({ plan: plan({ steps: { done: 7, total: 19 } }) }) });
    expect(container.querySelector("[data-counts]")?.textContent).toBe("3 of 5 tasks · 3 left · 7 of 19 steps");
  });

  it("draws the plan as one graph: tasks, the final review even while pending, then Ship", () => {
    render({ board: board({ plan: plan() }) });
    expect(text()).toContain("Alpha plan");
    const tree = container.querySelector("[role=tree]");
    expect(tree?.getAttribute("aria-label")).toBe("Plan tasks");
    const rows = Array.from(container.querySelectorAll("[role=tree] > [role=treeitem]")).map((r) => r.getAttribute("data-row-id"));
    expect(rows).toEqual(["task-1", "task-2", "task-3", "task-4", "task-5", "final-review", "ship"]);
    expect(text()).not.toContain("Then one last review");
  });

  it("has no Open as tab button", () => {
    render({ board: board({ plan: plan() }) });
    expect(button("Open as tab")).toBeUndefined();
    expect(text()).not.toContain("Open as tab");
  });

  it("lists other agents and other sections", () => {
    const agents: BoardSection = {
      source: "agents",
      id: "agents",
      title: "Subagents",
      done: 1,
      total: 1,
      nodes: [{ id: "a1", title: "Explore sidebar tabs", status: "done", startedAt: T0, endedAt: T0 + 3 * MIN }],
    };
    const todos: BoardSection = { source: "todos", id: "todos", title: "To-do list", done: 0, total: 1, nodes: [{ id: "t1", title: "Write docs", status: "pending" }] };
    render({ board: board({ sections: [agents, todos] }) });
    expect(text()).toContain("Other agents here");
    expect(text()).toContain("Explore sidebar tabs");
    expect(text()).toContain("To-do list");
    expect(text()).toContain("Write docs");
    expect(text()).not.toContain("Nothing to track yet");
  });

  it("empty state copy", () => {
    render({ board: board({ statusCard: idleCard }) });
    expect(container.querySelector("h3")?.textContent).toBe("Nothing to track yet");
    expect(text()).toContain("When the agent works through a plan or hands work to other agents, each task shows up here with its status and time.");
    expect(text()).toContain("Plans run with superpowers");
    expect(text()).toContain("Todo lists the agent writes");
    expect(text()).toContain("Subagents and orchestration workers");
    expect(container.querySelector("[role=status]")).toBeNull();
  });

});

describe("TasksPanel remote project", () => {
  it("says in one line that plan files are not available, and still shows other sections", () => {
    const todos: BoardSection = { source: "todos", id: "todos", title: "To-do list", done: 0, total: 1, nodes: [task(1, { status: "pending" })] };
    render({ board: board({ sections: [todos], statusCard: idleCard, planFilesUnavailable: true }) });
    expect(text()).toContain("Plan files are not available for remote projects yet");
    expect(text()).toContain("To-do list");
  });
});

describe("TasksPanel running task", () => {
  const stages = (n: number): Partial<BoardNode> => ({
    status: "running",
    endedAt: undefined,
    stages: [
      { kind: "implement", label: "Implement", status: "done", startedAt: T0 + (n - 1) * 10 * MIN, endedAt: T0 + (n - 1) * 10 * MIN + 5 * MIN },
      { kind: "review", label: "Review in progress", status: "running", startedAt: T0 + 48 * MIN },
    ],
  });
  const withRunning = (n: number) => {
    const p = plan();
    return { ...p, nodes: p.nodes.map((node) => (node.index === n ? { ...node, ...stages(n) } : { ...node, status: node.index! < n ? ("done" as const) : ("pending" as const) })) };
  };

  it("is expanded and shows its stages, follows the running task, and a user toggle wins", () => {
    render({ board: board({ plan: withRunning(4) }) });
    expect(text()).toContain("Review in progress");
    const task4 = container.querySelector('[role="treeitem"][aria-expanded="true"]');
    expect(task4?.textContent).toContain("Step 4 title");

    // The user collapses it: it stays collapsed across updates.
    click(task4?.querySelector("[data-row]") ?? undefined);
    expect(text()).not.toContain("Review in progress");
    render({ board: board({ plan: withRunning(4) }) });
    expect(text()).not.toContain("Review in progress");

    // The next task starts running: it opens by itself.
    render({ board: board({ plan: withRunning(5) }) });
    const open = container.querySelectorAll('[role="treeitem"][aria-expanded="true"]');
    expect(open).toHaveLength(1);
    expect(open[0].textContent).toContain("Step 5 title");
  });
});

const FLOW: FlowPhase[] = [
  { id: "spec", label: "Spec", status: "done", path: "docs/specs/alpha.md" },
  { id: "plan", label: "Plan", status: "done", detail: "5 tasks", path: "docs/plans/alpha.md" },
  { id: "build", label: "Build", status: "running", detail: "3 of 5" },
  { id: "check", label: "Check", status: "pending" },
];

describe("TasksPanel flow strip", () => {
  const strip = () => container.querySelector("ol[aria-label='Superpowers flow']");

  it("sits under the header, above the counts and the graph", () => {
    render({ board: board({ plan: plan(), flow: FLOW }) });
    const list = strip();
    expect(list).not.toBeNull();
    const header = container.querySelector("[role=radiogroup]");
    const counts = container.querySelector("[data-counts]");
    const tree = container.querySelector("[role=tree]");
    const before = (a: Element | null | undefined, b: Element | null) =>
      Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(header, list)).toBe(true);
    expect(before(list, counts)).toBe(true);
    expect(before(counts, tree)).toBe(true);
  });

  it("shows the Ship phase with its own words", () => {
    render({ board: board({ plan: plan(), flow: [...FLOW, { id: "ship", label: "Ship", status: "attention", detail: "3 left" }] }) });
    const ship = Array.from(strip()?.querySelectorAll("li") ?? []).at(-1);
    expect(ship?.textContent).toContain("Ship");
    expect(ship?.textContent).toContain("3 left");
    expect(ship?.querySelector("[role=img]")?.getAttribute("aria-label")).toBe("not ready");
  });

  it("is absent without phases", () => {
    render({ board: board({ plan: plan(), flow: [] }) });
    expect(strip()).toBeNull();
  });

  it("opens the spec and the plan through onOpenFile with the path as written", () => {
    const onOpenFile = vi.fn();
    render({ board: board({ plan: plan(), flow: FLOW }), onOpenFile });
    click(button("Spec"));
    click(button("Plan"));
    expect(onOpenFile.mock.calls).toEqual([["docs/specs/alpha.md"], ["docs/plans/alpha.md"]]);
  });

  it("shows no file buttons when the host cannot open files", () => {
    render({ board: board({ plan: plan(), flow: FLOW }) });
    expect(strip()?.querySelectorAll("button")).toHaveLength(0);
  });

  it("follows a status change", () => {
    render({ board: board({ plan: plan(), flow: FLOW }) });
    expect(strip()?.textContent).toContain("3 of 5");
    render({
      board: board({
        plan: plan(),
        flow: FLOW.map((p) => (p.id === "build" ? { ...p, status: "done" as const, detail: "5 of 5" } : p)),
      }),
    });
    const build = Array.from(strip()?.querySelectorAll("li") ?? []).find((li) => li.textContent?.includes("Build"));
    expect(build?.querySelector("[role=img]")?.getAttribute("aria-label")).toBe("done");
    expect(build?.textContent).toContain("5 of 5");
    expect(strip()?.querySelector("[aria-current=step]")?.textContent).toContain("Check");
  });
});

describe("TasksPanel problems", () => {
  const stuck = () =>
    plan({
      nodes: [
        task(1),
        task(2, { status: "blocked", endedAt: undefined, summary: "Waiting for the API key.", steps: [{ text: "Ask for the key", done: false, ticked: false }] }),
        task(3, { status: "attention", fixRounds: 4, endedAt: undefined, summary: "The reviewer has sent it back 4 times." }),
        task(4, { status: "pending", startedAt: undefined, endedAt: undefined }),
      ],
      done: 1,
      total: 4,
    });
  const pills = () => Array.from(container.querySelectorAll("[data-problems] button"));

  it("lists the tasks in trouble under the strip", () => {
    render({ board: board({ plan: stuck() }) });
    expect(pills().map((b) => (b.lastElementChild ?? b).textContent)).toEqual(["Task 2 · blocked", "Task 3 · fix 4 of 5"]);
    const strip = container.querySelector("[data-strip]")!;
    expect(strip.compareDocumentPosition(container.querySelector("[data-problems]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens that task and asks the tree to reveal it, again on every press", () => {
    seen.reveals.length = 0;
    render({ board: board({ plan: stuck() }) });
    expect(seen.reveals.every((r) => r === undefined)).toBe(true);
    const tree = () => Array.from(container.querySelectorAll("[role=treeitem]"));
    const blocked = () => tree().find((t) => t.textContent?.includes("Step 2 title"));
    expect(blocked()?.getAttribute("aria-expanded")).toBe("false");
    click(pills()[0]);
    expect(blocked()?.getAttribute("aria-expanded")).toBe("true");
    expect(seen.reveals.at(-1)).toEqual({ id: "task-2", token: 1 });
    click(pills()[1]);
    expect(seen.reveals.at(-1)).toEqual({ id: "task-3", token: 2 });
    click(pills()[1]);
    expect(seen.reveals.at(-1)).toEqual({ id: "task-3", token: 3 });
  });

  it("has no problems row for a healthy plan", () => {
    render({ board: board({ plan: plan() }) });
    expect(container.querySelector("[data-problems]")).toBeNull();
  });
});

describe("TasksPanel header", () => {
  it("the legend lists the symbols and the row keys", () => {
    render({ board: board({ plan: plan() }) });
    const legend = button("What the symbols mean");
    expect(legend?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[aria-label='Symbol legend']")).toBeNull();
    click(legend);
    expect(legend?.getAttribute("aria-expanded")).toBe("true");
    const list = container.querySelector("[aria-label='Symbol legend']");
    // Safari drops list semantics from a list with list-style none unless the role is explicit.
    expect(list?.getAttribute("role")).toBe("list");
    for (const label of ["Done", "Not started", "Running", "Needs you", "Struggling", "Quiet", "Failed", "Review found issues"]) {
      expect(list?.textContent).toContain(label);
    }
    expect(list?.textContent).toContain("o opens, c copies the commit, n jumps to now");
    click(legend);
    expect(container.querySelector("[aria-label='Symbol legend']")).toBeNull();
  });

  it("is a container, so the strip and counts can share a row from 340 px", () => {
    render({ board: board({ plan: plan() }) });
    expect((container.firstElementChild as HTMLElement).className).toContain("@container");
  });

  it("the scroller keeps revealed rows and headings clear of the sticky bar", () => {
    render({ board: board({ plan: plan() }) });
    const scroller = container.firstElementChild as HTMLElement;
    expect(scroller.className).toContain("overflow-auto");
    expect(scroller.className).toContain("scroll-pt-8");
  });

  it("a new plan starts with its own toggles, groups and menu", () => {
    const two = { workspaces: [{ slug: "alpha" }, { slug: "beta" }] as TaskBoard["workspaces"] };
    render({ board: board({ ...two, plan: plan(), selectedWorkspace: "alpha" }) });
    click(container.querySelector("button[aria-haspopup=menu]") ?? undefined);
    expect(container.querySelector("[role=menu]")).not.toBeNull();
    render({ board: board({ ...two, plan: plan({ id: "sdd:beta", title: "Beta plan" }), selectedWorkspace: "beta" }) });
    expect(container.querySelector("[role=menu]")).toBeNull();
  });
});

describe("TasksPanel filter", () => {
  const radio = (name: string) =>
    Array.from(container.querySelectorAll("[role=radio]")).find((r) => r.textContent?.startsWith(name));
  const rowIds = () => Array.from(container.querySelectorAll("[role=treeitem]")).map((r) => r.getAttribute("data-row-id"));

  it("offers All, Left and Problems with their counts", () => {
    const withGap = board({ plan: plan(), gaps: [{ kind: "no-commit", nodeId: "task-2", label: "Task 2", text: "no commit recorded" }] });
    render({ board: withGap });
    expect(Array.from(container.querySelectorAll("[role=radio]")).map((r) => r.textContent)).toEqual(["All 6", "Left 3", "Problems 1"]);
    expect(radio("All")?.getAttribute("aria-checked")).toBe("true");
  });

  it("Left folds the finished tasks into one hidden row and keeps the rest", () => {
    render({ board: board({ plan: plan() }) });
    click(radio("Left"));
    expect(radio("Left")?.getAttribute("aria-checked")).toBe("true");
    expect(rowIds()).toEqual(["hidden:task-1", "task-4", "task-5", "final-review", "ship"]);
    expect(text()).toContain("3 done hidden");
    click(radio("All"));
    expect(rowIds()).toContain("task-1");
  });

  it("a hidden row brings every row back and focuses the first row it hid", () => {
    render({ board: board({ plan: plan() }) });
    click(radio("Left"));
    const hidden = () => container.querySelector<HTMLElement>("[data-row-id='hidden:task-1']");
    act(() => hidden()!.focus());
    act(() => {
      hidden()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(radio("All")?.getAttribute("aria-checked")).toBe("true");
    expect(rowIds()).toContain("task-1");
    expect(document.activeElement?.getAttribute("data-row-id")).toBe("task-1");
    // A click does the same, and the first done task does not open by itself.
    click(radio("Left"));
    click(hidden()?.querySelector("[data-row]") ?? undefined);
    expect(radio("All")?.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement?.getAttribute("data-row-id")).toBe("task-1");
    expect(rowIds().filter((id) => id?.startsWith("task-1:"))).toEqual([]);
  });

  it("is kept per plan for the session", () => {
    const alpha = { workspaces: [{ slug: "alpha" }, { slug: "beta" }] as TaskBoard["workspaces"], plan: plan() };
    render({ board: board({ ...alpha, selectedWorkspace: "alpha" }) });
    click(radio("Left"));
    render({ board: board({ ...alpha, selectedWorkspace: "beta" }) });
    expect(radio("All")?.getAttribute("aria-checked")).toBe("true");
    render({ board: board({ ...alpha, selectedWorkspace: "alpha" }) });
    expect(radio("Left")?.getAttribute("aria-checked")).toBe("true");
  });

  it("revealing a row the filter hides switches back to All first", () => {
    seen.reveals.length = 0;
    const p = plan({
      nodes: [task(1, { status: "pending", startedAt: undefined, endedAt: undefined }), task(2), task(3, { status: "blocked", endedAt: undefined })],
      done: 1,
      total: 3,
    });
    const ship = shipReadiness(p, undefined);
    render({ board: board({ plan: p, ship }) });
    click(radio("Problems"));
    expect(rowIds()).toContain("task-3");
    expect(rowIds()).not.toContain("task-1");
    click(container.querySelector("[data-ship] button[aria-expanded]") ?? undefined);
    click(button("2 tasks left"));
    expect(radio("All")?.getAttribute("aria-checked")).toBe("true");
    expect(rowIds()).toContain("task-1");
    expect(seen.reveals.at(-1)).toEqual({ id: "task-1", token: 1 });
  });
});

describe("TasksPanel sticky bar", () => {
  type Callback = (entries: { isIntersecting: boolean; target: Element }[]) => void;
  let observers: { callback: Callback; targets: Element[]; disconnected: boolean }[];

  beforeEach(() => {
    observers = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        entry: (typeof observers)[number];
        constructor(callback: Callback) {
          this.entry = { callback, targets: [], disconnected: false };
          observers.push(this.entry);
        }
        observe(target: Element) {
          this.entry.targets.push(target);
        }
        unobserve() {}
        disconnect() {
          this.entry.disconnected = true;
        }
      },
    );
  });

  const bar = () => container.querySelector("[data-sticky-bar]");
  const scrollAway = (away: boolean) => {
    const live = observers.filter((o) => !o.disconnected);
    expect(live.length).toBeGreaterThan(0);
    act(() => live.forEach((o) => o.callback(o.targets.map((target) => ({ isIntersecting: !away, target })))));
  };

  it("shows only once the header's sentinel leaves view", () => {
    render({ board: board({ plan: plan() }) });
    expect(bar()).toBeNull();
    scrollAway(true);
    expect(bar()).not.toBeNull();
    expect(bar()?.className).toContain("sticky");
    expect(bar()?.className).toContain("top-0");
    expect(bar()?.className).toContain("h-7");
    scrollAway(false);
    expect(bar()).toBeNull();
  });

  it("names the current task, its steps and what is left, and Jump to now focuses its row", () => {
    const steps = [
      { text: "a", done: true, ticked: true },
      { text: "b", done: true, ticked: true },
      { text: "c", done: false, ticked: false },
      { text: "d", done: false, ticked: false },
      { text: "e", done: false, ticked: false },
    ];
    const p = plan();
    const withSteps = { ...p, nodes: p.nodes.map((n) => (n.index === 4 ? { ...n, steps } : n)) };
    render({ board: board({ plan: withSteps }) });
    scrollAway(true);
    // Only the steps: a ticking duration would re-announce and crowd the bar.
    expect(bar()?.querySelector("[data-bar-text]")?.textContent).toBe("Task 4 · 2/5 · 3 left");
    expect(bar()?.querySelector("[role=img]")).not.toBeNull();
    click(Array.from(bar()?.querySelectorAll("button") ?? []).find((b) => b.textContent === "Jump to now"));
    expect(document.activeElement?.getAttribute("data-row-id")).toBe("task-4");
  });

  it("leaves the steps out for a task without any, and reads the plan even when the filter hides the now row", () => {
    render({ board: board({ plan: plan() }) });
    scrollAway(true);
    expect(bar()?.querySelector("[data-bar-text]")?.textContent).toBe("Task 4 · 3 left");
    const p = plan();
    const steps = [{ text: "a", done: true, ticked: true }, { text: "b", done: false, ticked: false }];
    const withSteps = { ...p, nodes: p.nodes.map((n) => (n.index === 4 ? { ...n, steps } : n)) };
    render({ board: board({ plan: withSteps }) });
    click(Array.from(container.querySelectorAll("[role=radio]")).find((r) => r.textContent?.startsWith("Problems")));
    expect(container.querySelector('[data-row-id="task-4"]')).toBeNull();
    expect(bar()?.querySelector("[data-bar-text]")?.textContent).toBe("Task 4 · 1/2 · 3 left");
  });

  it("never shows where IntersectionObserver is missing", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render({ board: board({ plan: plan() }) });
    expect(bar()).toBeNull();
  });
});

describe("TasksPanel ship node", () => {
  const allDone = () =>
    plan({
      nodes: [1, 2, 3].map((n) => task(n, { commits: `${n}${n}${n}${n}${n}${n}${n}` })),
      done: 3,
      total: 3,
      steps: { done: 9, total: 9 },
      finalReview: { id: "final-review", title: "Last review of the whole branch", status: "done" },
    });
  const shipBlock = () => container.querySelector("[data-ship]");
  const shipToggle = () => shipBlock()?.querySelector("button[aria-expanded]");

  it("sits right under the graph, collapsed while work is left", () => {
    const p = plan();
    render({ board: board({ plan: p, ship: shipReadiness(p, undefined) }) });
    const tree = container.querySelector("[role=tree]")!;
    expect(tree.compareDocumentPosition(shipBlock()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The graph row says the verdict; the checklist says how far along it is.
    expect(shipToggle()?.textContent).toBe("Ship checklist · 0 of 4 met");
    expect(container.querySelector("[data-row-id=ship]")?.textContent).toContain("4 things before ship");
    expect(shipToggle()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("the graph's Ship row is the verdict, not a second disclosure: it opens the checklist and moves focus to its toggle", () => {
    const p = plan();
    render({ board: board({ plan: p, ship: shipReadiness(p, undefined) }) });
    const shipRow = () => container.querySelector<HTMLElement>("[data-row-id=ship]")!;
    expect(shipRow().hasAttribute("aria-expanded")).toBe(false);
    act(() => shipRow().focus());
    act(() => {
      shipRow().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(shipToggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(shipToggle());
    // Already open: a click keeps it open and still lands on the toggle.
    act(() => shipRow().focus());
    click(shipRow().querySelector("[data-row]") ?? undefined);
    expect(shipToggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(shipToggle());
  });

  it("an unmet item reveals its row", () => {
    seen.reveals.length = 0;
    const p = plan();
    render({ board: board({ plan: p, ship: shipReadiness(p, undefined) }) });
    click(shipToggle() ?? undefined);
    click(button("2 tasks left"));
    expect(seen.reveals.at(-1)).toEqual({ id: "task-4", token: 1 });
  });

  it("opens by itself and reads Ready to ship once every task is done", () => {
    const p = allDone();
    const ship = shipReadiness(p, { status: "passed", command: "npx vitest run" });
    expect(ship.ready).toBe(true);
    render({ board: board({ plan: p, ship }) });
    expect(shipToggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(shipToggle()?.textContent).toBe("Ship checklist · 4 of 4 met");
    expect(container.querySelector("[data-row-id=ship]")?.textContent).toContain("Ready to ship");
    expect(shipBlock()?.textContent).toContain("3 tasks · 9 steps · 3 commits");
  });

  it("Copy summary copies the plan summary and says Copied for 2 s", () => {
    vi.useFakeTimers();
    try {
      const p = allDone();
      const ship = shipReadiness(p, { status: "passed", command: "npx vitest run" });
      const onCopy = vi.fn();
      render({ board: board({ plan: p, ship }), onCopy });
      const copyButton = Array.from(shipBlock()?.querySelectorAll("button") ?? []).find((b) => b.textContent === "Copy summary");
      click(copyButton);
      expect(onCopy).toHaveBeenCalledWith(planSummaryMarkdown(p, ship, []));
      const live = container.querySelector("[aria-live=polite]");
      expect(live?.textContent).toBe("Copied");
      // Said, not drawn as a new line: the region takes no room and the button says it instead.
      expect(live?.className).toContain("sr-only");
      expect(copyButton?.textContent).toBe("Copied");
      act(() => vi.advanceTimersByTime(2000));
      expect(live?.textContent).toBe("");
      expect(copyButton?.textContent).toBe("Copy summary");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Copy summary says Copied only for its own copy, not a sha or the menu's", () => {
    const p = allDone();
    const ship = shipReadiness(p, { status: "passed", command: "npx vitest run" });
    render({ board: board({ plan: p, ship }), onCopy: vi.fn() });
    const copyButton = () => Array.from(shipBlock()?.querySelectorAll("button") ?? []).find((b) => /^Cop/.test(b.textContent ?? ""));
    click(container.querySelector("button[aria-label='Copy 1111111']") ?? undefined);
    expect(container.querySelector("[aria-live=polite]")?.textContent).toBe("Copied");
    expect(copyButton()?.textContent).toBe("Copy summary");
    click(container.querySelector("button[aria-haspopup=menu]") ?? undefined);
    click(container.querySelector("[role=menu] [role=menuitem]") ?? undefined);
    expect(copyButton()?.textContent).toBe("Copy summary");
    click(copyButton());
    expect(copyButton()?.textContent).toBe("Copied");
  });
});

describe("TasksPanel menu", () => {
  const trigger = () => container.querySelector<HTMLButtonElement>("button[aria-haspopup=menu]");

  it("opens an in-flow menu with Copy summary that copies the plan summary", () => {
    const p = plan({ minors: [{ taskIndex: 2, text: "Rename helper" }] });
    const ship = shipReadiness(p, undefined);
    const gaps = [{ kind: "no-commit" as const, nodeId: "task-1", label: "Task 1", text: "no commit recorded" }];
    const onCopy = vi.fn();
    render({ board: board({ plan: p, ship, gaps }), onCopy });
    expect(trigger()?.getAttribute("aria-label")).toBe("More plan actions");
    expect(trigger()?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[role=menu]")).toBeNull();
    click(trigger() ?? undefined);
    expect(trigger()?.getAttribute("aria-expanded")).toBe("true");
    const item = container.querySelector<HTMLElement>("[role=menu] [role=menuitem]");
    expect(item?.textContent).toBe("Copy summary");
    expect(document.activeElement).toBe(item);
    click(item ?? undefined);
    expect(onCopy).toHaveBeenCalledWith(planSummaryMarkdown(p, ship, gaps));
    expect(container.querySelector("[role=menu]")).toBeNull();
    expect(container.querySelector("[aria-live=polite]")?.textContent).toBe("Copied");
  });

  it("shows a visible, non-shifting chip for the copy result and hides it from screen readers", () => {
    vi.useFakeTimers();
    try {
      render({ board: board({ plan: plan() }), onCopy: vi.fn() });
      const chip = () => container.querySelector<HTMLElement>("[data-copy-chip]");
      expect(chip()).toBeNull();
      click(trigger() ?? undefined);
      click(container.querySelector("[role=menuitem]") ?? undefined);
      expect(chip()?.textContent).toBe("Copied");
      // Heard once, from the live region; the chip only draws it, over the rows and out of the flow.
      expect(chip()?.getAttribute("aria-hidden")).toBe("true");
      expect(chip()?.className).toContain("h-0");
      expect(chip()?.className).toContain("sticky");
      expect(chip()?.firstElementChild?.className).toContain("absolute");
      expect(chip()?.firstElementChild?.className).toContain("text-content");
      act(() => vi.advanceTimersByTime(2000));
      expect(chip()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws a failed copy in the danger colour", async () => {
    render({ board: board({ plan: plan() }), onCopy: () => Promise.reject(new Error("denied")) });
    click(trigger() ?? undefined);
    await act(async () => {
      container.querySelector("[role=menuitem]")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const chip = container.querySelector("[data-copy-chip]");
    expect(chip?.textContent).toBe("Could not copy");
    expect(chip?.firstElementChild?.className).toContain("text-danger");
    expect(container.querySelector("[aria-live=polite]")?.textContent).toBe("Could not copy");
  });

  it("Escape closes the menu and returns focus to its button", () => {
    render({ board: board({ plan: plan() }) });
    click(trigger() ?? undefined);
    const item = container.querySelector("[role=menuitem]")!;
    act(() => item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("a pointer press outside the menu closes it", () => {
    render({ board: board({ plan: plan() }) });
    click(trigger() ?? undefined);
    act(() => container.querySelector("[role=menuitem]")!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(container.querySelector("[role=menu]")).not.toBeNull();
    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(container.querySelector("[role=menu]")).toBeNull();
  });

  it("copies with the clipboard when the host passes no onCopy", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render({ board: board({ plan: plan() }) });
    click(trigger() ?? undefined);
    await act(async () => {
      container.querySelector("[role=menuitem]")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[aria-live=polite]")?.textContent).toBe("Copied");
  });
});

describe("TasksPanel note groups", () => {
  const notesPlan = () =>
    plan({
      minors: [{ taskIndex: 2, text: "Rename helper" }],
      parked: [{ taskIndex: 3, text: "Cache later" }],
      decisions: [{ taskIndex: 1, text: "Use X" }],
    });
  const heading = (name: string) => container.querySelector<HTMLElement>(`[data-notes="${name}"]`);

  it("render below the graph with counts; Decisions open while the plan is unfinished", () => {
    const gaps = [{ kind: "no-commit" as const, nodeId: "task-2", label: "Task 2", text: "no commit recorded" }];
    render({ board: board({ plan: notesPlan(), gaps }) });
    expect(heading("deferred")?.textContent).toBe("Deferred · 2");
    expect(heading("gaps")?.textContent).toBe("Gaps · 1");
    expect(heading("decisions")?.textContent).toBe("Decisions made for you · 1");
    expect(heading("deferred")?.getAttribute("aria-expanded")).toBe("false");
    expect(heading("decisions")?.getAttribute("aria-expanded")).toBe("true");
    const tree = container.querySelector("[role=tree]")!;
    expect(tree.compareDocumentPosition(heading("deferred")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    click(heading("deferred"));
    expect(text()).toContain("Cache later");
  });

  it("Change this hands the decision to onChangeDecision", () => {
    const onChangeDecision = vi.fn();
    render({ board: board({ plan: notesPlan() }), onChangeDecision });
    click(button("Change this: Use X"));
    expect(onChangeDecision).toHaveBeenCalledWith({ taskIndex: 1, text: "Use X" });
  });

  it("a gap reveals its row", () => {
    seen.reveals.length = 0;
    const gaps = [{ kind: "no-commit" as const, nodeId: "task-2", label: "Task 2", text: "no commit recorded" }];
    render({ board: board({ plan: notesPlan(), gaps }) });
    click(heading("gaps"));
    click(button("Task 2: no commit recorded"));
    expect(seen.reveals.at(-1)).toEqual({ id: "task-2", token: 1 });
  });
});

describe("TasksPanel status card buttons", () => {
  let scrolled: Element[];
  beforeEach(() => {
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
  });

  const notesPlan = (patch: Partial<BoardSection> = {}) =>
    plan({ minors: [{ taskIndex: 2, text: "Rename helper" }], decisions: [{ taskIndex: 1, text: "Use X" }], ...patch });
  const struggling: StatusCard = { kind: "struggling", sessionId: "s1", headline: "Task 4 is on fix round 3 of 5", actions: ["see-issues"] };

  it("See the open issues opens Deferred, scrolls to it and focuses it when no task is struggling", () => {
    const onAction = vi.fn();
    render({ board: board({ plan: notesPlan(), statusCard: struggling }), onAction });
    click(button("See the open issues"));
    const deferred = container.querySelector('[data-notes="deferred"]');
    expect(deferred?.getAttribute("aria-expanded")).toBe("true");
    expect(scrolled).toContain(deferred);
    expect(document.activeElement).toBe(deferred);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("See the open issues goes to Gaps without deferred items, never to Decisions", () => {
    const gaps = [{ kind: "no-commit" as const, nodeId: "task-2", label: "Task 2", text: "no commit recorded" }];
    render({ board: board({ plan: plan({ decisions: [{ taskIndex: 1, text: "Use X" }] }), gaps, statusCard: struggling }) });
    click(button("See the open issues"));
    const heading = container.querySelector('[data-notes="gaps"]');
    expect(heading?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(heading);
  });

  it("See the open issues reveals the first problem row when there are no notes, else does nothing", () => {
    seen.reveals.length = 0;
    const p = plan({ decisions: [{ taskIndex: 1, text: "Use X" }] });
    const blocked = { ...p, nodes: p.nodes.map((n) => (n.index === 5 ? { ...n, status: "blocked" as const } : n)) };
    render({ board: board({ plan: blocked, statusCard: struggling }) });
    click(button("See the open issues"));
    expect(seen.reveals.at(-1)).toEqual({ id: "task-5", token: 1 });
    expect(container.querySelector('[data-notes="decisions"]')).not.toBe(document.activeElement);

    scrolled.length = 0;
    render({ board: board({ plan: p, statusCard: struggling }) });
    click(button("See the open issues"));
    expect(seen.reveals.at(-1)).toEqual({ id: "task-5", token: 1 });
    expect(scrolled).toEqual([]);
  });

  it("See the open issues reveals the struggling task when there is one", () => {
    seen.reveals.length = 0;
    const p = notesPlan();
    const stuck = { ...p, nodes: p.nodes.map((n) => (n.index === 4 ? { ...n, status: "attention" as const, fixRounds: 3 } : n)) };
    render({ board: board({ plan: stuck, statusCard: struggling }) });
    click(button("See the open issues"));
    expect(seen.reveals.at(-1)).toEqual({ id: "task-4", token: 1 });
  });

  it("Review decisions opens Decisions, scrolls to it and focuses it", () => {
    const done: StatusCard = { kind: "done", headline: "Plan finished", actions: ["review-decisions"] };
    const p = notesPlan({ done: 5, nodes: plan().nodes.map((n) => ({ ...n, status: "done" as const })) });
    render({ board: board({ plan: p, statusCard: done }) });
    const decisions = container.querySelector('[data-notes="decisions"]');
    // A finished plan keeps its decisions folded until asked.
    expect(decisions?.getAttribute("aria-expanded")).toBe("false");
    click(button("Review decisions"));
    expect(decisions?.getAttribute("aria-expanded")).toBe("true");
    expect(scrolled).toContain(decisions);
    expect(document.activeElement).toBe(decisions);
  });

  it("other card actions still reach onAction", () => {
    const onAction = vi.fn();
    render({ board: board(), onAction });
    click(button("Stop after this task"));
    expect(onAction).toHaveBeenCalledWith("stop-after-task", runningCard);
  });
});

describe("TasksPanel commits", () => {
  it("a commit link opens the commit through onOpenNode", () => {
    const onOpenNode = vi.fn();
    const p = plan({ nodes: [task(1, { commits: "abc1234def" }), ...plan().nodes.slice(1)] });
    render({ board: board({ plan: p }), onOpenNode });
    click(container.querySelector('[data-row-id="task-1"] [aria-label="Open commit abc1234"]') ?? undefined);
    expect(onOpenNode).toHaveBeenCalledWith({ ...p.nodes[0], target: { kind: "commit", ref: "abc1234" } }, p);
  });

  it("a stage's commit opens through its task", () => {
    const onOpenNode = vi.fn();
    const first = task(1, {
      stages: [
        { kind: "implement", label: "Implement", status: "done", sha: "1111111" },
        { kind: "review", label: "Review", status: "done" },
      ],
    });
    const p = plan({ nodes: [first, ...plan().nodes.slice(1)] });
    render({ board: board({ plan: p }), onOpenNode });
    click(container.querySelector('[data-row-id="task-1"] [data-row]') ?? undefined);
    click(container.querySelector('[data-row-id="task-1:stage:0"] [aria-label="Open commit 1111111"]') ?? undefined);
    expect(onOpenNode).toHaveBeenCalledWith({ ...first, target: { kind: "commit", ref: "1111111" } }, p);
  });

  it("Copy copies the sha through onCopy", () => {
    const onCopy = vi.fn();
    const p = plan({ nodes: [task(1, { commits: "abc1234def" }), ...plan().nodes.slice(1)] });
    render({ board: board({ plan: p }), onCopy });
    click(container.querySelector('[data-row-id="task-1"] [aria-label="Copy abc1234"]') ?? undefined);
    expect(onCopy).toHaveBeenCalledWith("abc1234");
  });
});
