import { formatDuration } from "./duration";
import type { BoardNode, BoardSection } from "./taskBoard";

export type StatusKind = "needs-you" | "struggling" | "quiet" | "running" | "done" | "idle";
export type StatusAction =
  | "answer-in-session"
  | "remind-later"
  | "see-issues"
  | "open-reviewer"
  | "keep-waiting"
  | "stop-after-task"
  | "open-session"
  | "review-decisions";
export type StatusSessionInput = {
  id: string;
  title: string;
  busy: boolean;
  needsInput: boolean;
  question?: string;
  askedAt?: number;
  lastActivityAt?: number;
  /** The session's working copy (its worktree, else the project); the plan's owners work there. */
  workCwd?: string;
};
export type StatusCard = {
  kind: StatusKind;
  sessionId?: string;
  /** Title of `sessionId`'s session, for button labels. */
  sessionTitle?: string;
  headline: string;
  detail?: string;
  reassurance?: string;
  actions: StatusAction[];
  since?: number;
  others?: { count: number; kind: StatusKind; text: string };
};
export type StatusCardInput = {
  sessions: StatusSessionInput[];
  activeSessionId?: string;
  plan?: BoardSection;
  /**
   * Sessions whose working copy is the plan's workspace root: only they can run the plan.
   * The active session is not assumed to own it.
   */
  planOwnerIds?: readonly string[];
  now: number;
  quietAfterMs: number;
};

const MINUTE_MS = 60_000;
const STRUGGLING_FROM_ROUND = 3;
const MAX_FIX_ROUNDS = 5;

/** Whole minutes, at least one: a quiet or waiting time never reads "<1m". */
const wholeMinutes = (ms: number): string => formatDuration(Math.max(1, Math.floor(ms / MINUTE_MS)) * MINUTE_MS, false);
const FINAL_REVIEW_ID = "final-review";
/** "Task 6", "the final review", else the node's title; capitalize at the start of a sentence. */
const taskLabel = (node: BoardNode): string =>
  node.index !== undefined ? `Task ${node.index}` : node.id === FINAL_REVIEW_ID ? "the final review" : node.title;
const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The session running the plan: a busy owner (the active one first), else the only owner.
 * Undefined when no owner is known or several idle ones leave it ambiguous.
 */
function planOwner(input: StatusCardInput): StatusSessionInput | undefined {
  const ids = new Set(input.planOwnerIds ?? []);
  const owners = input.sessions.filter((s) => ids.has(s.id));
  const busy = owners.filter((s) => s.busy);
  if (busy.length > 0) return busy.find((s) => s.id === input.activeSessionId) ?? busy[0];
  return owners.length === 1 ? owners[0] : undefined;
}

/** Milliseconds a busy session has been silent; undefined when not busy or unknown. */
function quietFor(s: StatusSessionInput, input: StatusCardInput): number | undefined {
  if (!s.busy || s.needsInput || s.lastActivityAt === undefined) return undefined;
  const idle = input.now - s.lastActivityAt;
  return idle >= input.quietAfterMs ? idle : undefined;
}

/** The busy session that has been silent longest, if any crossed the threshold. */
function quietest(sessions: StatusSessionInput[], input: StatusCardInput): { session: StatusSessionInput; idle: number } | undefined {
  let best: { session: StatusSessionInput; idle: number } | undefined;
  for (const session of sessions) {
    const idle = quietFor(session, input);
    if (idle !== undefined && (!best || idle > best.idle)) best = { session, idle };
  }
  return best;
}

/** The active session first, then the longest-waiting one. */
function pickWaiting(sessions: StatusSessionInput[], activeId?: string): StatusSessionInput | undefined {
  const waiting = sessions.filter((s) => s.needsInput);
  return (
    waiting.find((s) => s.id === activeId) ??
    waiting.reduce<StatusSessionInput | undefined>(
      (best, s) => (!best || (s.askedAt ?? Infinity) < (best.askedAt ?? Infinity) ? s : best),
      undefined,
    )
  );
}

const IN_PROGRESS: ReadonlySet<BoardNode["status"]> = new Set(["running", "attention", "blocked"]);

