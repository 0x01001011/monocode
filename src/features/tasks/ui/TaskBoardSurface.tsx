import { useContext, useMemo, type ComponentProps } from "react";
import { useQuietAfterMinutes } from "../../settings/model/tasksPrefs";
import { isRemoteProjectPath } from "../../projects/model/recents";
import type { Session } from "../../sessions/model/session";
import { statusSessionsFromLoaded } from "../hooks/useSidebarTasks";
import { TaskActionsContext } from "../hooks/useTaskActions";
import { TaskBoardView } from "./TaskBoardView";

type Props = Pick<
  ComponentProps<typeof TaskBoardView>,
  "onAction" | "onOpenNode" | "onOpenPlan" | "onChangeDecision" | "visible"
> & {
  /** The project: its sessions are the board's status inputs. */
  projectCwd: string;
  /** The session's working copy, where its plan workspaces live; defaults to `projectCwd`. */
  planCwd?: string;
  sessionId: string;
  sessions: readonly Session[];
};

/** An editor tab's board: finds its session among the loaded ones and its siblings in the project. */
export function TaskBoardSurface({ projectCwd, planCwd = projectCwd, sessionId, sessions, ...handlers }: Props) {
  const remote = isRemoteProjectPath(projectCwd);
  const quietAfterMinutes = useQuietAfterMinutes();
  const actions = useContext(TaskActionsContext);
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
  // The context's handlers act for this tab's session; props, when given, win.
  const shared: Pick<Props, "onAction" | "onOpenNode" | "onOpenPlan" | "onChangeDecision"> = actions
    ? {
        onAction: actions.onAction,
        onOpenNode: (node, section) => actions.onOpenNode(node, section, sessionId),
        onOpenPlan: actions.onOpenPlan,
        onChangeDecision: (note) => actions.onChangeDecision(note, sessionId),
      }
    : {};
  return (
    <TaskBoardView
      projectCwd={projectCwd}
      planCwd={planCwd}
      session={session}
      sessions={statusSessions}
      quietAfterMs={quietAfterMinutes * 60_000}
      {...shared}
      {...handlers}
    />
  );
}
