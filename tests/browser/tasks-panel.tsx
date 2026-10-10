import { createRoot } from "react-dom/client";
import type { TaskBoard } from "../../src/features/tasks/hooks/useTaskBoard";
import { deriveFlow } from "../../src/features/tasks/model/flow";
import { gapsFor } from "../../src/features/tasks/model/gaps";
import { shipReadiness } from "../../src/features/tasks/model/ship";
import type { StatusCard } from "../../src/features/tasks/model/statusCard";
import type { BoardNode, BoardNote, BoardSection, BoardStage, BoardStep } from "../../src/features/tasks/model/taskBoard";
import type { TestRun } from "../../src/features/tasks/model/testRuns";
import { TasksPanel } from "../../src/features/tasks/ui/TasksPanel";
import "../../src/styles/index.css";

// Every state the browser specs measure. Sections are written in the shape `buildSddSection`
// produces (stages, steps with their raw tick, commits); the gaps, Ship readiness and flow strip
// come from the real model (`gapsFor`, `shipReadiness`, `deriveFlow`), as `useTaskBoard` does.

const MIN = 60_000;
const T0 = 1_000_000_000_000;
const NOW = T0 + 50 * MIN;
/** Task `n` starts three minutes after the one before it, so every start is before `NOW`. */
const start = (n: number) => T0 + (n - 1) * 3 * MIN;
const DIR = "/work/.superpowers/sdd/alpha";

const SHA = {
  t1: "1a2b3c4d5e6f",
  t2: "44aa0b1c2d3e",
  t2fix: "9f8e7d6c5b4a",
  t3: "5c6d7e8f9a0b",
  t4: "77e1d2c3b4a5",
  t5: "a0b1c2d3e4f5",
  final: "c0ffee123456",
};

/** `ticked` of `texts.length` plan steps ticked; a done task has every step done (as `stepsFor` does). */
function steps(texts: string[], ticked: number, done = false): BoardStep[] {
  return texts.map((text, i) => ({ text, done: done || i < ticked, ticked: i < ticked }));
}

const STEP_TEXT = ["Write the failing test", "Build the lane model", "Draw the rail", "Wire the keyboard", "Commit"];
const someSteps = (n: number) => STEP_TEXT.slice(0, n);

const implement = (n: number, sha?: string, status: BoardStage["status"] = "done"): BoardStage => ({
  kind: "implement",
  label: "Implement",
  status,
  startedAt: start(n),
  ...(status === "done" ? { endedAt: start(n) + MIN } : {}),
  ...(sha ? { sha } : {}),
});
const cleanReview = (n: number): BoardStage => ({
  kind: "review",
  label: "Review",
  status: "done",
  verdict: "spec ✅ quality ✅",
  startedAt: start(n) + 2 * MIN,
});

function task(n: number, title: string, patch: Partial<BoardNode> = {}): BoardNode {
  const done = (patch.status ?? "done") === "done";
  return {
    id: `task-${n}`,
    title,
    index: n,
    status: "done",
    startedAt: start(n),
    ...(done ? { endedAt: start(n + 1) - MIN } : {}),
    target: done ? { kind: "report", ref: `${DIR}/task-${n}-report.md` } : { kind: "brief", ref: `${DIR}/task-${n}-brief.md` },
    ...patch,
  };
}

/** A done task with one commit and a clean first review: one dot, "review clean". */
const cleanTask = (n: number, title: string, sha: string, patch: Partial<BoardNode> = {}) =>
  task(n, title, { stages: [implement(n, sha), cleanReview(n)], commits: sha, steps: steps(someSteps(3), 3, true), ...patch });

/** A done task whose first review found issues and one fix round closed them: forks and merges. */
const forkedTask = (n: number, title: string) =>
  task(n, title, {
    fixRounds: 1,
    summary: "Review found issues, then passed.",
    commits: `${SHA.t2}..${SHA.t2fix}`,
    steps: steps(someSteps(4), 4, true),
    stages: [
      implement(n, SHA.t2),
      { kind: "review", label: "Review", status: "attention", verdict: "2 issues", startedAt: start(n) + MIN },
      { kind: "fix", label: "R1", status: "done", verdict: "2 addressed, 0 open", sha: SHA.t2fix, endedAt: start(n + 1) - MIN },
    ],
  });

const pendingTask = (n: number, title: string, stepCount = 4) =>
  task(n, title, { status: "pending", startedAt: undefined, steps: steps(someSteps(stepCount), 0) });

