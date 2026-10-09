import { useMemo, type ComponentProps } from "react";
import { isRemoteProjectPath } from "../../projects/model/recents";
import type { Session } from "../../sessions/model/session";
import { statusSessionsFromLoaded } from "../hooks/useSidebarTasks";
import { TaskBoardView } from "./TaskBoardView";

type Props = Pick<
  ComponentProps<typeof TaskBoardView>,
  "onAction" | "onOpenNode" | "onOpenPlan" | "onChangeDecision" | "visible"
> & {
  /** The project whose plans the board reads. */
  projectCwd: string;
  sessionId: string;
  sessions: readonly Session[];
};

/** An editor tab's board: finds its session among the loaded ones and its siblings in the project. */
export function TaskBoardSurface({ projectCwd, sessionId, sessions, ...handlers }: Props) {
  const remote = isRemoteProjectPath(projectCwd);
  const session = sessions.find((entry) => entry.id === sessionId);
  const statusSessions = useMemo(
    () => (remote ? [] : statusSessionsFromLoaded(sessions, projectCwd, sessionId)),
    [remote, sessions, projectCwd, sessionId],
  );
  if (remote) {
    return (
      <div className="px-4 pt-3.5 text-[12.5px] text-content/66">
        Task progress is not available for remote projects yet.
      </div>
    );
  }
  return <TaskBoardView projectCwd={projectCwd} session={session} sessions={statusSessions} {...handlers} />;
}
