import { describe, expect, it } from "vitest";
import { gapsFor } from "./gaps";
import { buildGraph, type GraphFilter, type GraphRow } from "./graph";
import { shipReadiness, type Ship } from "./ship";
import type { BoardNode, BoardSection, BoardStage, BoardStatus } from "./taskBoard";

const MIN = 60_000;
const NOW = 100 * MIN;

function task(n: number, status: BoardStatus, over: Partial<BoardNode> = {}): BoardNode {
  return { id: `task-${n}`, title: `Task ${n}`, index: n, status, commits: "abcdef0", ...over };
}

function plan(nodes: BoardNode[], over: Partial<BoardSection> = {}): BoardSection {
  return {
    source: "sdd",
    id: "sdd:p",
    title: "P",
    done: nodes.filter((n) => n.status === "done").length,
    total: nodes.length,
    nodes,
    ...over,
  };
}

const stage = (kind: BoardStage["kind"], status: BoardStatus, over: Partial<BoardStage> = {}): BoardStage => ({
  kind,
  label: kind,
  status,
  ...over,
});

const notReady: Ship = { ready: false, items: [], left: 3, deferred: 0, commits: 0 };

function graph(
  section: BoardSection,
  opts: { expanded?: string[]; filter?: GraphFilter; workers?: BoardNode[]; ship?: Ship } = {},
) {
  return buildGraph({
    section,
    gaps: gapsFor(section),
    ship: opts.ship ?? shipReadiness(section, undefined),
    expanded: new Set(opts.expanded ?? []),
    filter: opts.filter ?? "all",
    now: NOW,
    ...(opts.workers ? { workers: opts.workers } : {}),
  });
}

const ids = (rows: GraphRow[]) => rows.map((r) => r.id);
const cells = (rows: GraphRow[]) => rows.map((r) => r.cells);
const refs = (row: GraphRow | undefined) => row?.refs.map((r) => `${r.tone}:${r.text}`);

