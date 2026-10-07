import { invoke } from "@tauri-apps/api/core";

/**
 * Asks the backend to watch a project's skill folders. Resolves true only when
 * the backend confirms every folder is covered by a live watcher. Never
 * rejects: false means "not watched", and the catalog then refreshes on a
 * timer instead of on filesystem events.
 */
export async function skillsWatchProject(cwd: string): Promise<boolean> {
  try {
    return (await invoke("skills_watch_project", { cwd })) === true;
  } catch {
    return false;
  }
}
