import { useMemo } from "react";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import { useQuietAfterMinutes } from "../../settings/model/tasksPrefs";
import { sameProjectPath } from "../../projects/model/recents";
import { sessionNeedsInput, sessionWorkCwd, type Block, type Session } from "../../sessions/model/session";
import { planRootFor } from "../model/planRoot";
import type { StatusSessionInput } from "../model/statusCard";
import { useTaskBoard, type TaskBoard } from "./useTaskBoard";

type Input = {
  cwd: string;
  sessions: readonly SessionSummary[];
  busySessionIds: ReadonlySet<string>;
  approvalSessionIds: ReadonlySet<string>;
  activeSessionId?: string;
  activeSession?: Session;
  /** Every loaded session: their blocks tell how recently they did something. */
  loadedSessions?: readonly Session[];
  /** True while the Tasks tab is the one on screen. */
  visible: boolean;
  /** A remote project: its path is not on this machine, so no plan files are read. */
  remote?: boolean;
};

const NO_SESSIONS: StatusSessionInput[] = [];
/** Tool activity older than the last blocks cannot change how quiet a run looks. */
const RECENT_BLOCKS = 200;

/** The newest tool start or end among the last blocks, if any carries a time. */
function latestToolTime(blocks: readonly Block[] | undefined): number | undefined {
  let latest: number | undefined;
  if (!blocks) return latest;
  for (let i = Math.max(0, blocks.length - RECENT_BLOCKS); i < blocks.length; i++) {
    for (const at of [blocks[i].toolStartedAt, blocks[i].toolEndedAt]) {
      if (at !== undefined && (latest === undefined || at > latest)) latest = at;
    }
  }
  return latest;
}

/** The first non-empty line of the first question, with runs of spaces collapsed. */
function questionLine(session: Session | undefined): string | undefined {
  const prompt = session?.pendingQuestion?.questions[0]?.prompt;
  const line = prompt
    ?.split("\n")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .find(Boolean);
  return line || undefined;
}

/** The few session fields a status input needs; a loaded `Session` fits too. */
type StatusSessionSource = Pick<SessionSummary, "id" | "title" | "sidebarHidden"> & {
  cwd?: string;
  worktreeCwd?: string;
  updatedAt?: number;
};

type StatusSessionsInput = {
  sessions: readonly StatusSessionSource[];
  busySessionIds: ReadonlySet<string>;
  approvalSessionIds: ReadonlySet<string>;
  activeSessionId?: string;
  activeSession?: Session;
  /**
   * Activity times of the loaded sessions (see `loadedActivity`). A session listed here is
   * judged by its blocks, even when the time is unknown; only the others use `updatedAt`,
   * which is not refreshed during a turn.
   */
  activity: ReadonlyMap<string, number | undefined>;
};

/**
 * Activity time for a loaded session: the newest tool time or user-turn start among the
 * last blocks. Unknown (never quiet) while the newest block is streaming text, since a long
 * generation writes no tool times.
 */
function loadedActivityAt(session: Session): number | undefined {
  const blocks = session.blocks;
  const newest = blocks[blocks.length - 1];
  if (newest?.streaming && newest.role !== "tool") return undefined;
  let latest = latestToolTime(blocks);
  for (let i = Math.max(0, blocks.length - RECENT_BLOCKS); i < blocks.length; i++) {
    if (blocks[i].role !== "user") continue;
    for (const at of [blocks[i].startedAt, blocks[i].sentAt]) {
      if (at !== undefined && (latest === undefined || at > latest)) latest = at;
    }
  }
  return latest;
}

/** Activity time per loaded session id. */
export function loadedActivity(sessions: readonly Session[]): Map<string, number | undefined> {
  return new Map(sessions.map((session) => [session.id, loadedActivityAt(session)]));
}

/**
 * The one builder of status inputs, for the sidebar and the Tasks tab: one per visible
 * session. Only the active session carries its question.
 */