/** Counts the plan totals from its nodes, the way the ledger and plan file add up. */
function plan(nodes: BoardNode[], patch: Partial<BoardSection> = {}): BoardSection {
  const all = nodes.flatMap((n) => n.steps ?? []);
  return {
    source: "sdd",
    id: "sdd:alpha",
    title: "tasks-graph",
    done: nodes.filter((n) => n.status === "done").length,
    total: nodes.length,
    startedAt: T0,
    nodes,
    steps: { done: all.filter((s) => s.ticked).length, total: all.length },
    specPath: "docs/superpowers/specs/alpha-design.md",
    planPath: "docs/superpowers/plans/alpha.md",
    finalReview: { id: "final-review", title: "Last review of the whole branch", status: "pending" },
    ...patch,
  };
}

const DECISIONS: BoardNote[] = [
  { taskIndex: 1, text: "Kept password login as a fallback." },
  { taskIndex: 2, text: "Used the existing duration formatter." },
  { taskIndex: 3, text: "Kept the poll at three seconds." },
];

// running: a clean task, a forked task with a fix round and commits, a running task with steps
// (the NOW row), then tasks not started.
const runningPlan = plan(
  [
    cleanTask(1, "Parse ledger", SHA.t1),
    forkedTask(2, "Board model"),
    task(3, "Graph view", {
      status: "running",
      stages: [implement(3, undefined, "running")],
      steps: steps(someSteps(5), 2),
    }),
    pendingTask(4, "Ship node"),
    pendingTask(5, "Note groups", 3),
  ],
  { decisions: DECISIONS, minors: [{ taskIndex: 1, text: "A stale comment in applyBatch.test.ts." }] },
);

// problems: every way a task goes wrong while the plan runs, and the gaps a finished task leaves.
const problemsPlan = plan(
  [
    cleanTask(1, "Parse ledger", SHA.t1),
    // Done with no commit anywhere.
    task(2, "Board model", { stages: [implement(2), cleanReview(2)], steps: steps(someSteps(3), 3, true) }),
    // Closed with parked items.
    cleanTask(3, "Overview UI", SHA.t3, { parkedAtClose: 2 }),
    // Done with plan steps left unticked.
    cleanTask(4, "Graph view", SHA.t4, { steps: steps(someSteps(4), 2, true) }),
    task(5, "Ship node", { status: "failed", stages: [implement(5, undefined, "failed")], steps: steps(someSteps(3), 1) }),
    task(6, "Note groups", { status: "blocked", stages: [implement(6, undefined, "blocked")], steps: steps(someSteps(3), 0) }),
    task(7, "Sticky bar", {
      status: "attention",
      fixRounds: 3,
      summary: "The reviewer has sent it back 3 times.",
      steps: steps(someSteps(4), 3),
      stages: [
        implement(7, SHA.t5),
        { kind: "review", label: "Review", status: "attention", verdict: "3 issues", startedAt: start(7) + 2 * MIN },
        { kind: "fix", label: "R1", status: "attention", verdict: "2 addressed, 1 open" },
        { kind: "fix", label: "R2", status: "attention", verdict: "0 addressed, 1 open" },
        { kind: "fix", label: "R3", status: "running" },
      ],
    }),
    pendingTask(8, "Copy summary", 2),
  ],
  {
    decisions: DECISIONS,
    parked: [
      { taskIndex: 3, text: "No boundary tests for 59_999 and 60_000." },
      { taskIndex: 3, text: "The legend repeats the glyph names." },
    ],
    minors: [{ taskIndex: 1, text: "A stale comment in applyBatch.test.ts." }],
  },
);

const FINAL_DONE: BoardNode = {
  id: "final-review",
  title: "Last review of the whole branch",
  status: "done",
  summary: "Ready to merge with fixes",
  commits: SHA.final,
  stages: [
    { kind: "final-review", label: "Final review", status: "done", verdict: "Ready to merge with fixes" },
    { kind: "final-fix", label: "Final fixes", status: "done", sha: SHA.final },
  ],
};

const doneTasks = () => [
  cleanTask(1, "Parse ledger", SHA.t1),
  forkedTask(2, "Board model"),
  cleanTask(3, "Overview UI", SHA.t3),
  cleanTask(4, "Graph view", SHA.t4),
  cleanTask(5, "Ship node", SHA.t5),
];

// ready: every task done, the final review clean after its fix wave, the tests passed.
const readyPlan = plan(doneTasks(), { decisions: DECISIONS, finalReview: FINAL_DONE });

