import type { BoardNode, BoardSection, BoardStatus } from "./taskBoard";

export type PlanOverview = {
  tasks: {
    total: number;
    done: number;
    running: number;
    attention: number;
    failed: number;
    blocked: number;
    pending: number;
  };
  /** Tasks not done, plus the final review when it exists and is not done. */
  left: number;
  /** Steps ticked of all steps; present only when the plan file was read. */
  steps?: { done: number; total: number };
  /** The first task in plan order that is running or needs a look. */
  current?: { id: string; label: string };
  /** Failed, blocked and heavily fixed tasks in plan order. */
  problems: { id: string; label: string; why: string }[];
  /** One per task in plan order, then the final review when there is one. */
  segments: { id: string; status: BoardStatus }[];
};

/** The controller stops fixing after this many rounds. */
const MAX_FIX_ROUNDS = 5;
/** From this round on a task that still needs a look is a problem. */
const PROBLEM_FROM_ROUND = 3;

const labelOf = (node: BoardNode, position: number) => `Task ${node.index ?? position + 1}`;

function whyProblem(node: BoardNode): string | undefined {
  if (node.status === "failed") return "failed";
  if (node.status === "blocked") return "blocked";
  const rounds = node.fixRounds ?? 0;
  if (node.status === "attention" && rounds >= PROBLEM_FROM_ROUND) {
    return `fix ${Math.min(rounds, MAX_FIX_ROUNDS)} of ${MAX_FIX_ROUNDS}`;
  }
  return undefined;
}

/** What the plan header and strip say at a glance. Pure: counts the section's nodes. */
export function planOverview(section: BoardSection): PlanOverview {
  const { nodes, finalReview } = section;
  const count = (status: BoardStatus) => nodes.filter((n) => n.status === status).length;
  const tasks = {
    total: nodes.length,
    done: count("done"),
    running: count("running"),
    attention: count("attention"),
    failed: count("failed"),
    blocked: count("blocked"),
    pending: count("pending"),
  };

  const at = nodes.findIndex((n) => n.status === "running" || n.status === "attention");

  const problems = nodes.flatMap((node, i) => {
    const why = whyProblem(node);
    return why ? [{ id: node.id, label: labelOf(node, i), why }] : [];
  });

  return {
    tasks,
    left: nodes.length - tasks.done + (finalReview && finalReview.status !== "done" ? 1 : 0),
    ...(section.steps ? { steps: { done: section.steps.done, total: section.steps.total } } : {}),
    ...(at >= 0 ? { current: { id: nodes[at].id, label: labelOf(nodes[at], at) } } : {}),
    problems,
    segments: [
      ...nodes.map((n) => ({ id: n.id, status: n.status })),
      ...(finalReview ? [{ id: finalReview.id, status: finalReview.status }] : []),
    ],
  };
}
