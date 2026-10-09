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

const slashed = (path: string): string => path.replace(/\\/g, "/");
const trimEnd = (path: string): string => path.replace(/\/+$/, "");

/**
 * A path a ledger names (the plan or the spec) is safe to open when it stays inside the plan
 * root: no `..` segment, no `scheme://`, no leading `~`, and an absolute path only when it
 * lies inside `planRoot`. A relative path is resolved against the root, so it is inside by
 * construction once it has no `..`.
 */
export function isSafePlanPath(planRoot: string | undefined, path: string): boolean {
  const text = path.trim();
  if (!text || text.includes("\0") || text.startsWith("~") || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) return false;
  const normal = slashed(text);
  if (normal.split("/").includes("..")) return false;
  if (!isAbsolute(text)) return true;
  if (planRoot === undefined) return false;
  const root = trimEnd(slashed(planRoot));
  if (!root) return false;
  const windows = /^[A-Za-z]:/.test(root);
  const [a, b] = windows ? [normal.toLowerCase(), root.toLowerCase()] : [normal, root];
  return a.startsWith(`${b}/`);
}

/**
 * A ledger's plan path resolved against the plan root it was read from; undefined when the
 * path is not safe to open (see `isSafePlanPath`).
 */
export function planFilePath(planRoot: string, planPath: string): string | undefined {
  if (!isSafePlanPath(planRoot, planPath)) return undefined;
  return isAbsolute(planPath) ? planPath : `${planRoot.replace(/[\\/]+$/, "")}/${planPath}`;
}
