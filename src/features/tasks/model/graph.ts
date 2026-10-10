/**
 * The Tasks tab as a commit graph: one flat list of rows, each with the lane cells its SVG
 * gutter draws. Pure, built once in O(rows); the UI renders it as an ARIA tree.
 *
 * Lanes. Lane 0 is the plan: tasks in order, then the final review, then Ship. A side lane
 * opens only for work that ran beside the plan:
 *   - lane 1: a task's review/fix loop (from the first review that found issues, or the first
 *     fix round, to the end of its stages) and the final fix wave. Drawn only while the task
 *     is expanded; a collapsed task is one dot on lane 0.
 *   - lanes 2 and 3: running workers from other sections, one row each, placed after the
 *     `now` task (the first running or attention one), or after the last task when there is
 *     none. A third worker and beyond fold into one `lane` row on lane 3 titled "+N lanes".
 * `width` is the highest lane used + 1 (at most 4); every row's `cells` has exactly `width`
 * entries, one per column, left to right.
 *
 * Cells (what column c of a row draws):
 *   - "none":   nothing.
 *   - "line":   a vertical line through the whole row height (the lane passes by).
 *   - "node":   this row's node at mid-height. Draw the half line above when the previous
 *               row's cell in column c is not "none", and the half line below when the next
 *               row's cell in column c is neither "none" nor "fork". So the first row has no
 *               line above, Ship has none below, and a side lane that has not merged yet
 *               (task still running) just ends at its last node.
 *   - "fork":   a quarter curve from column 0 at the top edge of the row into this row's node
 *               in column c (always `row.lane`). Column 0 of that row is "line". Below it,
 *               same rule as "node".
 *   - "merge":  a quarter curve from column c at the top edge of the row into the node in
 *               column 0 at mid-height (column 0 is "node"). No node in column c, nothing
 *               below it.
 *   - "dashed": a dashed vertical segment through the whole row (hidden rows, column 0).
 *
 * Shapes this produces (columns 0, 1):
 *   task             node none     a task, or a stage that stays on the main line
 *   review: issues   line fork     first lane-1 row of a forked task
 *   R1, re-review    line node     the rest of the loop
 *   complete         node merge    synthetic `<taskId>:merge` row, only when the task is done
 *   step             line none     steps are a checklist under the rail, never nodes
 *   Ship             node merge    when the final fix wave is shown and done, else node none
 * Workers (columns 0..3): `line none fork none` (lane 2), `line none none fork` (lane 3).
 */
import { durationLabel } from "./nodeLabels";
import type { Gap } from "./gaps";
import type { Ship } from "./ship";
import { shortSha, type BoardNode, type BoardSection, type BoardStage, type BoardStatus } from "./taskBoard";

export type GraphFilter = "all" | "left" | "problems";
export type RefTone = "warn" | "danger" | "ok" | "muted" | "now";
export type GraphRef = { text: string; tone: RefTone };
export type LaneCell = "none" | "line" | "node" | "fork" | "merge" | "dashed";
export type GraphRow = {
  id: string;
  parentId?: string;
  kind: "task" | "stage" | "step" | "final" | "ship" | "lane" | "hidden";
  /** The column holding this row's node; 0 = main. */
  lane: number;
  /** One per column, length = graph width. See the top of this file. */
  cells: LaneCell[];
  status: BoardStatus;
  title: string;
  index?: number;
  /** At most 2, in the spec's priority order. */
  refs: GraphRef[];
  /** "8m" (done), "2/5 · 1m" (running or attention with steps), "4 steps" (not started). */
  meta?: string;
  /** Short shas for links. */
  shas: string[];
  /** The node this row stands for: tasks, the final review and workers. */
  node?: BoardNode;
  expandable: boolean;
  /** The first running-or-attention task (or the final review); the UI draws `NOW` from it. */
  now: boolean;
};
export type Graph = { rows: GraphRow[]; width: number; counts: Record<GraphFilter, number> };

export type GraphInput = {
  section: BoardSection;
  gaps: Gap[];
  ship: Ship;
  expanded: ReadonlySet<string>;
  filter: GraphFilter;
  now: number;
  /** Running nodes from other sections (agents, orchestration workers). */
  workers?: BoardNode[];
};

const STRUGGLING_FROM_ROUND = 3;
const MAX_FIX_ROUNDS = 5;
const MAX_REFS = 2;
const FIRST_WORKER_LANE = 2;
const MAX_LANE = 3;
const WORKER_LANES = MAX_LANE - FIRST_WORKER_LANE + 1;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const isActive = (node: BoardNode) => node.status === "running" || node.status === "attention";

/** Column 0 carries the main line; `cell` sits in column `lane`, the columns between are empty. */
function sideCells(lane: number, cell: LaneCell): LaneCell[] {
  const cells: LaneCell[] = ["line"];
  for (let c = 1; c < lane; c++) cells.push("none");
  cells.push(cell);
  return cells;
}

/**
 * Where the side lane starts: the first review when it found issues, else the first fix
 * round (task or final). A clean first review and no fix rounds never fork.
 */
