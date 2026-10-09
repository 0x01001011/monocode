import { useMemo } from "react";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import { useQuietAfterMinutes } from "../../settings/model/tasksPrefs";
import { sameProjectPath } from "../../projects/model/recents";
import { sessionNeedsInput, type Block, type Session } from "../../sessions/model/session";
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
  /** True while the Tasks tab is the one on screen. */
  visible: boolean;
  /** A remote project: its path is not on this machine, so the board stays idle. */
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
  updatedAt?: number;
  blocks?: readonly Block[];
};

type StatusSessionsInput = {
  sessions: readonly StatusSessionSource[];
  busySessionIds: ReadonlySet<string>;
  approvalSessionIds: ReadonlySet<string>;
  activeSessionId?: string;
  activeSession?: Session;
};

/**
 * One status input per visible session. Only the active session carries its question
 * and its newest tool time; the sidebar and the Tasks tab both build their board from this.
 */
export function buildStatusSessions(input: StatusSessionsInput): StatusSessionInput[] {
  const { sessions, busySessionIds, approvalSessionIds, activeSessionId, activeSession } = input;
  const activeTool = latestToolTime(activeSession?.blocks);
  const question = questionLine(activeSession);
  return sessions
    .filter((session) => !session.sidebarHidden)
    .map((session) => {
      const isActive = session.id === activeSessionId;
      const times = [session.updatedAt, isActive ? activeTool : latestToolTime(session.blocks)].filter(
        (at): at is number => at !== undefined,
      );
      return {
        id: session.id,
        title: session.title,
        busy: busySessionIds.has(session.id),
        needsInput: approvalSessionIds.has(session.id),
        ...(isActive && question ? { question } : {}),
        ...(times.length ? { lastActivityAt: Math.max(...times) } : {}),
      };
    });
}

/**
 * Activity time for a loaded session, which has no `updatedAt`: the newest tool time or
 * user-turn start among the last blocks. Unknown (never quiet) while the newest block is
 * streaming text, since a long generation writes no tool times.
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
  const here = sessions.filter((session) => !session.ephemeral && sameProjectPath(session.cwd, projectCwd));
  const byId = new Map(here.map((session) => [session.id, session]));
  return buildStatusSessions({
    sessions: here.map(({ id, title, sidebarHidden }) => ({ id, title, sidebarHidden })),
    busySessionIds,
    approvalSessionIds,
    activeSessionId,
    activeSession: sessions.find((session) => session.id === activeSessionId),
  }).map(({ lastActivityAt: _sidebarClock, ...input }) => {
    const at = loadedActivityAt(byId.get(input.id) as Session);
    return at === undefined ? input : { ...input, lastActivityAt: at };
  });
}

/**
 * The Tasks board for the sidebar. It is read even while the tab is closed so the
 * tab badge stays current. `running` says whether the panel's clock should tick.
 */
export function useSidebarTasks(input: Input): { board: TaskBoard; running: boolean } {
  const { cwd, sessions, busySessionIds, approvalSessionIds, activeSessionId, activeSession, visible, remote = false } = input;
  const blocks = activeSession?.blocks;
  const pendingQuestion = activeSession?.pendingQuestion;
  const quietAfterMinutes = useQuietAfterMinutes();

  const statusSessions = useMemo<StatusSessionInput[]>(
    () =>
      remote
        ? NO_SESSIONS
        : buildStatusSessions({ sessions, busySessionIds, approvalSessionIds, activeSessionId, activeSession }),
    // `activeSession` only matters through its blocks and question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, busySessionIds, approvalSessionIds, activeSessionId, blocks, pendingQuestion, remote],
  );

  const board = useTaskBoard({
    projectCwd: cwd,
    planCwd: planRootFor(cwd, activeSession),
    ...(activeSession ? { activeSession } : {}),
    sessions: statusSessions,
    quietAfterMs: quietAfterMinutes * 60_000,
    visible: visible && !remote,
  });

  const running =
    statusSessions.some((s) => s.busy) ||
    (board.statusCard.kind !== "idle" && board.statusCard.kind !== "done");
  return { board, running };
}
