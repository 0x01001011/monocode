import { invoke } from "@tauri-apps/api/core";
import { parseRemotePath } from "../../connections/model/remoteProjects";
import { isRemoteProjectPath } from "../../projects/model/recents";
import type { ExternalEditor } from "../../../platform/tauri/fs";

export type EditorOpenOptions = {
  /** `path` is a file, opened at `line` and `column` when given. */
  isFile?: boolean;
  /** Folder to open the editor in for a local file. */
  projectCwd?: string;
  line?: number;
  column?: number;
};

export type EditorRequest = {
  command: string;
  args: Record<string, unknown>;
};

const LAST_EDITOR_KEY = "monocode.last-external-editor";

/**
 * The Tauri command and arguments for opening `path` in an editor. A remote
 * path becomes machine plus host path, never a `remote://` string: those are
 * routed to the remote host, which cannot launch an editor on this machine.
 */
export function editorRequest(
  editorId: string,
  path: string,
  options: EditorOpenOptions = {},
): EditorRequest {
  const line = options.line ?? null;
  const column = options.column ?? null;
  if (isRemoteProjectPath(path)) {
    const remote = parseRemotePath(path);
    if (!remote) throw new Error("This remote path has no machine or folder.");
    return {
      command: "open_remote_in_external_editor",
      args: {
        editorId,
        environmentId: remote.environmentId,
        hostPath: remote.hostPath,
        kind: options.isFile ? "file" : "folder",
        line,
        column,
      },
    };
  }
  if (!options.isFile)
    return {
      command: "open_in_external_editor",
      args: { editorId, cwd: path, file: null, line: null, column: null },
    };
  return {
    command: "open_in_external_editor",
    args: {
      editorId,
      cwd: options.projectCwd ?? (path.replace(/[\\/][^\\/]*$/, "") || "/"),
      file: path,
      line,
      column,
    },
  };
}

export function openInEditor(
  editorId: string,
  path: string,
  options?: EditorOpenOptions,
): Promise<void> {
  const { command, args } = editorRequest(editorId, path, options);
  return invoke<void>(command, args);
}

/** Editors able to open `path`; a remote project needs remote support. */
export function editorsFor(
  editors: readonly ExternalEditor[],
  path: string,
): ExternalEditor[] {
  return isRemoteProjectPath(path)
    ? editors.filter((editor) => editor.remote)
    : [...editors];
}

export function lastEditorId(): string | null {
  try {
    return localStorage.getItem(LAST_EDITOR_KEY);
  } catch {
    return null;
  }
}

export function rememberEditor(id: string) {
  try {
    localStorage.setItem(LAST_EDITOR_KEY, id);
  } catch {
    /* a private window may refuse storage; the choice just is not kept */
  }
}
