import { createRoot } from "react-dom/client";
import type { TaskBoard } from "../../src/features/tasks/hooks/useTaskBoard";
import type { FlowPhase } from "../../src/features/tasks/model/flow";
import type { StatusCard } from "../../src/features/tasks/model/statusCard";
import type { BoardNode, BoardSection } from "../../src/features/tasks/model/taskBoard";
import { TasksPanel } from "../../src/features/tasks/ui/TasksPanel";
import "../../src/styles/index.css";

const MIN = 60_000;
const T0 = 1_000_000_000_000;
const NOW = T0 + 50 * MIN;

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

const plan: BoardSection = {
  source: "sdd",
  id: "sdd:alpha",
  title: "Alpha plan",
  done: 3,
  total: 6,
  startedAt: T0,
  nodes: [
    task(1),
    task(2, { summary: "Review found 3 issues. Fixed in 1 round, then passed.", fixRounds: 1 }),
    task(3),
    task(4, {
      status: "running",
      endedAt: undefined,
      stages: [
        { kind: "implement", label: "Code written", status: "done", startedAt: T0 + 30 * MIN, endedAt: T0 + 35 * MIN },
        { kind: "review", label: "Review in progress", status: "running", startedAt: T0 + 36 * MIN },
      ],
    }),
    task(5, { status: "attention", fixRounds: 3, endedAt: undefined, summary: "The reviewer has sent it back 3 times." }),
    task(6, { status: "blocked", endedAt: undefined }),
    task(7, { status: "pending", startedAt: undefined, endedAt: undefined }),
  ],
  decisions: [
    { taskIndex: 2, text: "Kept password login as a fallback." },
    { taskIndex: 3, text: "Used the existing duration formatter." },
    { taskIndex: 4, text: "Kept the poll at three seconds." },
    { taskIndex: 5, text: "Left the legend closed by default." },
  ],
  minors: [{ taskIndex: 1, text: "A stale comment in applyBatch.test.ts." }],
  parked: [{ taskIndex: 2, text: "No boundary tests for 59_999 and 60_000." }],
  finalReview: { id: "final-review", title: "Last review of the whole branch", status: "pending" },
};

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
    headline: "Task 5 is on fix round 3 of 5",
    detail: "The reviewer has sent it back 3 times. If round 5 fails, it stops and asks you.",
    actions: ["see-issues"],
  },
  quiet: {
    kind: "quiet",
    sessionId: "s1",
    headline: "No activity on Task 4",
    detail: "Quiet for 6m.",
    since: NOW - 6 * MIN,
    actions: ["open-reviewer", "keep-waiting"],
  },
  running: {
    kind: "running",
    sessionId: "s1",
    headline: "A reviewer is checking Task 4",
    detail: "Alpha plan · 2m 14s so far",
    reassurance: "Nothing needs you",
    actions: ["stop-after-task", "open-session"],
  },
  done: {
    kind: "done",
    sessionId: "s1",
    headline: "Plan finished in 1h 52m",
    detail: "9 decisions to look over",
    actions: ["review-decisions"],
  },
};

// A plan whose every task is done and whose last review passed: the finished state.
const finishedPlan: BoardSection = {
  ...plan,
  done: 6,
  nodes: [1, 2, 3, 4, 5, 6].map((n) => task(n, n === 2 ? { summary: "Review found 3 issues. Fixed in 1 round, then passed.", fixRounds: 1 } : {})),
  finalReview: { id: "final-review", title: "Last review of the whole branch", status: "done" },
};

const SPEC: FlowPhase = { id: "spec", label: "Spec", status: "done", path: "docs/superpowers/specs/alpha-design.md" };
const PLAN: FlowPhase = { id: "plan", label: "Plan", status: "done", detail: "6 tasks", path: "docs/superpowers/plans/alpha.md" };

const FLOW: FlowPhase[] = [
  SPEC,
  PLAN,
  { id: "build", label: "Build", status: "running", detail: "3 of 6, 2 subagents working" },
  { id: "check", label: "Check", status: "pending" },
];

// The struggling state: Build is on a high fix round and the last test run failed.
const FAILED_CHECK_FLOW: FlowPhase[] = [
  SPEC,
  PLAN,
  { id: "build", label: "Build", status: "attention", detail: "3 of 6" },
  { id: "check", label: "Check", status: "failed", detail: "tests failed 2m ago" },
];

// A task is blocked: Build shows the blocked glyph and nothing has been checked yet.
const BLOCKED_FLOW: FlowPhase[] = [
  SPEC,
  PLAN,
  { id: "build", label: "Build", status: "blocked", detail: "3 of 6" },
  { id: "check", label: "Check", status: "pending" },
];

// Everything is done: the review passed and the tests passed.
const FINISHED_FLOW: FlowPhase[] = [
  SPEC,
  PLAN,
  { id: "build", label: "Build", status: "done", detail: "6 of 6" },
  { id: "check", label: "Check", status: "done", detail: "tests passed 4m ago, final review done" },
];

type View = { card: StatusCard; flow: FlowPhase[]; plan: BoardSection };

/** Every state the spec may ask for. An unknown name throws: a typo must not measure the wrong panel. */
const SCENES: Record<string, View> = {
  "needs-you": { card: CARDS["needs-you"], flow: FLOW, plan },
  struggling: { card: CARDS.struggling, flow: FLOW, plan },
  quiet: { card: CARDS.quiet, flow: FLOW, plan },
  running: { card: CARDS.running, flow: FLOW, plan },
  done: { card: CARDS.done, flow: FLOW, plan },
  "failed check": { card: CARDS.struggling, flow: FAILED_CHECK_FLOW, plan },
  "blocked build": { card: CARDS["needs-you"], flow: BLOCKED_FLOW, plan },
  finished: { card: CARDS.done, flow: FINISHED_FLOW, plan: finishedPlan },
};

function board({ card, flow, plan: section }: View): TaskBoard {
  return {
    sections: [section],
    plan: section,
    flow,
    statusCard: card,
    // Two workspaces, so the plan picker renders and its target size is measured.
    workspaces: [
      { dir: "/work/.superpowers/sdd/alpha", slug: "alpha", ledgerMtimeMs: T0 },
      { dir: "/work/.superpowers/sdd/beta", slug: "beta", ledgerMtimeMs: T0 - MIN },
    ],
    selectedWorkspace: "alpha",
    selectWorkspace: () => {},
    loading: false,
    loaded: true,
  };
}

const root = createRoot(document.getElementById("root")!);

declare global {
  interface Window {
    showTasks(state: string): void;
    setTheme(theme: "dark" | "light", palette?: "default" | "colorblind" | "high-contrast"): void;
  }
}

window.showTasks = (state) => {
  const scene = SCENES[state];
  if (!scene) throw new Error(`Unknown tasks panel state "${state}"; known: ${Object.keys(SCENES).join(", ")}`);
  root.render(
    <TasksPanel board={board(scene)} now={NOW} onAction={() => {}} onOpenAsTab={() => {}} onOpenFile={() => {}} />,
  );
};

window.setTheme = (theme, palette = "default") => {
  const html = document.documentElement;
  html.classList.toggle("theme-light", theme === "light");
  html.classList.remove("diff-palette-colorblind", "diff-palette-high-contrast");
  if (palette !== "default") html.classList.add(`diff-palette-${palette}`);
};

window.showTasks("running");
