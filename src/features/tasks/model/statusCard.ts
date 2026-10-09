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
  now: number;
  quietAfterMs: number;
};

const MINUTE_MS = 60_000;
const STRUGGLING_FROM_ROUND = 3;
const MAX_FIX_ROUNDS = 5;

const wholeMinutes = (ms: number): string => formatDuration(Math.floor(ms / MINUTE_MS) * MINUTE_MS, false);
const taskLabel = (node: BoardNode): string => (node.index !== undefined ? `Task ${node.index}` : node.title);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

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

function runningNode(plan?: BoardSection): BoardNode | undefined {
  if (!plan) return undefined;
  return plan.nodes.find((n) => n.status === "running") ?? (plan.finalReview?.status === "running" ? plan.finalReview : undefined);
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

function needsYou(waiting: StatusSessionInput, input: StatusCardInput): StatusCard {
  const isActive = waiting.id === input.activeSessionId;
  // The plan belongs to the active session, so only it can name the task.
  const node = isActive ? runningNode(input.plan) : undefined;
  let detail: string | undefined;
  if (waiting.question) {
    const who = node ? `${taskLabel(node)} asks` : "The agent asks";
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

function running(node: BoardNode | undefined, input: StatusCardInput): StatusCard {
  // The plan belongs to the active session, so a running node means it is the one working.
  const busy =
    node && input.activeSessionId
      ? undefined
      : (input.sessions.find((s) => s.id === input.activeSessionId && s.busy) ?? input.sessions.find((s) => s.busy));
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
    ...(busy ? { sessionId: busy.id } : input.activeSessionId ? { sessionId: input.activeSessionId } : {}),
    headline,
    ...(node ? { detail: `${node.title}${soFar}` } : {}),
    reassurance: "Nothing needs you",
    actions: ["stop-after-task", "open-session"],
    ...(node?.startedAt !== undefined ? { since: node.startedAt } : {}),
  };
}

function core(input: StatusCardInput): StatusCard {
  const waiting = pickWaiting(input.sessions, input.activeSessionId);
  if (waiting) return needsYou(waiting, input);

  const stuck = strugglingNode(input.plan);
  if (stuck) {
    const rounds = stuck.fixRounds ?? STRUGGLING_FROM_ROUND;
    return {
      kind: "struggling",
      ...(input.activeSessionId ? { sessionId: input.activeSessionId } : {}),
      headline: `${taskLabel(stuck)} is on fix round ${rounds} of ${MAX_FIX_ROUNDS}`,
      detail: `The reviewer has sent it back ${rounds} times. If round ${MAX_FIX_ROUNDS} fails, it stops and asks you.`,
      actions: ["see-issues"],
      ...(stuck.startedAt !== undefined ? { since: stuck.startedAt } : {}),
    };
  }

  const node = runningNode(input.plan);
  const quiet = quietest(input.sessions, input);
  if (quiet) {
    const target = quiet.session.id === input.activeSessionId && node ? taskLabel(node) : quiet.session.title;
    return {
      kind: "quiet",
      sessionId: quiet.session.id,
      headline: `No activity on ${target} for ${wholeMinutes(quiet.idle)}`,
      actions: ["open-reviewer", "keep-waiting"],
      ...(quiet.session.lastActivityAt !== undefined ? { since: quiet.session.lastActivityAt } : {}),
    };
  }

  if (node || input.sessions.some((s) => s.busy)) return running(node, input);

  const plan = input.plan;
  if (plan && plan.total > 0 && plan.done === plan.total) {
    const end = finishedAt(plan);
    const took = plan.startedAt !== undefined && end !== undefined ? ` in ${formatDuration(end - plan.startedAt, false)}` : "";
    const decisions = plan.decisions?.length ?? 0;
    return {
      kind: "done",
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
