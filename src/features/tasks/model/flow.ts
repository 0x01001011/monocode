import type { Block } from "../../sessions/model/session";
import { formatDuration } from "./duration";
import { isSafePlanPath } from "./planRoot";
import type { Ship } from "./ship";
import type { BoardSection, BoardStatus } from "./taskBoard";
import { lastTestRun, type TestRun } from "./testRuns";

export type FlowPhaseId = "spec" | "plan" | "build" | "check" | "ship";

export type FlowPhase = {
  id: FlowPhaseId;
  /** "Spec", "Plan", "Build", "Check", "Ship". */
  label: string;
  /** The board vocabulary, so a phase renders with the same glyphs as a task. */
  status: BoardStatus;
  /** Plain, present tense: "6 tasks", "3 of 6, 2 subagents working", "tests passed 4m ago". */
  detail?: string;
  /** Spec and Plan only: the file, relative to the repo, that opens in the editor. */
  path?: string;
};

export type FlowInput = {
  plan: BoardSection;
  /** The session's blocks; the newest test run in them feeds Check. */
  blocks?: readonly Block[];
  /** Subagents working right now (the transcript's and the plan's own). */
  subagentsRunning: number;
  now: number;
  /** Ship readiness; the Ship phase is left out without it. */
  ship?: Ship;
  /**
   * Where the plan files live. A spec or plan path that is unsafe to open (`..`, a URL, `~`,
   * or absolute outside this root) is dropped, so its phase renders as plain text.
   */
  planRoot?: string;
};

/** The fix round from which a task counts as struggling (the status card uses the same). */
const STRUGGLING_FROM_ROUND = 3;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function buildStatus(plan: BoardSection): BoardStatus {
  if (plan.total > 0 && plan.done >= plan.total) return "done";
  const open = plan.nodes.filter((n) => n.status !== "done");
  if (open.some((n) => n.status === "blocked")) return "blocked";
  if (open.some((n) => n.status === "attention" || (n.fixRounds ?? 0) >= STRUGGLING_FROM_ROUND)) {
    return "attention";
  }
  if (open.some((n) => n.status === "running")) return "running";
  return plan.done > 0 ? "running" : "pending";
}

function buildDetail(plan: BoardSection, status: BoardStatus, subagentsRunning: number): string | undefined {
  const parts: string[] = [];
  if (status !== "pending") parts.push(`${plan.done} of ${plan.total}`);
  // Only while the build is moving: elsewhere the count is another phase's business (a final
  // review shows in Check) and "N subagents working" next to a pending or done Build misleads.
  if (subagentsRunning > 0 && (status === "running" || status === "attention")) {
    parts.push(`${plural(subagentsRunning, "subagent", "subagents")} working`);
  }
  return parts.length ? parts.join(", ") : undefined;
}

function testPart(run: TestRun, now: number): string {
  if (run.status === "running") return "tests running";
  // An unknown run (piped, so its exit status is the last stage's) is not claimed either way.
  const verdict = run.status === "passed" ? "passed" : run.status === "failed" ? "failed" : "ran";
  if (run.at === undefined) return `tests ${verdict}`;
  return `tests ${verdict} ${formatDuration(Math.max(0, now - run.at), false)} ago`;
}

function finalPart(status: BoardStatus | undefined): string | undefined {
  if (status === "running") return "final review running";
  if (status === "attention") return "final review found issues";
  if (status === "done") return "final review done";
  return undefined;
}

/**
 * failed > running > attention > done > pending. Pending is a fact: nothing has run yet.
 * An unknown test run (see `TestRunStatus`) never decides the status. A finished final
 * review is done on its own: with no test run found, the review is the evidence.
 */
function checkStatus(run: TestRun | undefined, final: BoardStatus | undefined): BoardStatus {
  if (run?.status === "failed") return "failed";
  if (run?.status === "running" || final === "running") return "running";
  if (final === "attention") return "attention";
  if (final === "done") return "done";
  return "pending";
}

/**
 * failed (the tests failed) > done (ready) > pending (nothing started) > attention.
 * Pending is a fact: no task has begun, so there is nothing to ship yet.
 */
function shipStatus(plan: BoardSection, ship: Ship): BoardStatus {
  if (ship.items.some((i) => i.id === "tests" && i.met === false)) return "failed";
  if (ship.ready) return "done";
  const started = plan.done > 0 || plan.nodes.some((n) => n.status !== "pending") || plan.finalReview !== undefined;
  return started ? "attention" : "pending";
}

/**
 * Where the superpowers flow stands: spec, plan, build, check, ship. A phase appears only with
 * evidence on disk or in the transcript, so there is no "unknown" state: with no `Spec:`
 * line in the ledger there is no Spec phase. Pure: `now` is the only clock.
 */
export function deriveFlow({ plan, blocks, subagentsRunning, now, planRoot, ship }: FlowInput): FlowPhase[] {
  const phases: FlowPhase[] = [];
  const openable = (path: string | undefined) =>
    path !== undefined && isSafePlanPath(planRoot, path) ? { path } : {};
  if (plan.specPath) phases.push({ id: "spec", label: "Spec", status: "done", ...openable(plan.specPath) });
  if (plan.planPath) {
    phases.push({
      id: "plan",
      label: "Plan",
      status: "done",
      detail: plural(plan.total, "task", "tasks"),
      ...openable(plan.planPath),
    });
  }
  if (plan.total > 0) {
    const status = buildStatus(plan);
    const detail = buildDetail(plan, status, subagentsRunning);
    phases.push({ id: "build", label: "Build", status, ...(detail ? { detail } : {}) });
  }
  const run = lastTestRun(blocks);
  const final = plan.finalReview?.status;
  const detail = [run ? testPart(run, now) : undefined, finalPart(final)].filter(Boolean).join(", ");
  phases.push({
    id: "check",
    label: "Check",
    status: checkStatus(run, final),
    ...(detail ? { detail } : {}),
  });
  if (ship && plan.total > 0) {
    phases.push({
      id: "ship",
      label: "Ship",
      status: shipStatus(plan, ship),
      detail: ship.ready ? "ready" : `${ship.left} left`,
    });
  }
  return phases;
}