function forkIndex(stages: BoardStage[]): number | undefined {
  let sawReview = false;
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]!;
    if (stage.kind === "fix" || stage.kind === "final-fix") return i;
    if (stage.kind === "review" && !sawReview) {
      sawReview = true;
      if (stage.status === "attention") return i;
    }
  }
  return undefined;
}

function firstReview(stages: BoardStage[]): BoardStage | undefined {
  return stages.find((s) => s.kind === "review" || s.kind === "final-review");
}

function nodeShas(node: BoardNode): string[] {
  const own = node.commits ? shortSha(node.commits) : [];
  if (own.length > 0) return own;
  const seen = new Set<string>();
  for (const stage of node.stages ?? []) if (stage.sha) for (const sha of shortSha(stage.sha)) seen.add(sha);
  return [...seen];
}

/** A stage counts live only while it is running; one that stopped without an end time has an unknown length, not a growing one. */
function stageDuration(stage: BoardStage, now: number): string | undefined {
  if (stage.startedAt === undefined || stage.status === "pending") return undefined;
  if (stage.status !== "running" && stage.endedAt === undefined) return "—";
  return durationLabel(stage, now);
}

function metaFor(node: BoardNode, now: number): string | undefined {
  const steps = node.steps ?? [];
  switch (node.status) {
    case "pending":
      return steps.length > 0 ? plural(steps.length, "step", "steps") : undefined;
    case "running":
    case "attention": {
      // Ticked steps then how long it has run; an unknown start adds no dash.
      const duration = node.startedAt !== undefined ? durationLabel(node, now) : undefined;
      if (steps.length === 0) return durationLabel(node, now);
      const ticked = `${steps.filter((s) => s.done).length}/${steps.length}`;
      return duration !== undefined ? `${ticked} · ${duration}` : ticked;
    }
    default:
      return durationLabel(node, now);
  }
}