// deferred: ready to ship, with parked items and small issues saved for the end (never blocking).
const deferredPlan = plan(doneTasks(), {
  decisions: DECISIONS,
  finalReview: FINAL_DONE,
  parked: [
    { taskIndex: 2, text: "No boundary tests for 59_999 and 60_000." },
    { taskIndex: 4, text: "The rail could animate on filter change." },
  ],
  minors: [
    { taskIndex: 1, text: "A stale comment in applyBatch.test.ts." },
    { taskIndex: 2, text: "Two helpers share a name." },
    { taskIndex: 4, text: "A test name says 'board'." },
  ],
});

// Every task done but the whole-branch review never ran: the no-final-review gap.
const doneNoFinalPlan = plan(doneTasks(), { decisions: DECISIONS });

// workers: the plan runs while two orchestration workers run beside it (lanes 2 and 3).
const workersPlan = plan([cleanTask(1, "Parse ledger", SHA.t1), forkedTask(2, "Board model"), runningPlan.nodes[2]!, pendingTask(4, "Ship node")], {
  decisions: DECISIONS,
});
const orchestration: BoardSection = {
  source: "orchestration",
  id: "orchestration",
  title: "Orchestration",
  done: 1,
  total: 3,
  nodes: [
    { id: "w1", title: "Port the docs index", status: "running", startedAt: T0 + 30 * MIN, target: { kind: "session", ref: "w1" } },
    { id: "w2", title: "Refresh the fixtures", status: "running", startedAt: T0 + 40 * MIN, dependsOn: ["w1"], target: { kind: "session", ref: "w2" } },
    { id: "w3", title: "Lint the plan files", status: "done", startedAt: T0, endedAt: T0 + 10 * MIN, target: { kind: "session", ref: "w3" } },
  ],
};

// Fourteen tasks, ten in trouble: every filter count has two digits and the problems row folds.
const manyProblemsPlan = plan([
  cleanTask(1, "Parse ledger", SHA.t1),
  cleanTask(2, "Board model", SHA.t2),
  ...Array.from({ length: 10 }, (_, i) => {
    const n = i + 3;
    const kind = i % 3;
    return kind === 0
      ? task(n, `Problem task ${n}`, { status: "failed", steps: steps(someSteps(2), 1) })
      : kind === 1
        ? task(n, `Problem task ${n}`, { status: "blocked", steps: steps(someSteps(2), 0) })
        : task(n, `Problem task ${n}`, { status: "attention", fixRounds: 3 + (i % 2), steps: steps(someSteps(3), 2) });
  }),
  pendingTask(13, "Copy summary", 2),
  pendingTask(14, "Evidence", 2),
]);

// A plan whose file was not read: no step counts and no plan steps anywhere.
const noStepsPlan: BoardSection = { ...runningPlan, nodes: runningPlan.nodes.map(({ steps: _drop, ...node }) => node) };
delete noStepsPlan.steps;

const CARDS: Record<string, StatusCard> = {
  "needs-you": {
    kind: "needs-you",
    sessionId: "s1",
    sessionTitle: "ssh-hardening",
    headline: "ssh-hardening is waiting for your answer",
    detail: "Task 3 asks: “Keep password login as a fallback?” · 3m ago",
    actions: ["answer-in-session", "remind-later"],
    others: { count: 2, kind: "quiet", text: "2 other runs · docs quiet 6m" },
  },
  struggling: {
    kind: "struggling",
    sessionId: "s1",
    headline: "Task 7 is on fix round 3 of 5",
    detail: "The reviewer has sent it back 3 times. If round 5 fails, it stops and asks you.",
    actions: ["see-issues"],
  },
  quiet: {
    kind: "quiet",
    sessionId: "s1",
    headline: "No activity on Task 3",
    detail: "Quiet for 6m.",
    since: NOW - 6 * MIN,
    actions: ["open-reviewer", "keep-waiting"],
  },
  running: {
    kind: "running",
    sessionId: "s1",
    headline: "An implementer is on Task 3",
    detail: "tasks-graph · 2m 14s so far",
    reassurance: "Nothing needs you",
    actions: ["stop-after-task", "open-session"],
  },
  done: {
    kind: "done",
    sessionId: "s1",
    headline: "Plan finished in 1h 52m",
    detail: "3 decisions to look over",
    actions: ["review-decisions"],
  },
};

