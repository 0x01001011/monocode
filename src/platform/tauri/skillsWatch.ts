import { invoke } from "@tauri-apps/api/core";

/** Asks the backend to watch a project's skill folders. Best effort: the
 * catalog still works (just without live updates) when this fails. */
export async function skillsWatchProject(cwd: string): Promise<void> {
  try {
    await invoke("skills_watch_project", { cwd });
  } catch {
    // watcher unavailable
  }
}
