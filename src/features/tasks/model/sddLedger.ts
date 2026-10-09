export type LedgerFix = {
  round: number;
  state: "dispatched" | "done";
  addressed?: number;
  open?: number;
  commits?: string;
};

export type LedgerTask = {
  n: number;
  implemented?: { sha: string; verdict: string };
  fixes: LedgerFix[];
  complete?: { commits?: string; clean: boolean; parked: number };
};

export type LedgerNote = { taskIndex?: number; text: string };

export type ParsedLedger = {
  planPath?: string;
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
const TASK_LINE = /^Task\s+(\d+):\s*(.*)$/;
const RULING = /\bRuling\b[^:]*:\s*(.*)$/;
const IMPLEMENTED = /^implemented\s*\(([^)]+)\);\s*review:\s*(.*)$/;
const FIX_DISPATCHED = /^fix round\s+(\d+)\/\d+\s+dispatched/;
const FIX_DONE =
  /^fix round\s+(\d+)\/\d+\s*\((\d+)\s+addressed,\s*(\d+)\s+open\b([^)]*)\)/;
const MINOR = /^minor\b[^:]*:\s*(.*)$/;
const PARKED = /^parked\s*[—–-]+\s*(.*)$/;
const COMPLETE = /^complete\b\s*(.*)$/;
const COMMITS = /commits\s+([^\s,;)]+)/;
const FINAL_REVIEW = /^FINAL REVIEW\b\s*(.*)$/;
const FINAL_WAVE = /^Final fix wave:\s*(complete|dispatched)\b/i;

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
  };
}

/** Applies a `Task N:` line to the task; returns false when the line is not understood. */
function applyTaskLine(task: LedgerTask, rest: string): boolean {
  const implemented = IMPLEMENTED.exec(rest);
  if (implemented) {
    task.implemented = {
      sha: implemented[1].trim(),
      verdict: implemented[2].trim(),
    };
    return true;
  }
  const dispatched = FIX_DISPATCHED.exec(rest);
  if (dispatched) {
    upsertFix(task, { round: Number(dispatched[1]), state: "dispatched" });
    return true;
  }
  const done = FIX_DONE.exec(rest);
  if (done) {
    const commits = COMMITS.exec(done[4])?.[1];
    upsertFix(task, {
      round: Number(done[1]),
      state: "done",
      addressed: Number(done[2]),
      open: Number(done[3]),
      ...(commits ? { commits } : {}),
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

    const taskMatch = TASK_LINE.exec(line);
    const taskIndex = taskMatch ? Number(taskMatch[1]) : undefined;

    const ruling = RULING.exec(line);
    if (ruling) {
      ledger.rulings.push(note(taskIndex, ruling[1]));
      continue;
    }

    if (taskMatch && taskIndex !== undefined) {
      const rest = taskMatch[2];
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
    if (wave)
      ledger.final.fixWave = wave[1].toLowerCase() as "dispatched" | "complete";
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
