import {
  parseBrief,
  parseLedger,
  reportStatus,
  type BriefInfo,
  type LedgerTask,
  type ParsedLedger,
} from "./sddLedger";
import type { BoardNode, BoardSection, BoardStage, BoardStatus } from "./taskBoard";

export type SddSnapshot = {
  slug: string;
  dir: string;
  ledgerText: string;
  briefs: Record<number, string>;
  reports: Record<number, string>;
  /** File name (`task-2-report.md`) to mtime in ms; unknown files are absent. */
  mtimes: Record<string, number>;
  /** The `review-<a>..<b>.diff` packages. */
  reviews: { name: string; mtimeMs: number }[];
};

type Review = SddSnapshot["reviews"][number];

const FINAL_TITLE = "Last review of the whole branch";
const ISSUE_WORDS = /\b(Important|Critical)\b/;
const STEP_LABEL = /^Step\s+\d+\s*:\s*/;
const BRIEF_FILE = /^task-\d+-brief\.md$/;
const REVIEW_RANGE = /^review-(.+?)\.\.(.+)\.diff$/;
const SHA_RANGE = /\b([0-9a-f]{4,40})\.\.([0-9a-f]{4,40})\b/;
const AUTO_FIX_ROUNDS = 3;

function sectionTitle(slug: string): string {
  const words = slug.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function reviewFoundIssues(verdict: string): boolean {
  return verdict.startsWith("spec ❌") || ISSUE_WORDS.test(verdict);
}

function summaryFor(task: LedgerTask | undefined): string {
  const rounds = task?.fixes.length ?? 0;
  if (rounds === 0) return "Passed first review.";
  const verdict = task?.implemented?.verdict ?? "";
  return reviewFoundIssues(verdict)
    ? `Review found issues. Fixed in ${plural(rounds, "round", "rounds")}, then passed.`
    : `Passed after ${plural(rounds, "fix", "fixes")}.`;
}

/** `a..b` to `b`; a bare sha stays as is. */
function endSha(range: string): string {
  return range.split("..").pop() ?? range;
}

function sameSha(a: string, b: string): boolean {
  const [x, y] = [a.trim(), b.trim()];
  return Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x));
}

function packagesFor(reviews: Review[], sha: string | undefined): Review[] {
  if (!sha) return [];
  return reviews.filter((r) => {
    const end = REVIEW_RANGE.exec(r.name)?.[2];
    return end !== undefined && sameSha(end, sha);
  });
}

function latest(reviews: Review[]): number | undefined {
  return reviews.length ? Math.max(...reviews.map((r) => r.mtimeMs)) : undefined;
}

function stagesFor(
  task: LedgerTask | undefined,
  status: BoardStatus,
  startedAt: number | undefined,
  reportAt: number | undefined,
  reviews: Review[],
  implementDone: boolean,
): BoardStage[] {
  const done = status === "done";
  const stages: BoardStage[] = [
    {
      kind: "implement",
      label: "Implement",
      status: implementDone ? "done" : status === "blocked" ? "blocked" : "running",
      startedAt,
      endedAt: implementDone ? notBefore(startedAt, reportAt) : undefined,
    },
  ];
  const implemented = task?.implemented;
  if (implemented) {
    const verdict = implemented.verdict;
    stages.push({
      kind: "review",
      label: "Review",
      status: !verdict && !done ? "running" : reviewFoundIssues(verdict) ? "attention" : "done",
      ...(verdict ? { verdict } : {}),
      startedAt: latest(packagesFor(reviews, implemented.sha)),
    });
  }
  for (const fix of task?.fixes ?? []) {
    const finished = fix.state === "done";
    stages.push({
      kind: "fix",
      label: `R${fix.round}`,
      status: finished ? ((fix.open ?? 0) > 0 ? "attention" : "done") : done ? "done" : "running",
      ...(finished ? { verdict: `${fix.addressed ?? 0} addressed, ${fix.open ?? 0} open` } : {}),
      endedAt: latest(packagesFor(reviews, fix.commits ? endSha(fix.commits) : undefined)),
    });
  }
  return stages;
}

/** True when `time` is a finite number that does not precede `start` (when known). */
function notBefore(start: number | undefined, time: number | undefined): number | undefined {
  if (time === undefined || !Number.isFinite(time)) return undefined;
  return start !== undefined && time < start ? undefined : time;
}

/**
 * Review packages that span the whole branch (they start at the plan's base sha
 * or at the final review's base), so they never belong to a single task.
 */
function wholeBranchStarts(ledger: ParsedLedger): string[] {
  const starts: string[] = [];
  const first = ledger.tasks.find((t) => t.complete?.commits?.includes(".."));
  if (first?.complete?.commits) starts.push(first.complete.commits.split("..")[0]);
  const final = SHA_RANGE.exec(ledger.final.review ?? "");
  if (final) starts.push(final[1]);
  return starts;
}

/**
 * Mtime of the task's last review package inside [reportAt, nextReportAt].
 * Only packages whose end sha belongs to the task count; with none the report
 * mtime stands in.
 */
function reviewEnd(
  task: LedgerTask | undefined,
  reviews: Review[],
  reportAt: number | undefined,
  nextReportAt: number | undefined,
): number | undefined {
  const shas = [
    task?.implemented?.sha,
    ...(task?.fixes.map((f) => (f.commits ? endSha(f.commits) : undefined)) ?? []),
    task?.complete?.commits ? endSha(task.complete.commits) : undefined,
  ];
  const own = reviews.filter((r) => shas.some((s) => packagesFor([r], s).length > 0));
  const inWindow = own.filter(
    (r) => r.mtimeMs >= (reportAt ?? -Infinity) && r.mtimeMs <= (nextReportAt ?? Infinity),
  );
  return latest(inWindow) ?? reportAt;
}