/** The task the plan is at: the first unfinished one in progress, else an unfinished final review. */
function currentNode(plan?: BoardSection): BoardNode | undefined {
  if (!plan) return undefined;
  const task = plan.nodes.find((n) => IN_PROGRESS.has(n.status));
  if (task) return task;
  const final = plan.finalReview;
  return final && (final.status === "running" || final.status === "attention") ? final : undefined;
}

function strugglingNode(plan?: BoardSection): BoardNode | undefined {
  let worst: BoardNode | undefined;
  for (const n of plan?.nodes ?? []) {
    if (n.status !== "attention" || (n.fixRounds ?? 0) < STRUGGLING_FROM_ROUND) continue;
    if (!worst || (n.fixRounds ?? 0) > (worst.fixRounds ?? 0)) worst = n;
  }
  return worst;
}

function finishedAt(plan: BoardSection): number | undefined {
  const ends = [...plan.nodes, ...(plan.finalReview ? [plan.finalReview] : [])]
    .map((n) => n.endedAt)
    .filter((t): t is number => t !== undefined);
  return ends.length > 0 ? Math.max(...ends) : undefined;
}

/** Runs apart from the one the card already names (compared by id). */
function summarizeOthers(input: StatusCardInput, namedId: string | undefined): StatusCard["others"] {
  const others = input.sessions.filter((s) => s.id !== namedId && (s.busy || s.needsInput));
  if (others.length === 0) return undefined;
  const count = plural(others.length, "other run", "other runs");
  const waiting = pickWaiting(others, undefined);
  if (waiting) return { count: others.length, kind: "needs-you", text: `${count} · ${waiting.title} needs you` };
  const quiet = quietest(others, input);
  if (quiet) {
    return { count: others.length, kind: "quiet", text: `${count} · ${quiet.session.title} quiet ${wholeMinutes(quiet.idle)}` };
  }
  return { count: others.length, kind: "running", text: count };
}

function needsYou(waiting: StatusSessionInput, input: StatusCardInput, owner: StatusSessionInput | undefined): StatusCard {
  const isActive = waiting.id === input.activeSessionId;
  // Only the plan's owner is working through the plan, so only its question can name the task.
  const node = waiting.id === owner?.id ? currentNode(input.plan) : undefined;
  let detail: string | undefined;
  if (waiting.question) {
    const who = node ? `${capitalize(taskLabel(node))} asks` : "The agent asks";
    const age =
      waiting.askedAt === undefined
        ? ""
        : input.now - waiting.askedAt < MINUTE_MS
          ? " · just now"
          : ` · ${wholeMinutes(input.now - waiting.askedAt)} ago`;
    detail = `${who}: “${waiting.question}”${age}`;
  }
  return {
    kind: "needs-you",
    sessionId: waiting.id,
    headline: isActive ? "This session is waiting for your answer" : `${waiting.title} is waiting for your answer`,
    ...(detail ? { detail } : {}),
    actions: ["answer-in-session", "remind-later"],
    ...(waiting.askedAt !== undefined ? { since: waiting.askedAt } : {}),
  };
}

/** A plan that cannot go on by itself: a blocked task, or its owner stopped mid-plan. */
function planStopped(node: BoardNode, headline: string, owner: StatusSessionInput | undefined): StatusCard {
  return {
    kind: "needs-you",
    ...(owner ? { sessionId: owner.id } : {}),
    headline,
    detail: node.title,
    // With no single owner, opening "the" session would be a guess.
    actions: owner ? ["open-session"] : [],
  };
}

function running(node: BoardNode | undefined, session: StatusSessionInput, input: StatusCardInput): StatusCard {
  const lastStage = node?.stages?.[node.stages.length - 1];
  const reviewing = lastStage?.kind === "review" || lastStage?.kind === "final-review";
  const headline = !node
    ? "The agent is working"
    : reviewing
      ? `A reviewer is checking ${taskLabel(node)}`
      : `The agent is working on ${taskLabel(node)}`;
  const soFar = node?.startedAt !== undefined ? ` · ${formatDuration(input.now - node.startedAt, true)} so far` : "";
  return {
    kind: "running",
    sessionId: session.id,
    headline,
    ...(node ? { detail: `${node.title}${soFar}` } : {}),
    reassurance: "Nothing needs you",
    actions: ["stop-after-task", "open-session"],
    ...(node?.startedAt !== undefined ? { since: node.startedAt } : {}),
  };
}

