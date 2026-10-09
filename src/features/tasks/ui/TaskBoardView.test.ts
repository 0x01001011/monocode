// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoard } from "../hooks/useTaskBoard";
import type { StatusCard } from "../model/statusCard";
import type { BoardNode, BoardSection } from "../model/taskBoard";
import { TaskBoardView } from "./TaskBoardView";

const hook = vi.hoisted(() => ({ board: undefined as unknown, calls: [] as unknown[] }));
vi.mock("../hooks/useTaskBoard", () => ({
  useTaskBoard: (input: unknown) => {
    hook.calls.push(input);
    return hook.board;
  },
}));

let container: HTMLDivElement;
let root: Root;

const MIN = 60_000;
const T0 = 1_000_000_000_000;
const NOW = T0 + 50 * MIN;
const PLAN_PATH = "docs/plans/alpha.md";

const runningCard: StatusCard = {
  kind: "running",
  sessionId: "s1",
  headline: "A reviewer is checking Task 3",
  detail: "Step 3 title · 2m 14s so far",
  reassurance: "Nothing needs you",
  actions: ["stop-after-task", "open-session"],
};

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

const nodes: BoardNode[] = [
  task(1, { summary: "Passed first review." }),
  task(2, {
    summary: "Review found issues. Fixed in 2 rounds, then passed.",
    fixRounds: 2,
    commits: "129e9e2..e704fdd",
    models: "Implementer sonnet, reviewer opus",
    steps: [
      { text: "Write the failing test", done: true },
      { text: "Make it pass", done: true },
    ],
    target: { kind: "report", ref: "/w/task-2-report.md" },
    stages: [
      { kind: "implement", label: "Implement", status: "done" },
      { kind: "review", label: "Review", status: "attention", verdict: "spec ❌ missing case" },
      { kind: "fix", label: "R1", status: "done" },
      { kind: "fix", label: "R2", status: "done" },
    ],
  }),
  task(3, {
    status: "running",
    endedAt: undefined,
    steps: [{ text: "Wire it up", done: false }],
    stages: [
      { kind: "implement", label: "Implement", status: "done" },
      { kind: "review", label: "Review", status: "running" },
    ],
  }),
  task(4, { status: "pending", startedAt: undefined, endedAt: undefined }),
];

function plan(patch: Partial<BoardSection> = {}): BoardSection {
  return {
    source: "sdd",
    id: "sdd:alpha",
    title: "Alpha plan",
    done: 2,
    total: 4,
    startedAt: T0,
    nodes,
    planPath: PLAN_PATH,
    decisions: [
      { taskIndex: 4, text: "Count a skill when you send it. If wrong: picks you never send are not counted." },
      { taskIndex: 2, text: "Keep disabled skills visible." },
    ],
    minors: [{ taskIndex: 1, text: "Memo entries live for the whole process." }],
    finalReview: { id: "final-review", title: "Last review of the whole branch", status: "pending" },
    ...patch,
  };
}

function board(over: Partial<TaskBoard> = {}): TaskBoard {
  const p = over.plan ?? plan();
  return {
    sections: [p],
    plan: p,
    statusCard: runningCard,
    workspaces: [],
    selectWorkspace: () => {},
    loading: false,
    ...over,
  };
}

function render(props: Partial<ComponentProps<typeof TaskBoardView>> = {}) {
  act(() => root.render(createElement(TaskBoardView, { projectCwd: "/repo", sessions: [], ...props })));
}

const text = () => container.textContent ?? "";
const buttons = (name: string) =>
  Array.from(container.querySelectorAll("button")).filter(
    (b) => (b.textContent ?? "").trim() === name || b.getAttribute("aria-label") === name,
  );
