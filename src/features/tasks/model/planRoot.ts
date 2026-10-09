import { sameProjectPath } from "../../projects/model/recents";
import { sessionWorkCwd } from "../../sessions/model/session";

const isAbsolute = (path: string): boolean => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);

/**
 * Where a session's plan workspaces (`.superpowers/sdd/`) live: the controller writes them
 * inside its working copy, so a worktree session reads its worktree. Without a session of
 * this project, the project itself.
 */
export function planRootFor(projectCwd: string, session?: { cwd: string; worktreeCwd?: string }): string {
  if (!session || !sameProjectPath(session.cwd, projectCwd)) return projectCwd;
  return sessionWorkCwd(session);
}

/** A ledger's plan path resolved against the plan root it was read from. */
export function planFilePath(planRoot: string, planPath: string): string {
  return isAbsolute(planPath) ? planPath : `${planRoot.replace(/[\\/]+$/, "")}/${planPath}`;
}
