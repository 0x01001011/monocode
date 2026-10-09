import { listDir, readTextFile, statFiles } from "../../../platform/tauri/fs";
import type { SddFs } from "./sddWorkspace";

/**
 * The real filesystem behind the SDD workspace reader. `listDir` of a missing
 * directory rejects; `findSddWorkspaces` already treats that as "no workspaces".
 */
export const tauriSddFs: SddFs = {
  async listDir(path) {
    const entries = await listDir(path);
    return entries.map(({ name, path: entryPath, isDir }) => ({ name, path: entryPath, isDir }));
  },
  readText: readTextFile,
  async statMtimes(paths) {
    const stats = await statFiles(paths);
    return stats.map(({ path, mtimeMs }) => ({ path, mtimeMs }));
  },
};