const click = (el: Element | undefined) => {
  expect(el).toBeDefined();
  act(() => el?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};
const rowFor = (title: string) =>
  Array.from(container.querySelectorAll("tbody tr")).find((r) => (r.textContent ?? "").includes(title));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  hook.board = board();
  hook.calls = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TaskBoardView", () => {
  it("renders every task including pending and the final review row", () => {
    render();
    const rows = Array.from(container.querySelectorAll("tbody tr[data-node]"));
    expect(rows.map((r) => r.getAttribute("data-node"))).toEqual([
      "task-1",
      "task-2",
      "task-3",
      "task-4",
      "final-review",
    ]);
    expect(text()).toContain("Step 4 title");
    expect(text()).toContain("Last review of the whole branch");
    const headers = Array.from(container.querySelectorAll("th[scope=col]")).map((h) => h.textContent);
    expect(headers).toEqual(["Status", "Task", "What happened", "Time"]);
    // The pending rows say nothing about time and happened.
    expect(rowFor("Step 4 title")?.querySelector("td:last-child")?.textContent).toBe("");
  });

  it("uses the live board with the visible flag, the session and its siblings", () => {
    const sessions = [{ id: "s1", title: "One", busy: true, needsInput: false }];
    render({ sessions });
    const input = hook.calls.at(-1) as { projectCwd: string; visible: boolean; sessions: unknown };
    expect(input.projectCwd).toBe("/repo");
    expect(input.visible).toBe(true);
    expect(input.sessions).toBe(sessions);
  });

  it("ordinary tasks show one phrase and the running task shows a chain", () => {
    render();
    expect(rowFor("Step 1 title")?.textContent).toContain("Passed first review.");
    expect(rowFor("Step 1 title")?.textContent).not.toContain("→");
    // Two fix rounds is unusual, so it gets the chain built from its stages only.
    expect(rowFor("Step 2 title")?.textContent).toContain("written → review found issues → fixed in 2 rounds, passed");
    // The running node ends with its review stage and prints nothing it has not reached.
    const running = rowFor("Step 3 title")?.textContent ?? "";
    expect(running).toContain("written → in review");
    expect(running).not.toContain("fixed");
    expect(running).not.toContain("passed");
  });

  it("chains a blocked task and never prints a stage that is absent", () => {
    const blocked = task(3, {
      status: "blocked",
      endedAt: undefined,
      stages: [{ kind: "implement", label: "Implement", status: "blocked" }],
    });
    const p = plan({ nodes: [nodes[0], blocked], total: 2, done: 1 });
    hook.board = board({ plan: p, sections: [p] });
    render();
    const row = rowFor("Step 3 title")?.textContent ?? "";
    expect(row).toContain("blocked");
    expect(row).not.toContain("review");
    expect(row).not.toContain("→");
  });

  it("a task with a parked note shows its chain", () => {
    const one = task(1, {
      summary: "Passed after 1 fix.",
      fixRounds: 1,
      stages: [
        { kind: "implement", label: "Implement", status: "done" },
        { kind: "fix", label: "R1", status: "done" },
      ],
    });
    const other = task(2, { summary: "Passed after 1 fix.", fixRounds: 1, stages: one.stages });
    const parked = plan({ nodes: [one, other], total: 2, done: 2, parked: [{ taskIndex: 1, text: "Not now" }] });
    hook.board = board({ plan: parked, sections: [parked] });
    render();
    expect(rowFor("Step 1 title")?.textContent).toContain("written → fixed in 1 round, passed");
    expect(rowFor("Step 2 title")?.textContent).toContain("Passed after 1 fix.");
    expect(rowFor("Step 2 title")?.textContent).not.toContain("→");
  });

  it("header shows Nothing needs you when running", () => {
    render();
    const headline = container.querySelector("h2");
    expect(headline?.textContent).toContain("A reviewer is checking Task 3");
    expect(headline?.textContent).toContain("Nothing needs you");
    expect(text()).toContain("Alpha plan · 2 of 4 done");
    expect(text()).toContain("so far");
  });

  it("header drops the reassurance when something needs you", () => {
    const card: StatusCard = { kind: "needs-you", sessionId: "s2", headline: "ssh is waiting", actions: ["answer-in-session"] };
    hook.board = board({ statusCard: card });
    render();
    expect(container.querySelector("h2")?.textContent).toBe("ssh is waiting");
    expect(text()).not.toContain("Nothing needs you");
  });

  it("Open plan calls the handler with the plan path and carries it in the tooltip", () => {
    const onOpenPlan = vi.fn();
    render({ onOpenPlan });
    const open = buttons("Open plan")[0];
    expect(open.getAttribute("title")).toBe(PLAN_PATH);
    click(open);
    expect(onOpenPlan).toHaveBeenCalledWith(PLAN_PATH);
  });

  it("row chevron toggles the detail row with aria-expanded", () => {
    const onOpenNode = vi.fn();
    render({ onOpenNode });
    const toggle = buttons("Show details for Task 2")[0];
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("tr[data-detail]")).toBeNull();
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const detail = container.querySelector("tr[data-detail=task-2]");
    expect(detail).not.toBeNull();
    expect(toggle.getAttribute("aria-controls")).toBe(detail?.id);
    const body = detail?.textContent ?? "";
    expect(body).toContain("129e9e2..e704fdd");
    expect(body).toContain("Implementer sonnet, reviewer opus");
    expect(body).toContain("Write the failing test");
    expect(detail?.querySelectorAll("[aria-label=done]")).toHaveLength(2);
    // The commit button opens the commit; Open review uses the node's own target.
    click(buttons("129e9e2..e704fdd")[0]);
    expect(onOpenNode.mock.calls[0][0]).toMatchObject({ id: "task-2", target: { kind: "commit", ref: "129e9e2..e704fdd" } });
    click(buttons("Open review")[0]);
    expect(onOpenNode.mock.calls[1][0]).toMatchObject({ target: { kind: "report", ref: "/w/task-2-report.md" } });
    expect(onOpenNode.mock.calls[1][1]).toMatchObject({ id: "sdd:alpha" });
    expect(buttons("Open transcript")).toHaveLength(0);
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("tr[data-detail]")).toBeNull();
  });

  it("an unfinished task's steps are never ticked", () => {
    render();
    click(buttons("Show details for Task 3")[0]);
    const detail = container.querySelector("tr[data-detail=task-3]");
    expect(detail?.textContent).toContain("Wire it up");
    expect(detail?.querySelectorAll("[aria-label=done]")).toHaveLength(0);
    expect(buttons("Open review")).toHaveLength(0);
  });

  it("shows the transcript button for a transcript target", () => {
    const withTranscript = task(1, { target: { kind: "transcript", ref: "s1#7" } });
    const p = plan({ nodes: [withTranscript], total: 1, done: 1 });
    hook.board = board({ plan: p, sections: [p] });
    const onOpenNode = vi.fn();
    render({ onOpenNode });
    click(buttons("Show details for Task 1")[0]);
    expect(buttons("Open review")).toHaveLength(0);
    click(buttons("Open transcript")[0]);
    expect(onOpenNode.mock.calls[0][0]).toMatchObject({ target: { kind: "transcript", ref: "s1#7" } });
  });

  it("lists decisions with their source and the explainers", () => {
    render();
    expect(text()).toContain("Decisions made for you");
    expect(text()).toContain("Calls the agent made without stopping to ask. Change any of them by telling the agent.");
    expect(text()).toContain("Count a skill when you send it. If wrong: picks you never send are not counted.");
    expect(text()).toContain("Small issues saved for the end");
    expect(text()).toContain("Things the reviewer chose not to block on. The final review decides which to fix.");
    expect(text()).toContain("Memo entries live for the whole process.");
    expect(buttons("Change this")).toHaveLength(2);
  });

  it("Change this calls the handler with the decision", () => {
    const onChangeDecision = vi.fn();
    render({ onChangeDecision });
    click(buttons("Change this")[0]);
    expect(onChangeDecision).toHaveBeenCalledWith(plan().decisions?.[0]);
  });

  it("header actions call onAction with the card", () => {
    const onAction = vi.fn();
    render({ onAction });
    click(buttons("Stop after this task")[0]);
    expect(onAction).toHaveBeenCalledWith("stop-after-task", runningCard);
  });

  it("says so when there is no plan to show", () => {
    hook.board = board({ plan: undefined, sections: [], statusCard: { kind: "idle", headline: "", actions: [] } });
    render();
    expect(text()).toContain("Nothing to track yet");
    expect(container.querySelector("table")).toBeNull();
  });
});
