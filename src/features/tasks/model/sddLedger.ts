export type LedgerFix = {
  round: number;
  state: "dispatched" | "done";
  addressed?: number;
  open?: number;
  commits?: string;
  /** `FIX_BASE=<sha>` from the dispatch line: the re-review package starts here. */
  base?: string;
  /** `fix round R/5 implemented (<sha>)`: the fix is in and its re-review is pending. */
  implementedSha?: string;
};

export type LedgerTask = {
  n: number;
  /** `verdict` is absent until the review returns (`review pending`, or no review part yet). */
  implemented?: { sha?: string; verdict?: string };
  fixes: LedgerFix[];
  /** `clean` means nothing was parked; `reviewClean` that the line says `review clean`. */
  complete?: { commits?: string; clean: boolean; parked: number; reviewClean: boolean };
};

export type LedgerNote = { taskIndex?: number; text: string };

export type ParsedLedger = {
  planPath?: string;
  /** The first repo-style file path (.md, .mdx, .txt) of the first `Spec:` line that has one (the design the plan implements). */
  specPath?: string;
  tasks: LedgerTask[];
  rulings: LedgerNote[];
  minors: LedgerNote[];
  parked: LedgerNote[];
  final: { review?: string; fixWave?: "dispatched" | "complete" };
};

export type BriefInfo = { title?: string; steps: string[] };

export type ReportStatus =
  "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED";

const HEADER = /^#\s*SDD ledger\s*[—–-]+\s*plan:\s*(.+?)\s*$/;
const SPEC_LINE = /^Spec:\s*(.*)$/;
const TASK_LINE = /^Task\s+(\d+):\s*(.*)$/;
const RULING = /\bRuling\b[^:]*:\s*(.*)$/;
const LEADING_RULING = /^Ruling\b/;
// `implemented (sha)`, optionally followed by `; review: <verdict>` or `; review pending`.
// The sha is the first token inside the parentheses; a note may follow it.
const IMPLEMENTED =
  /^implemented\s*\(\s*([^)\s,;]+)[^)]*\)(?:\s*;\s*review(?::\s*(.*)|\s+pending\b.*))?/;
const REVIEW = /^review:\s*(.+)$/;
const FIX_DISPATCHED = /^fix round\s+(\d+)\/\d+\s+dispatched/;
const FIX_IMPLEMENTED = /^fix round\s+(\d+)\/\d+\s+implemented\s*\(\s*([0-9a-f]{4,40})/;
const FIX_BASE = /\bFIX_BASE=([0-9a-f]{4,40})/;
// Finding one-liners may hold parentheses, so the rest runs to the end of the line.
const FIX_DONE = /^fix round\s+(\d+)\/\d+\s*\((\d+)\s+addressed,\s*(\d+)\s+open\b(.*)$/;
const ALL_COMMITS = /commits\s+([^\s,;)]+)/g;
const MINOR = /^minor\b[^:]*:\s*(.*)$/;
const PARKED = /^parked\s*[—–-]+\s*(.*)$/;
const COMPLETE = /^complete\b\s*(.*)$/;
const COMMITS = /commits\s+([^\s,;)]+)/;
const FINAL_REVIEW = /^FINAL REVIEW\b\s*(.*)$/;
const FINAL_WAVE = /^Final fix wave:\s*(complete|dispatched)\b/i;

const SPEC_EXT = /\.(?:md|mdx|txt)$/i;
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * A repo-style file path from one token: surrounding punctuation, backticks and quotes, a
 * `#fragment` and a `:line` suffix are dropped; what is left must end in .md, .mdx or .txt.
 * A URL is not a repo path, and a Windows drive path counts only when it is a .md file.
 */
