import { statFiles } from "../../../platform/tauri/fs";
import { joinPath, pathKey, slash } from "../../../shared/lib/paths";
import { listWorktrees } from "../../source-control/model/worktrees";

/**
 * Where a file that is missing from `cwd` still exists in the project's other
 * checkouts, at the same path relative to the checkout. A report an agent wrote
 * in one worktree is often looked for in another, or in the main folder.
 * Empty when the path is not inside `cwd` or the checkouts cannot be read.
 */
export type MovedFile = { path: string; checkout: string };

export async function findInOtherCheckouts(
  path: string,
  cwd: string,
): Promise<MovedFile[]> {
  const base = slash(cwd).replace(/\/+$/, "");
  const target = slash(path);
  if (!base || !target.startsWith(`${base}/`)) return [];
  const relative = target.slice(base.length + 1);
  try {
    const { worktrees } = await listWorktrees(cwd);
    const candidates = worktrees
      .filter((tree) => !tree.missing && !tree.prunable)
      .filter((tree) => pathKey(tree.path) !== pathKey(cwd))
      .map((tree) => ({ path: joinPath(tree.path, relative), checkout: tree.path }));
    if (candidates.length === 0) return [];
    const stats = await statFiles(candidates.map((candidate) => candidate.path));
    return candidates.filter((_, index) => stats[index]?.mtimeMs != null);
  } catch {
    return [];
  }
}
