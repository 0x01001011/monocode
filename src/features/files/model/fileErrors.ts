export type FileErrorKind =
  | "not-found"
  | "no-permission"
  | "too-large"
  | "binary"
  | "outside-project"
  | "unreachable"
  | "timeout"
  | "other";

export type FileErrorInfo = {
  kind: FileErrorKind;
  /** What happened and what to do, in words; empty when the raw message says it. */
  hint: string;
  /** The underlying message without transport tags. */
  detail: string;
};

const TAG = /^\[ssh:[a-z-]+\]\s*/;

// Most specific first. Matches the wording of fs.rs, the host and the ssh layer.
const RULES: [RegExp, FileErrorKind, string][] = [
  [
    /enoent|no such file|not found|os error 2\b|cannot find the (file|path)/i,
    "not-found",
    "This file isn’t here any more. It may have been moved, renamed or deleted, or it belongs to another worktree or machine.",
  ],
  [
    /eacces|eperm|permission denied|os error 13\b|access is denied/i,
    "no-permission",
    "You don’t have permission to read this file. Check its permissions on the machine that holds it.",
  ],
  [
    /too large/i,
    "too-large",
    "This file is too big to open in the editor. View it in the terminal or an external editor.",
  ],
  [
    /binary file|not valid utf-?8/i,
    "binary",
    "This file isn’t plain text, so it can’t be edited here.",
  ],
  [
    /outside the|outside of|not allowed/i,
    "outside-project",
    "This path is outside the project and its worktrees, so it can’t be opened here.",
  ],
  [
    /machine is unreachable|connection refused|\[ssh:refused\]/i,
    "unreachable",
    "The machine can’t be reached. Reconnect it in Settings, then retry.",
  ],
  [
    /did not complete|timed out|\[ssh:timeout\]/i,
    "timeout",
    "The machine took too long to answer. Retry; if it keeps happening, check the connection.",
  ],
];

/** Explain a failed file open or read in terms of what the person can do next. */
export function describeFileError(raw: unknown): FileErrorInfo {
  const text = raw instanceof Error ? raw.message : String(raw ?? "");
  const detail = text.replace(TAG, "").trim();
  for (const [pattern, kind, hint] of RULES) {
    if (pattern.test(text)) return { kind, hint, detail };
  }
  return { kind: "other", hint: "", detail };
}
