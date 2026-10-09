import { useMemo } from "react";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import type { Block, Session } from "../../sessions/model/session";
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

/**
 * The Tasks board for the sidebar. It is read even while the tab is closed so the
 * tab badge stays current. `running` says whether the panel's clock should tick.
 */
export function useSidebarTasks(input: Input): { board: TaskBoard; running: boolean } {
  const { cwd, sessions, busySessionIds, approvalSessionIds, activeSessionId, activeSession, visible, remote = false } = input;
  const blocks = activeSession?.blocks;
  const pendingQuestion = activeSession?.pendingQuestion;

  const statusSessions = useMemo<StatusSessionInput[]>(() => {
    if (remote) return NO_SESSIONS;
    const activeTool = latestToolTime(blocks);
    const question = questionLine(activeSession);
    return sessions
      .filter((session) => !session.sidebarHidden)
      .map((session) => {
        const isActive = session.id === activeSessionId;
        const lastActivityAt =
          isActive && activeTool !== undefined ? Math.max(session.updatedAt, activeTool) : session.updatedAt;
        return {
          id: session.id,
          title: session.title,
          busy: busySessionIds.has(session.id),
          needsInput: approvalSessionIds.has(session.id),
          ...(isActive && question ? { question } : {}),
          lastActivityAt,
        };
      });
    // `activeSession` only matters through its blocks and question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, busySessionIds, approvalSessionIds, activeSessionId, blocks, pendingQuestion, remote]);

  const board = useTaskBoard({
    projectCwd: cwd,
    ...(activeSession ? { activeSession } : {}),
    sessions: statusSessions,
    visible: visible && !remote,
  });

  const running =
    statusSessions.some((s) => s.busy) ||
    (board.statusCard.kind !== "idle" && board.statusCard.kind !== "done");
  return { board, running };
}