function core(input: StatusCardInput): StatusCard {
  const owner = planOwner(input);
  const plan = input.plan;
  const current = currentNode(plan);

  const waiting = pickWaiting(input.sessions, input.activeSessionId);
  if (waiting) return needsYou(waiting, input, owner);

  const blocked = plan?.nodes.find((n) => n.status === "blocked");
  if (blocked) return planStopped(blocked, `${capitalize(taskLabel(blocked))} is blocked`, owner);
  if (current && owner && !owner.busy) return planStopped(current, `The plan stopped at ${taskLabel(current)}`, owner);

  const stuck = owner?.busy ? strugglingNode(plan) : undefined;
  if (stuck && owner) {
    const rounds = Math.min(stuck.fixRounds ?? STRUGGLING_FROM_ROUND, MAX_FIX_ROUNDS);
    return {
      kind: "struggling",
      sessionId: owner.id,
      headline: `${capitalize(taskLabel(stuck))} is on fix round ${rounds} of ${MAX_FIX_ROUNDS}`,
      detail: `The reviewer has sent it back ${rounds} times. If round ${MAX_FIX_ROUNDS} fails, it stops and asks you.`,
      actions: ["see-issues"],
      ...(stuck.startedAt !== undefined ? { since: stuck.startedAt } : {}),
    };
  }

  const quiet = quietest(input.sessions, input);
  if (quiet) {
    const node = quiet.session.id === owner?.id ? current : undefined;
    const stage = node?.stages?.[node.stages.length - 1];
    const reviewing = stage?.status === "running" && (stage.kind === "review" || stage.kind === "final-review");
    // The headline is a live region: minutes go in the detail so it is not re-announced each minute.
    return {
      kind: "quiet",
      sessionId: quiet.session.id,
      headline: `No activity on ${node ? taskLabel(node) : quiet.session.title}`,
      detail: `Quiet for ${wholeMinutes(quiet.idle)}.`,
      actions: [reviewing ? "open-reviewer" : "open-session", "keep-waiting"],
      ...(quiet.session.lastActivityAt !== undefined ? { since: quiet.session.lastActivityAt } : {}),
    };
  }

  // The plan runs only while an owner is busy; any other busy session runs its own work.
  if (owner?.busy) return running(current, owner, input);
  const busy = input.sessions.find((s) => s.id === input.activeSessionId && s.busy) ?? input.sessions.find((s) => s.busy);
  if (busy) return running(undefined, busy, input);

  if (plan && plan.total > 0 && plan.done === plan.total && !current) {
    const end = finishedAt(plan);
    const took = plan.startedAt !== undefined && end !== undefined ? ` in ${formatDuration(end - plan.startedAt, false)}` : "";
    const decisions = plan.decisions?.length ?? 0;
    return {
      kind: "done",
      ...(owner ? { sessionId: owner.id } : {}),
      headline: `Plan finished${took}`,
      ...(decisions > 0 ? { detail: `${plural(decisions, "decision", "decisions")} to look over` } : {}),
      actions: ["review-decisions"],
      ...(end !== undefined ? { since: end } : {}),
    };
  }

  return { kind: "idle", headline: "", actions: [] };
}

/** One card for the sidebar and the full tab, covering every session in the project. */
export function deriveStatusCard(input: StatusCardInput): StatusCard {
  const base = core(input);
  const title = input.sessions.find((s) => s.id === base.sessionId)?.title;
  const card = title !== undefined ? { ...base, sessionTitle: title } : base;
  const others = summarizeOthers(input, card.sessionId ?? input.activeSessionId);
  return others ? { ...card, others } : card;
}

export function tabBadge(card: StatusCard): "ask" | "fail" | "quiet" | undefined {
  if (card.kind === "needs-you") return "ask";
  if (card.kind === "struggling") return "fail";
  if (card.kind === "quiet") return "quiet";
  return undefined;
}