function specFileOf(raw: string): string | undefined {
  let token = raw.trim().replace(/^[`'"*_<[({]+/, "").replace(/[`'"*_>\])},.;:]+$/, "");
  if (URL_SCHEME.test(token)) return undefined;
  for (let i = 0; i < 2; i++) {
    token = token.replace(/#[^#]*$/, "").replace(/(?::\d+){1,2}$/, "");
  }
  token = token.replace(/[`'"*_>\])},.;:]+$/, "");
  if (!SPEC_EXT.test(token)) return undefined;
  if (DRIVE_PATH.test(token) && !/\.md$/i.test(token)) return undefined;
  return token;
}

/**
 * The path in a `Spec:` value. A markdown link is read as its target, a trailing
 * parenthetical (`(+ prototypes/…)`) is dropped, and the first token that is a repo-style
 * file path wins (see `specFileOf`). A path with spaces (`docs/my spec.md`) is taken whole
 * when the value is exactly that one path: it starts like a path (holds a slash), ends in a
 * document extension and has no other document name, list separator or conjunction in it.
 * Undefined when nothing path-like is there (`n/a`, `TBD / pending`, `and/or`, `1/2`).
 */
function specPathOf(value: string): string | undefined {
  const head = value
    .replace(/\[[^\]]*\]\(([^)\s]+)\)/g, "$1")
    .replace(/(?:^|\s+)\(.*$/, "")
    .trim();
  const tokens = head.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && /[\\/]/.test(tokens[0]) && !/[,;+&]|\b(?:and|or)\b/i.test(head)) {
    const others = tokens.slice(0, -1);
    if (!others.some((t) => specFileOf(t) !== undefined)) {
      const whole = specFileOf(head);
      if (whole !== undefined) return whole;
    }
  }
  for (const token of tokens) {
    const file = specFileOf(token);
    if (file !== undefined) return file;
  }
  return undefined;
}

function note(taskIndex: number | undefined, text: string): LedgerNote {
  const trimmed = text.replace(/\s*\|\s*$/, "").trim();
  return taskIndex === undefined
    ? { text: trimmed }
    : { taskIndex, text: trimmed };
}

function parseComplete(rest: string): NonNullable<LedgerTask["complete"]> {
  // `complete (commits a..b, review clean|K parked …)` or `complete — free text`.
  const paren = /^\(([^)]*)\)/.exec(rest);
  const commits = paren ? COMMITS.exec(paren[1])?.[1] : undefined;
  const parkedCount = /(\d+)\s+parked/.exec(rest);
  return {
    ...(commits ? { commits } : {}),
    clean: !rest.includes("parked"),
    parked: parkedCount ? Number(parkedCount[1]) : 0,
    reviewClean: /\breview clean\b/.test(rest),
  };
}

/** Applies a `Task N:` line to the task; returns false when the line is not understood. */
function applyTaskLine(task: LedgerTask, rest: string): boolean {
  const implemented = IMPLEMENTED.exec(rest);
  if (implemented) {
    const verdict = implemented[2]?.trim();
    task.implemented = {
      ...task.implemented,
      sha: implemented[1].trim(),
      ...(verdict ? { verdict } : {}),
    };
    return true;
  }
  const review = REVIEW.exec(rest);
  if (review) {
    task.implemented = { ...task.implemented, verdict: review[1].trim() };
    return true;
  }
  const dispatched = FIX_DISPATCHED.exec(rest);
  if (dispatched) {
    const base = FIX_BASE.exec(rest)?.[1];
    upsertFix(task, { round: Number(dispatched[1]), state: "dispatched", ...(base ? { base } : {}) });
    return true;
  }
  const fixIn = FIX_IMPLEMENTED.exec(rest);
  if (fixIn) {
    const round = Number(fixIn[1]);
    const prev = task.fixes.find((f) => f.round === round);
    upsertFix(task, { round, state: "dispatched", ...prev, implementedSha: fixIn[2] });
    return true;
  }
  const done = FIX_DONE.exec(rest);
  if (done) {
    // The last `commits a..b` on the line: earlier text is the finding.
    const commits = [...done[4].matchAll(ALL_COMMITS)].pop()?.[1];
    const round = Number(done[1]);
    const base = task.fixes.find((f) => f.round === round)?.base;
    upsertFix(task, {
      round,
      state: "done",
      addressed: Number(done[2]),
      open: Number(done[3]),
      ...(commits ? { commits } : {}),
      ...(base ? { base } : {}),
    });
    return true;
  }
  const complete = COMPLETE.exec(rest);
  if (!complete) return false;
  task.complete = parseComplete(complete[1]);
  return true;
}

function upsertFix(task: LedgerTask, fix: LedgerFix): void {
  const at = task.fixes.findIndex((f) => f.round === fix.round);
  if (at >= 0) task.fixes[at] = fix;
  else task.fixes.push(fix);
}

/** Parses a superpowers SDD `progress.md` ledger. Line based; unknown lines are ignored. */
export function parseLedger(text: string): ParsedLedger {
  const ledger: ParsedLedger = {
    tasks: [],
    rulings: [],
    minors: [],
    parked: [],
    final: {},
  };
  const byNumber = new Map<number, LedgerTask>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const header = HEADER.exec(line);
    if (header) {
      ledger.planPath = header[1];
      continue;
    }

    const spec = SPEC_LINE.exec(line);
    if (spec) {
      // Only the first usable `Spec:` line counts.
      ledger.specPath ??= specPathOf(spec[1]);
      continue;
    }

    const taskMatch = TASK_LINE.exec(line);
    if (taskMatch) {
      const taskIndex = Number(taskMatch[1]);
      const rest = taskMatch[2];
      // Minor and parked lines keep their whole text, even when it mentions a Ruling.
      const minor = MINOR.exec(rest);
      if (minor) {
        ledger.minors.push(note(taskIndex, minor[1]));
        continue;
      }
      const parked = PARKED.exec(rest);
      if (parked) {
        ledger.parked.push(note(taskIndex, parked[1]));
        continue;
      }
      const ruling = RULING.exec(rest);
      if (ruling) ledger.rulings.push(note(taskIndex, ruling[1]));
      if (LEADING_RULING.test(rest)) continue;
      // Only register a task once one of its lines is understood.
      const task = byNumber.get(taskIndex) ?? { n: taskIndex, fixes: [] };
      if (applyTaskLine(task, rest)) byNumber.set(taskIndex, task);
      continue;
    }

    const review = FINAL_REVIEW.exec(line);
    if (review) {
      ledger.final.review = review[1];
      continue;
    }
    const wave = FINAL_WAVE.exec(line);
    if (wave) {
      ledger.final.fixWave = wave[1].toLowerCase() as "dispatched" | "complete";
      continue;
    }

    const ruling = RULING.exec(line);
    if (ruling) ledger.rulings.push(note(undefined, ruling[1]));
  }

  ledger.tasks = [...byNumber.values()].sort((a, b) => a.n - b.n);
  return ledger;
}

const TITLE = /^###\s+Task\s+\d+:\s*(.+?)\s*$/m;
const STEP = /^\s*-\s*\[[ xX]\]\s*(\*\*\s*Step\s+\d+\s*:.*)$/;

/** Extracts the task title and checkbox steps from a task brief. */
export function parseBrief(text: string): BriefInfo {
  const steps: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const step = STEP.exec(line);
    if (step)
      steps.push(step[1].replace(/\*\*/g, "").replace(/\s+/g, " ").trim());
  }
  return { title: TITLE.exec(text)?.[1], steps };
}

const STATUS =
  /^[\s*_]*Status:[\s*_]*(DONE_WITH_CONCERNS|DONE|NEEDS_CONTEXT|BLOCKED)(?![A-Za-z0-9_])/m;

/** Reads the `Status:` line of an implementer report; any suffix after the status word is ignored. */
export function reportStatus(text: string): ReportStatus | undefined {
  return STATUS.exec(text)?.[1] as ReportStatus | undefined;
}
