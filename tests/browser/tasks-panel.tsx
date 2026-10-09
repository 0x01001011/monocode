import { createRoot } from "react-dom/client";
import type { TaskBoard } from "../../src/features/tasks/hooks/useTaskBoard";
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

function board(card: StatusCard): TaskBoard {
  return {
    sections: [plan],
    plan,
    statusCard: card,
    workspaces: [],
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
  root.render(<TasksPanel board={board(CARDS[state])} now={NOW} onAction={() => {}} onOpenAsTab={() => {}} />);
};

window.setTheme = (theme, palette = "default") => {
  const html = document.documentElement;
  html.classList.toggle("theme-light", theme === "light");
  html.classList.remove("diff-palette-colorblind", "diff-palette-high-contrast");
  if (palette !== "default") html.classList.add(`diff-palette-${palette}`);
};

window.showTasks("running");
