import type { StatusAction, StatusCard } from "./statusCard";
import type { BoardNode, BoardNote, BoardSection } from "./taskBoard";

export type TaskActionEffect =
  | { kind: "select-session"; sessionId: string }
  | { kind: "queue-message"; sessionId: string; text: string }
  | { kind: "prefill-composer"; sessionId: string; text: string }
  | { kind: "snooze"; sessionId: string; ms: number }
  | { kind: "remind"; sessionId: string; ms: number }
  | { kind: "open-file"; path: string }
  | { kind: "open-commit"; range: string }
  | { kind: "scroll-transcript"; sessionId: string; blockId: string }
  | { kind: "none" };

/** Sent to a running session; the agent finishes the task in hand, so no turn is cut short. */
export const STOP_AFTER_TASK_TEXT = "Stop after the current task and summarize where you are.";

const NONE: TaskActionEffect = { kind: "none" };
const SNOOZE_MS = 10 * 60_000;

/** What a status card button does. Local-only buttons (`see-issues`, `review-decisions`) map to `none`. */
export function effectForAction(
  action: StatusAction,
  card: StatusCard,
  ctx: { activeSessionId?: string },
): TaskActionEffect {
  const sessionId = card.sessionId ?? ctx.activeSessionId;
  switch (action) {
    case "answer-in-session":
    case "open-session":
    case "open-reviewer":
      return sessionId ? { kind: "select-session", sessionId } : NONE;
    case "stop-after-task":
      return sessionId ? { kind: "queue-message", sessionId, text: STOP_AFTER_TASK_TEXT } : NONE;
    case "remind-later":
      return sessionId ? { kind: "remind", sessionId, ms: SNOOZE_MS } : NONE;
    case "keep-waiting":
      return sessionId ? { kind: "snooze", sessionId, ms: SNOOZE_MS } : NONE;
    case "see-issues":
    case "review-decisions":
      return NONE;
  }
}

const isAbsolute = (path: string): boolean => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
const join = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, "")}/${name}`;

/** What opening a row's link does. Relative file names resolve against the plan folder, else the project. */
export function effectForNode(
  node: BoardNode,
  _section: BoardSection,
  ctx: { projectCwd: string; sddDir?: string; sessionId?: string },
): TaskActionEffect {
  const target = node.target;
  if (!target) return NONE;
  switch (target.kind) {
    case "report":
    case "brief":
    case "review":
      if (!target.ref) return NONE;
      return { kind: "open-file", path: isAbsolute(target.ref) ? target.ref : join(ctx.sddDir ?? ctx.projectCwd, target.ref) };
    case "transcript":
      return ctx.sessionId && target.ref ? { kind: "scroll-transcript", sessionId: ctx.sessionId, blockId: target.ref } : NONE;
    case "session":
      return target.ref ? { kind: "select-session", sessionId: target.ref } : NONE;
    case "commit":
      return target.ref ? { kind: "open-commit", range: target.ref } : NONE;
  }
}

/** The composer text for "Change this" on a decision. */
export function changeDecisionText(note: BoardNote): string {
  const about = note.taskIndex !== undefined ? `Task ${note.taskIndex}` : undefined;
  return `About your decision${about ? ` on ${about}` : ""}: ${note.text}`;
}