export function buildStatusSessions(input: StatusSessionsInput): StatusSessionInput[] {
  const { sessions, busySessionIds, approvalSessionIds, activeSessionId, activeSession, activity } = input;
  const question = questionLine(activeSession);
  return sessions
    .filter((session) => !session.sidebarHidden)
    .map((session) => {
      const lastActivityAt = activity.has(session.id) ? activity.get(session.id) : session.updatedAt;
      return {
        id: session.id,
        title: session.title,
        busy: busySessionIds.has(session.id),
        needsInput: approvalSessionIds.has(session.id),
        ...(session.id === activeSessionId && question ? { question } : {}),
        ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
        ...(session.cwd !== undefined ? { workCwd: sessionWorkCwd({ cwd: session.cwd, worktreeCwd: session.worktreeCwd }) } : {}),
      };
    });
}

/**
 * Status inputs for a project built from loaded sessions alone, for surfaces that do not
 * receive the sidebar's list. A worker's busy or waiting state also marks its lead.
 */
export function statusSessionsFromLoaded(
  sessions: readonly Session[],
  projectCwd: string,
  activeSessionId?: string,
): StatusSessionInput[] {
  const busySessionIds = new Set<string>();
  const approvalSessionIds = new Set<string>();
  for (const session of sessions) {
    if (session.busy) {
      busySessionIds.add(session.id);
      if (session.orchestrationLeadId) busySessionIds.add(session.orchestrationLeadId);
    }
    if (sessionNeedsInput(session)) {
      approvalSessionIds.add(session.id);
      if (session.orchestrationLeadId) approvalSessionIds.add(session.orchestrationLeadId);
    }
  }
  return buildStatusSessions({
    sessions: sessions.filter((session) => !session.ephemeral && sameProjectPath(session.cwd, projectCwd)),
    busySessionIds,
    approvalSessionIds,
    activeSessionId,
    activeSession: sessions.find((session) => session.id === activeSessionId),
    activity: loadedActivity(sessions),
  });
}

/**
 * The Tasks board for the sidebar. It is read even while the tab is closed so the
 * tab badge stays current. `running` says whether the panel's clock should tick.
 */
export function useSidebarTasks(input: Input): { board: TaskBoard; running: boolean } {
  const { cwd, sessions, busySessionIds, approvalSessionIds, activeSessionId, activeSession, loadedSessions, visible, remote = false } = input;
  const pendingQuestion = activeSession?.pendingQuestion;
  const quietAfterMinutes = useQuietAfterMinutes();

  // Streaming changes the loaded sessions all the time; the inputs follow only their activity times.
  const activity = useMemo(() => {
    const live = loadedActivity(loadedSessions ?? []);
    if (activeSession && !live.has(activeSession.id)) live.set(activeSession.id, loadedActivityAt(activeSession));
    return live;
  }, [loadedSessions, activeSession]);
  const activityKey = JSON.stringify([...activity]);

  const statusSessions = useMemo<StatusSessionInput[]>(
    () =>
      remote
        ? NO_SESSIONS
        : buildStatusSessions({ sessions, busySessionIds, approvalSessionIds, activeSessionId, activeSession, activity }),
    // `activeSession` only matters through its question, and `activity` through its times.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, busySessionIds, approvalSessionIds, activeSessionId, activityKey, pendingQuestion, remote],
  );

  const board = useTaskBoard({
    projectCwd: cwd,
    planCwd: planRootFor(cwd, activeSession),
    ...(activeSession ? { activeSession } : {}),
    sessions: statusSessions,
    quietAfterMs: quietAfterMinutes * 60_000,
    visible,
    // A remote project's files are not on this machine: skip only the plan read.
    readPlan: !remote,
  });

  const running =
    statusSessions.some((s) => s.busy) ||
    (board.statusCard.kind !== "idle" && board.statusCard.kind !== "done");
  return { board, running };
}
