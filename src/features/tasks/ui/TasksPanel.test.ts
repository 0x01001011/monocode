// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoard } from "../hooks/useTaskBoard";
import type { StatusCard } from "../model/statusCard";
import type { BoardNode, BoardSection } from "../model/taskBoard";
import { TasksPanel } from "./TasksPanel";

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
    render({ board: board({ plan: plan({ done: 2 }) }) });
    expect(text()).toContain("2 of 5 done");
    expect(text()).not.toContain("left");
    render({ board: board({ plan: plan({ done: 3 }) }) });
    // Three tasks took 10m each and two remain.
    expect(text()).toContain("3 of 5 done · 50m so far · about 20m left");
    render({ board: board({ plan: plan({ done: 5 }) }) });
    expect(text()).not.toContain("left");
  });

  it("renders the plan tree and the last-review line while it is pending", () => {
    render({ board: board({ plan: plan() }) });
    expect(text()).toContain("Alpha plan");
    expect(container.querySelector("[role=tree]")).not.toBeNull();
    expect(text()).toContain("Then one last review of the whole branch.");
    render({ board: board({ plan: plan({ finalReview: { id: "final-review", title: "Last review of the whole branch", status: "running" } }) }) });
    expect(text()).not.toContain("Then one last review");
    expect(container.querySelectorAll("[role=treeitem]")).toHaveLength(6);
  });

  it("Open as tab fires onOpenAsTab", () => {
    const onOpenAsTab = vi.fn();
    render({ board: board({ plan: plan() }), onOpenAsTab });
    click(button("Open as tab"));
    expect(onOpenAsTab).toHaveBeenCalledTimes(1);
  });

  it("See the open issues and Review decisions open the full tab instead of calling onAction", () => {
    const onAction = vi.fn();
    const onOpenAsTab = vi.fn();
    const struggling: StatusCard = { kind: "struggling", sessionId: "s1", headline: "Task 4 is on fix round 3 of 5", actions: ["see-issues"] };
    render({ board: board({ plan: plan(), statusCard: struggling }), onAction, onOpenAsTab });
    click(button("See the open issues"));
    expect(onOpenAsTab).toHaveBeenCalledTimes(1);

    const done: StatusCard = { kind: "done", headline: "Plan finished", actions: ["review-decisions"] };
    const withDecisions = plan({ decisions: [{ taskIndex: 2, text: "Keep it" }] });
    render({ board: board({ plan: withDecisions, statusCard: done }), onAction, onOpenAsTab });
    click(button("Review decisions"));
    expect(onOpenAsTab).toHaveBeenCalledTimes(2);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("other card actions still reach onAction", () => {
    const onAction = vi.fn();
    const onOpenAsTab = vi.fn();
    render({ board: board(), onAction, onOpenAsTab });
    click(button("Stop after this task"));
    expect(onAction).toHaveBeenCalledWith("stop-after-task", runningCard);
    expect(onOpenAsTab).not.toHaveBeenCalled();
  });

  it("decisions show three then Show all", () => {
    const decisions = Array.from({ length: 5 }, (_, i) => ({ taskIndex: i + 1, text: `Decision number ${i + 1}` }));
    render({ board: board({ plan: plan({ decisions }) }) });
    const header = button("Decisions made for you, 5");
    expect(header?.getAttribute("aria-expanded")).toBe("true");
    expect(text()).toContain("Decision number 3");
    expect(text()).not.toContain("Decision number 4");
    expect(text()).toContain("Task 3");
    click(button("Show all 5"));
    expect(text()).toContain("Decision number 5");
    expect(button("Show all 5")).toBeUndefined();
    click(header);
    expect(header?.getAttribute("aria-expanded")).toBe("false");
    expect(text()).not.toContain("Decision number 1");
  });

  it("small issues are collapsed, merge parked ones and show nothing for zero", () => {
    render({ board: board({ plan: plan({ minors: [{ taskIndex: 2, text: "Rename helper" }], parked: [{ taskIndex: 3, text: "Cache later" }] }) }) });
    const header = button("Small issues saved for the end, 2");
    expect(header?.getAttribute("aria-expanded")).toBe("false");
    expect(text()).not.toContain("Rename helper");
    click(header);
    expect(text()).toContain("Rename helper");
    expect(text()).toContain("Cache later");
    expect(text()).toContain("parked");
    render({ board: board({ plan: plan() }) });
    expect(text()).not.toContain("Small issues");
    expect(text()).not.toContain("Decisions made for you");
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

  it("legend button toggles the legend", () => {
    render({ board: board({ plan: plan() }) });
    const legend = button("What the symbols mean");
    expect(legend?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[aria-label='Symbol legend']")).toBeNull();
    click(legend);
    expect(legend?.getAttribute("aria-expanded")).toBe("true");
    const list = container.querySelector("[aria-label='Symbol legend']");
    for (const label of ["Done", "Not started", "Running", "Needs you", "Struggling", "Quiet", "Failed", "Review found issues"]) {
      expect(list?.textContent).toContain(label);
    }
    click(legend);
    expect(container.querySelector("[aria-label='Symbol legend']")).toBeNull();
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