const PASSED: TestRun = { status: "passed", at: NOW - 4 * MIN, command: "npx vitest run" };
const FAILED: TestRun = { status: "failed", at: NOW - 2 * MIN, command: "npx vitest run" };

type Scene = { card: StatusCard; plan: BoardSection; testRun?: TestRun; sections?: BoardSection[] };

/** Every state the specs may ask for. An unknown name throws: a typo must not measure the wrong panel. */
const SCENES: Record<string, Scene> = {
  // The five states the score measures.
  running: { card: CARDS.running, plan: runningPlan },
  problems: { card: CARDS.struggling, plan: problemsPlan, testRun: FAILED },
  ready: { card: CARDS.done, plan: readyPlan, testRun: PASSED },
  deferred: { card: CARDS.done, plan: deferredPlan, testRun: PASSED },
  workers: { card: CARDS.running, plan: workersPlan, sections: [orchestration] },
  // Variants.
  "done-no-final": { card: CARDS.done, plan: doneNoFinalPlan, testRun: PASSED },
  "many problems": { card: CARDS.struggling, plan: manyProblemsPlan, testRun: FAILED },
  "no steps": { card: CARDS.running, plan: noStepsPlan },
  "needs-you": { card: CARDS["needs-you"], plan: runningPlan },
  quiet: { card: CARDS.quiet, plan: runningPlan },
};

function board({ card, plan: section, testRun, sections = [] }: Scene): TaskBoard {
  const ship = shipReadiness(section, testRun);
  const subagentsRunning = sections.reduce((n, s) => n + s.nodes.filter((node) => node.status === "running").length, 0);
  return {
    sections: [section, ...sections],
    plan: section,
    flow: deriveFlow({ plan: section, subagentsRunning, now: NOW, ship, planRoot: "/work", ...(testRun ? { testRun } : {}) }),
    statusCard: card,
    ...(testRun ? { testRun } : {}),
    ship,
    gaps: gapsFor(section),
    // Two workspaces, so the plan picker renders and its target size is measured.
    workspaces: [
      { dir: DIR, slug: "alpha", ledgerMtimeMs: T0 },
      { dir: "/work/.superpowers/sdd/beta", slug: "beta", ledgerMtimeMs: T0 - MIN },
    ],
    selectedWorkspace: "alpha",
    selectWorkspace: () => {},
    loading: false,
    loaded: true,
  };
}

/** What the panel asked the host to do, so a spec can tell a key or a link really worked. */
type TasksEvent =
  | { type: "open"; id: string; target?: { kind: string; ref: string } }
  | { type: "copy"; text: string }
  | { type: "file"; path: string }
  | { type: "action"; action: string }
  | { type: "decision"; text: string };

const root = createRoot(document.getElementById("root")!);

declare global {
  interface Window {
    /** `nowOffsetMs` moves the panel's clock forward from `NOW`, so a spec can tell a stopped clock from a running one. */
    showTasks(state: string, nowOffsetMs?: number): void;
    setTheme(theme: "dark" | "light", palette?: "default" | "colorblind" | "high-contrast"): void;
    tasksStates: string[];
    tasksEvents: TasksEvent[];
  }
}

window.tasksStates = Object.keys(SCENES);
window.tasksEvents = [];
let renders = 0;

window.showTasks = (state, nowOffsetMs = 0) => {
  const scene = SCENES[state];
  if (!scene) throw new Error(`Unknown tasks panel state "${state}"; known: ${Object.keys(SCENES).join(", ")}`);
  window.tasksEvents = [];
  const log = (event: TasksEvent) => {
    window.tasksEvents.push(event);
  };
  root.render(
    <TasksPanel
      // Every call starts fresh: no toggles, filter or menu carried over.
      key={++renders}
      board={board(scene)}
      now={NOW + nowOffsetMs}
      onAction={(action) => log({ type: "action", action })}
      onOpenNode={(node) => log({ type: "open", id: node.id, ...(node.target ? { target: node.target } : {}) })}
      onOpenFile={(path) => log({ type: "file", path })}
      onChangeDecision={(note) => log({ type: "decision", text: note.text })}
      onCopy={(text) => log({ type: "copy", text })}
    />,
  );
};

window.setTheme = (theme, palette = "default") => {
  const html = document.documentElement;
  html.classList.toggle("theme-light", theme === "light");
  html.classList.remove("diff-palette-colorblind", "diff-palette-high-contrast");
  if (palette !== "default") html.classList.add(`diff-palette-${palette}`);
};

window.showTasks("running");