describe("buildGraph", () => {
  it("clean task stays one dot", () => {
    const node = task(1, "done", {
      stages: [stage("implement", "done", { sha: "1111111" }), stage("review", "done", { verdict: "spec ✅" })],
    });
    const g = graph(plan([node]), { expanded: ["task-1"] });
    expect(ids(g.rows)).toEqual(["task-1", "task-1:stage:0", "task-1:stage:1", "ship"]);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 0, 0, 0]);
    expect(cells(g.rows)).toEqual([["node"], ["node"], ["node"], ["node"]]);
    expect(g.width).toBe(1);
    expect(refs(g.rows[0])).toEqual(["ok:review clean"]);
    expect(g.rows[1]).toMatchObject({ kind: "stage", parentId: "task-1", shas: ["1111111"], expandable: false });
    expect(g.rows[0]).toMatchObject({ kind: "task", index: 1, shas: ["abcdef0"], expandable: true, node });
  });

  it("review issues fork and merge at complete", () => {
    const node = task(1, "done", {
      commits: "aaaaaaa1..bbbbbbb2",
      fixRounds: 1,
      stages: [
        stage("implement", "done", { sha: "aaaaaaa1" }),
        stage("review", "attention", { verdict: "2 issues" }),
        stage("fix", "done", { sha: "bbbbbbb2", verdict: "2 addressed, 0 open" }),
      ],
    });
    const g = graph(plan([node]), { expanded: ["task-1"] });
    expect(ids(g.rows)).toEqual(["task-1", "task-1:stage:0", "task-1:stage:1", "task-1:stage:2", "task-1:merge", "ship"]);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 0, 1, 1, 0, 0]);
    expect(cells(g.rows)).toEqual([
      ["node", "none"],
      ["node", "none"],
      ["line", "fork"],
      ["line", "node"],
      ["node", "merge"],
      ["node", "none"],
    ]);
    expect(g.width).toBe(2);
    expect(g.rows[4]).toMatchObject({ kind: "stage", title: "complete", status: "done", shas: ["aaaaaaa", "bbbbbbb"] });
    expect(refs(g.rows[0])).toEqual(["muted:fixed in 1 round"]);

    // Collapsed, the forked task is one dot on the main lane.
    const collapsed = graph(plan([node]));
    expect(ids(collapsed.rows)).toEqual(["task-1", "ship"]);
    expect(collapsed.width).toBe(1);
  });

  it("does not merge a forked task that is still running", () => {
    const node = task(1, "attention", {
      fixRounds: 1,
      stages: [stage("implement", "done"), stage("review", "attention"), stage("fix", "running")],
      steps: [{ text: "a", done: true, ticked: true }],
    });
    const g = graph(plan([node]), { expanded: ["task-1"] });
    expect(ids(g.rows)).toEqual(["task-1", "task-1:stage:0", "task-1:stage:1", "task-1:stage:2", "task-1:step:0", "ship"]);
    expect(cells(g.rows).slice(2)).toEqual([
      ["line", "fork"],
      ["line", "node"],
      ["line", "none"],
      ["node", "none"],
    ]);
    expect(g.rows[4]).toMatchObject({ kind: "step", parentId: "task-1", lane: 0, status: "done", title: "a" });
  });

  it("forks at the first fix round when the review left no verdict", () => {
    const node = task(1, "done", { stages: [stage("implement", "done"), stage("review", "done"), stage("fix", "done")] });
    const g = graph(plan([node]), { expanded: ["task-1"] });
    expect(g.rows.map((r) => r.lane)).toEqual([0, 0, 0, 1, 0, 0]);
    expect(refs(g.rows[0])).toEqual([]);
  });

  it("final fixes fork into ship", () => {
    const finalReview: BoardNode = {
      id: "final-review",
      title: "Final review",
      status: "done",
      stages: [stage("final-review", "done", { verdict: "Ready with fixes" }), stage("final-fix", "done")],
    };
    const section = plan([task(1, "done")], { finalReview });
    const g = graph(section, { expanded: ["final-review"] });
    expect(ids(g.rows)).toEqual(["task-1", "final-review", "final-review:stage:0", "final-review:stage:1", "ship"]);
    expect(g.rows[1]).toMatchObject({ kind: "final", lane: 0, node: finalReview, expandable: true });
    expect(cells(g.rows)).toEqual([
      ["node", "none"],
      ["node", "none"],
      ["node", "none"],
      ["line", "fork"],
      ["node", "merge"],
    ]);

    // A fix wave still running has not reached ship yet.
    const running = { ...finalReview, status: "running" as const, stages: [finalReview.stages![0]!, stage("final-fix", "running")] };
    const open = graph(plan([task(1, "done")], { finalReview: running }), { expanded: ["final-review"] });
    expect(open.rows.at(-1)?.cells).toEqual(["node", "none"]);
  });

  it("worker lanes cap at 3 plus a fold row", () => {
    const section = plan([task(1, "done"), task(2, "running"), task(3, "pending")]);
    const worker = (id: string): BoardNode => ({ id, title: `Worker ${id}`, status: "running", startedAt: NOW - MIN });
    const g = graph(section, { workers: [worker("w1"), worker("w2"), worker("w3"), worker("w4")] });
    expect(ids(g.rows)).toEqual(["task-1", "task-2", "worker:w1", "worker:w2", "worker:more", "task-3", "ship"]);
    expect(g.width).toBe(4);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 0, 2, 3, 3, 0, 0]);
    expect(cells(g.rows).slice(2, 5)).toEqual([
      ["line", "none", "fork", "none"],
      ["line", "none", "none", "fork"],
      ["line", "none", "none", "fork"],
    ]);
    expect(g.rows[2]).toMatchObject({ kind: "lane", title: "Worker w1", status: "running", meta: "1m 0s" });
    expect(g.rows[4]).toMatchObject({ kind: "lane", title: "+2 lanes" });

    // With nothing running, workers sit at the end of the plan, before the final review.
    const idle = plan([task(1, "done")], { finalReview: { id: "final-review", title: "Final review", status: "pending" } });
    const one = graph(idle, { workers: [worker("w1")] });
    expect(ids(one.rows)).toEqual(["task-1", "worker:w1", "final-review", "ship"]);
    expect(one.width).toBe(3);
  });

  it("filter left on done plan", () => {
    const section = plan([1, 2, 3, 4, 5, 6].map((n) => task(n, "done")));
    const g = graph(section, { filter: "left", ship: { ...notReady, ready: true, left: 0 } });
    expect(g.rows.map((r) => r.kind)).toEqual(["hidden", "ship"]);
    expect(g.rows[0]).toMatchObject({ title: "6 done hidden", lane: 0, cells: ["dashed"], status: "done" });
  });

  it("filter left keeps open work and only its unticked steps", () => {
    const steps = [
      { text: "a", done: true, ticked: true },
      { text: "b", done: false, ticked: false },
    ];
    const section = plan([task(1, "done"), task(2, "done"), task(3, "running", { steps }), task(4, "pending")], {
      finalReview: { id: "final-review", title: "Final review", status: "pending" },
    });
    const g = graph(section, { filter: "left", expanded: ["task-3"] });
    expect(ids(g.rows)).toEqual(["hidden:task-1", "task-3", "task-3:step:1", "task-4", "final-review", "ship"]);
    expect(g.rows[0]?.title).toBe("2 done hidden");
    // Under "all" the same expanded task lists every step.
    expect(ids(graph(section, { expanded: ["task-3"] }).rows)).toContain("task-3:step:0");
  });

  it("problems filter keeps gap rows", () => {
    const { commits: _c, ...noCommit } = task(2, "done");
    const section = plan(
      [task(1, "done"), noCommit, task(3, "done"), task(4, "blocked"), task(5, "pending"), task(6, "attention", { fixRounds: 3 })],
      { finalReview: { id: "final-review", title: "Final review", status: "pending" } },
    );
    const g = graph(section, { filter: "problems" });
    expect(ids(g.rows)).toEqual(["hidden:task-1", "task-2", "hidden:task-3", "task-4", "hidden:task-5", "task-6", "hidden:final-review", "ship"]);
    expect(g.rows.map((r) => r.title)).toEqual([
      "1 done hidden",
      "Task 2",
      "1 done hidden",
      "Task 4",
      "1 hidden",
      "Task 6",
      "1 hidden",
      "Ship",
    ]);
    expect(refs(g.rows[1])).toEqual(["warn:no commit"]);
  });

  it("refs priority and cap of 2", () => {
    const section = plan(
      [
        task(1, "failed", { fixRounds: 4 }),
        task(2, "done", { commits: undefined, stages: [stage("implement", "done"), stage("review", "done")] }),
        task(3, "blocked"),
        task(4, "done", { fixRounds: 7 }),
      ],
      { parked: [{ taskIndex: 2, text: "x" }], minors: [{ taskIndex: 2, text: "y" }, { taskIndex: 3, text: "z" }] },
    );
    const g = graph(section);
    const row = (id: string) => g.rows.find((r) => r.id === id);
    expect(refs(row("task-1"))).toEqual(["warn:fix 4 of 5", "danger:failed"]);
    expect(refs(row("task-2"))).toEqual(["warn:no commit", "muted:2 deferred"]);
    expect(refs(row("task-3"))).toEqual(["danger:blocked", "muted:1 deferred"]);
    expect(refs(row("task-4"))).toEqual(["muted:fixed in 7 rounds"]);
  });

  it("meta per status", () => {
    const steps = (done: number, total: number) =>
      Array.from({ length: total }, (_, i) => ({ text: `s${i}`, done: i < done, ticked: i < done }));
    const section = plan([
      task(1, "done", { startedAt: 0, endedAt: 8 * MIN }),
      task(2, "running", { startedAt: NOW - MIN, steps: steps(2, 5) }),
      task(3, "attention", { startedAt: NOW - 65_000 }),
      task(4, "pending", { steps: steps(0, 4) }),
      task(5, "pending", { steps: steps(0, 1) }),
      task(6, "pending"),
    ]);
    const g = graph(section);
    expect(g.rows.slice(0, 6).map((r) => r.meta)).toEqual(["8m", "2/5", "1m 5s", "4 steps", "1 step", undefined]);
  });

  it("now marks the first running or attention task", () => {
    const section = plan([task(1, "done"), task(2, "attention"), task(3, "running")]);
    expect(graph(section).rows.filter((r) => r.now).map((r) => r.id)).toEqual(["task-2"]);
    const final = plan([task(1, "done")], { finalReview: { id: "final-review", title: "Final review", status: "running" } });
    expect(graph(final).rows.filter((r) => r.now).map((r) => r.id)).toEqual(["final-review"]);
  });

  it("empty section", () => {
    const g = graph(plan([]), { ship: notReady });
    expect(g.rows).toEqual([
      {
        id: "ship",
        kind: "ship",
        lane: 0,
        cells: ["node"],
        status: "pending",
        title: "Ship",
        refs: [],
        meta: "3 things before ship",
        shas: [],
        expandable: true,
        now: false,
      },
    ]);
    expect(g.width).toBe(1);
    expect(g.counts).toEqual({ all: 0, left: 0, problems: 0 });
  });

  it("ship row says how far it is", () => {
    const started = plan([task(1, "running")]);
    expect(graph(started, { ship: { ...notReady, left: 1 } }).rows.at(-1)).toMatchObject({
      status: "attention",
      meta: "1 thing before ship",
    });
    expect(graph(started, { ship: { ...notReady, ready: true, left: 0 } }).rows.at(-1)).toMatchObject({
      status: "done",
      meta: "Ready to ship",
    });
    expect(graph(plan([task(1, "pending")]), { ship: notReady }).rows.at(-1)?.status).toBe("pending");
  });

  it("counts per filter", () => {
    const { commits: _c, ...noCommit } = task(2, "done");
    const section = plan([task(1, "done"), noCommit, task(3, "running"), task(4, "blocked"), task(5, "pending")], {
      finalReview: { id: "final-review", title: "Final review", status: "pending" },
    });
    // The counts do not depend on the filter in use.
    for (const filter of ["all", "left", "problems"] as const) {
      expect(graph(section, { filter }).counts).toEqual({ all: 6, left: 4, problems: 2 });
    }
  });
});