function buildFinalReview(ledger: ParsedLedger): BoardNode {
  const { review, fixWave } = ledger.final;
  if (review === undefined) return { id: "final-review", title: FINAL_TITLE, status: "pending" };
  const waveDone = fixWave === "complete";
  const stages: BoardStage[] = [
    { kind: "final-review", label: "Final review", status: "done", ...(review ? { verdict: review } : {}) },
  ];
  if (fixWave) {
    stages.push({ kind: "final-fix", label: "Final fixes", status: waveDone ? "done" : "running" });
  }
  return {
    id: "final-review",
    title: FINAL_TITLE,
    status: waveDone ? "done" : "running",
    ...(review ? { summary: review } : {}),
    stages,
  };
}

/**
 * Builds the Tasks panel section for one SDD workspace. Pure: all times come
 * from the snapshot's mtimes, so `now` is accepted for signature parity with the
 * other builders but nothing here reads the clock.
 */
export function buildSddSection(snapshot: SddSnapshot, _now: number): BoardSection {
  const ledger = parseLedger(snapshot.ledgerText);
  const ledgerTasks = new Map(ledger.tasks.map((t) => [t.n, t]));
  const briefs = new Map<number, BriefInfo>(
    Object.entries(snapshot.briefs).map(([n, text]) => [Number(n), parseBrief(text)]),
  );
  const { mtimes } = snapshot;
  const branchStarts = wholeBranchStarts(ledger);
  const reviews = snapshot.reviews.filter((r) => {
    const start = REVIEW_RANGE.exec(r.name)?.[1];
    return Number.isFinite(r.mtimeMs) && !(start && branchStarts.some((b) => sameSha(b, start)));
  });
  const reportMtime = (n: number): number | undefined => mtimes[`task-${n}-report.md`];

  const seen = [
    ...Object.keys(snapshot.briefs),
    ...Object.keys(snapshot.reports),
    ...ledger.tasks.map((t) => t.n),
  ].map(Number);
  const total = seen.length ? Math.max(...seen) : 0;

  const briefTimes = Object.entries(mtimes).filter(([name]) => BRIEF_FILE.test(name));
  const firstBriefAt = briefTimes.length ? Math.min(...briefTimes.map(([, ms]) => ms)) : undefined;

  const nodes: BoardNode[] = [];
  let runningTaken = false;
  let previousEnd: number | undefined;
  for (let n = 1; n <= total; n++) {
    const task = ledgerTasks.get(n);
    const brief = briefs.get(n);
    const report = snapshot.reports[n];
    // A brief alone is not evidence of work: briefs may all be extracted up front.
    const hasSignal = report !== undefined || task !== undefined;
    const maxRound = Math.max(0, ...(task?.fixes.map((f) => f.round) ?? []));

    let status: BoardStatus = "pending";
    if (task?.complete) {
      status = "done";
    } else if (hasSignal && !runningTaken) {
      runningTaken = true;
      status =
        report !== undefined && reportStatus(report) === "BLOCKED"
          ? "blocked"
          : maxRound >= AUTO_FIX_ROUNDS
            ? "attention"
            : "running";
    }

    const started = status !== "pending";
    const startedAt = started ? (n === 1 ? firstBriefAt : previousEnd) : undefined;
    const reportAt = reportMtime(n);
    const endedAt =
      status === "done"
        ? notBefore(startedAt, reviewEnd(task, reviews, reportAt, reportMtime(n + 1)))
        : undefined;
    previousEnd = endedAt;

    const implementDone =
      task?.implemented !== undefined ||
      (task?.fixes.length ?? 0) > 0 ||
      status === "done" ||
      (report !== undefined && status !== "blocked");
    const reportName = `task-${n}-report.md`;
    const briefName = `task-${n}-brief.md`;
    nodes.push({
      id: `task-${n}`,
      title: brief?.title ?? `Task ${n}`,
      index: n,
      status,
      startedAt,
      endedAt,
      ...(status === "done" ? { summary: summaryFor(task) } : {}),
      ...(started ? { stages: stagesFor(task, status, startedAt, reportAt, reviews, implementDone) } : {}),
      ...(brief
        ? {
            steps: brief.steps.map((text) => ({
              text: text.replace(STEP_LABEL, ""),
              done: status === "done",
            })),
          }
        : {}),
      ...(task?.complete?.commits ? { commits: task.complete.commits } : {}),
      ...(task && task.fixes.length > 0 ? { fixRounds: maxRound } : {}),
      ...(report !== undefined
        ? { target: { kind: "report" as const, ref: `${snapshot.dir}/${reportName}` } }
        : brief
          ? { target: { kind: "brief" as const, ref: `${snapshot.dir}/${briefName}` } }
          : {}),
    });
  }

  return {
    source: "sdd",
    id: `sdd:${snapshot.slug}`,
    title: sectionTitle(snapshot.slug),
    done: nodes.filter((x) => x.status === "done").length,
    total,
    startedAt: nodes[0]?.startedAt,
    nodes,
    decisions: ledger.rulings,
    minors: ledger.minors,
    parked: ledger.parked,
    ...(ledger.planPath ? { planPath: ledger.planPath } : {}),
    finalReview: buildFinalReview(ledger),
  };
}