export function buildGraph({ section, gaps, ship, expanded, filter, now, workers = [] }: GraphInput): Graph {
  // Lookups built once, so no row scans the whole plan.
  const gapIds = new Set<string>();
  const noCommit = new Set<string>();
  for (const gap of gaps) {
    gapIds.add(gap.nodeId);
    if (gap.kind === "no-commit") noCommit.add(gap.nodeId);
  }
  const deferredByIndex = new Map<number, number>();
  for (const note of [...(section.parked ?? []), ...(section.minors ?? [])]) {
    if (note.taskIndex !== undefined) deferredByIndex.set(note.taskIndex, (deferredByIndex.get(note.taskIndex) ?? 0) + 1);
  }

  const final = section.finalReview;
  const main = final ? [...section.nodes, final] : section.nodes;

  const struggling = (node: BoardNode) => node.status !== "done" && (node.fixRounds ?? 0) >= STRUGGLING_FROM_ROUND;
  const keeps: Record<GraphFilter, (node: BoardNode) => boolean> = {
    all: () => true,
    left: (node) => node.status !== "done" && node.status !== "cancelled",
    problems: (node) =>
      node.status === "failed" || node.status === "blocked" || struggling(node) || gapIds.has(node.id),
  };
  const keep = keeps[filter];
  const counts: Record<GraphFilter, number> = { all: main.length, left: 0, problems: 0 };
  for (const node of main) {
    if (keeps.left(node)) counts.left++;
    if (keeps.problems(node)) counts.problems++;
  }

  const nowId = (section.nodes.find(isActive) ?? (final && isActive(final) ? final : undefined))?.id;

  function refsFor(node: BoardNode, forked: boolean): GraphRef[] {
    const refs: GraphRef[] = [];
    const rounds = node.fixRounds ?? 0;
    const done = node.status === "done";
    if (struggling(node)) refs.push({ text: `fix ${Math.min(rounds, MAX_FIX_ROUNDS)} of ${MAX_FIX_ROUNDS}`, tone: "warn" });
    if (node.status === "failed") refs.push({ text: "failed", tone: "danger" });
    if (node.status === "blocked") refs.push({ text: "blocked", tone: "danger" });
    if (noCommit.has(node.id)) refs.push({ text: "no commit", tone: "warn" });
    const deferred = node.index !== undefined ? (deferredByIndex.get(node.index) ?? 0) : 0;
    if (deferred > 0) refs.push({ text: `${deferred} deferred`, tone: "muted" });
    if (!forked && firstReview(node.stages ?? [])?.status === "done") refs.push({ text: "review clean", tone: "ok" });
    if (done && rounds > 0) refs.push({ text: `fixed in ${plural(rounds, "round", "rounds")}`, tone: "muted" });
    return refs.slice(0, MAX_REFS);
  }

  const rows: GraphRow[] = [];
  let hidden: BoardNode[] = [];

  function flushHidden() {
    if (hidden.length === 0) return;
    const allDone = hidden.every((n) => n.status === "done");
    rows.push({
      id: `hidden:${hidden[0]!.id}`,
      kind: "hidden",
      lane: 0,
      cells: ["dashed"],
      status: allDone ? "done" : "pending",
      title: `${hidden.length} ${allDone ? "done hidden" : "hidden"}`,
      refs: [],
      shas: [],
      expandable: false,
      now: false,
    });
    hidden = [];
  }

  /** Pushes a main-lane node and, when expanded, its stages and steps. True when its side lane merged back. */
  function pushNode(node: BoardNode, kind: "task" | "final"): boolean {
    const stages = node.stages ?? [];
    const steps = node.steps ?? [];
    const forkAt = forkIndex(stages);
    const expandable = stages.length > 0 || steps.length > 0;
    const meta = metaFor(node, now);
    rows.push({
      id: node.id,
      kind,
      lane: 0,
      cells: ["node"],
      status: node.status,
      title: node.title,
      ...(node.index !== undefined ? { index: node.index } : {}),
      refs: refsFor(node, forkAt !== undefined),
      ...(meta !== undefined ? { meta } : {}),
      shas: nodeShas(node),
      node,
      expandable,
      now: node.id === nowId,
    });
    if (!expandable || !expanded.has(node.id)) return false;

    stages.forEach((stage, i) => {
      const side = forkAt !== undefined && i >= forkAt;
      const duration = stageDuration(stage, now);
      rows.push({
        id: `${node.id}:stage:${i}`,
        parentId: node.id,
        kind: "stage",
        lane: side ? 1 : 0,
        cells: side ? sideCells(1, i === forkAt ? "fork" : "node") : ["node"],
        status: stage.status,
        title: stage.verdict ? `${stage.label}: ${stage.verdict}` : stage.label,
        refs: [],
        ...(duration !== undefined ? { meta: duration } : {}),
        shas: stage.sha ? shortSha(stage.sha) : [],
        expandable: false,
        now: false,
      });
    });

    const merged = forkAt !== undefined && node.status === "done";
    // A task's loop merges at its own closing row; the final fix wave merges into Ship.
    if (merged && kind === "task") {
      rows.push({
        id: `${node.id}:merge`,
        parentId: node.id,
        kind: "stage",
        lane: 0,
        cells: ["node", "merge"],
        status: "done",
        title: "complete",
        refs: [],
        shas: node.commits ? shortSha(node.commits) : [],
        expandable: false,
        now: false,
      });
    }

    steps.forEach((step, i) => {
      if (filter === "left" && step.ticked) return;
      rows.push({
        id: `${node.id}:step:${i}`,
        parentId: node.id,
        kind: "step",
        lane: 0,
        cells: ["line"],
        status: step.done ? "done" : "pending",
        title: step.text,
        refs: [],
        shas: [],
        expandable: false,
        now: false,
      });
    });
    return merged;
  }

  function pushWorkers() {
    const drawn = workers.slice(0, WORKER_LANES);
    drawn.forEach((worker, i) => {
      const lane = FIRST_WORKER_LANE + i;
      const meta = durationLabel(worker, now);
      rows.push({
        id: `worker:${worker.id}`,
        kind: "lane",
        lane,
        cells: sideCells(lane, "fork"),
        status: worker.status,
        title: worker.title,
        refs: [],
        ...(meta !== undefined ? { meta } : {}),
        shas: [],
        node: worker,
        expandable: false,
        now: false,
      });
    });
    const folded = workers.length - drawn.length;
    if (folded > 0) {
      rows.push({
        id: "worker:more",
        kind: "lane",
        lane: MAX_LANE,
        cells: sideCells(MAX_LANE, "fork"),
        status: "running",
        title: `+${plural(folded, "lane", "lanes")}`,
        refs: [],
        shas: [],
        expandable: false,
        now: false,
      });
    }
  }

  // Workers are running work, never a plan problem, so the problems view leaves them out.
  let workersPlaced = workers.length === 0 || filter === "problems";
  for (const node of section.nodes) {
    if (!keep(node)) {
      hidden.push(node);
      continue;
    }
    flushHidden();
    pushNode(node, "task");
    if (!workersPlaced && node.id === nowId) {
      pushWorkers();
      workersPlaced = true;
    }
  }
  if (!workersPlaced) {
    flushHidden();
    pushWorkers();
  }

  let finalMerged = false;
  if (final) {
    if (keep(final)) {
      flushHidden();
      finalMerged = pushNode(final, "final");
    } else {
      hidden.push(final);
    }
  }
  flushHidden();

  const started = main.some((n) => n.status !== "pending");
  rows.push({
    id: "ship",
    kind: "ship",
    lane: 0,
    cells: finalMerged ? ["node", "merge"] : ["node"],
    status: ship.ready ? "done" : started ? "attention" : "pending",
    title: "Ship",
    refs: [],
    meta: ship.ready ? "Ready to ship" : `${plural(ship.left, "thing", "things")} before ship`,
    shas: [],
    expandable: true,
    now: false,
  });

  let width = 1;
  for (const row of rows) width = Math.max(width, row.cells.length);
  width = Math.min(width, MAX_LANE + 1);
  for (const row of rows) while (row.cells.length < width) row.cells.push("none");

  return { rows, width, counts };
}
