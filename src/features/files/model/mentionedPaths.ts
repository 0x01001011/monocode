import {
  resolveWorkspaceFileReference,
  slash,
} from "../../../shared/lib/paths";
import { sameProjectPath } from "../../projects/model/recents";

const PATH_TOKEN = /[A-Za-z0-9_.~@+\-/]+/g;

/**
 * Longer paths a transcript used for `reference`, most recent first.
 *
 * Agents often name a file they wrote by its bare filename in the final
 * message but spell out `dir/sub/file.md` where they created it, and that
 * directory may be gitignored and so absent from the project index. Each
 * match is returned as a full path, on the remote machine when `cwd` is remote.
 */
export function mentionedFilePaths(
  texts: readonly string[],
  reference: string,
  cwd: string,
): string[] {
  const wanted = slash(reference).replace(/^\.\//, "");
  if (!wanted) return [];
  const suffix = `/${wanted}`;
  const found: string[] = [];
  const seen = new Set<string>();
  for (let index = texts.length - 1; index >= 0; index--) {
    const tokens = [...(texts[index].match(PATH_TOKEN) ?? [])].reverse();
    for (const raw of tokens) {
      const token = raw.replace(/[.:]+$/, "");
      if (!token.endsWith(suffix)) continue;
      const path = resolveWorkspaceFileReference(token, cwd)?.path;
      if (!path || seen.has(path)) continue;
      seen.add(path);
      found.push(path);
    }
  }
  return found;
}

type TranscriptSession = {
  cwd: string;
  worktreeCwd?: string;
  blocks: { text: string; tool?: { title?: string; detail?: string } }[];
};

/** Message and tool text of the sessions working in `cwd`, in session order. */
export function transcriptTexts(
  sessions: readonly TranscriptSession[],
  cwd: string,
): string[] {
  return sessions
    .filter((session) =>
      sameProjectPath(session.worktreeCwd || session.cwd, cwd),
    )
    .flatMap((session) =>
      session.blocks.flatMap((block) => [
        block.text,
        block.tool?.title ?? "",
        block.tool?.detail ?? "",
      ]),
    );
}
