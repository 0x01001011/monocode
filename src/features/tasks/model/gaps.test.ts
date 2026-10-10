import { describe, expect, it } from "vitest";
import { gapsFor } from "./gaps";
import type { BoardNode, BoardSection, BoardStatus } from "./taskBoard";

function task(n: number, status: BoardStatus, over: Partial<BoardNode> = {}): BoardNode {
  return { id: `task-${n}`, title: `Task ${n} title`, index: n, status, commits: "abc1234", ...over };
}

function plan(nodes: BoardNode[], over: Partial<BoardSection> = {}): BoardSection {
  return {
    source: "sdd",
    id: "sdd:p",
    title: "P",
    done: nodes.filter((n) => n.status === "done").length,
    total: nodes.length,
    nodes,
    finalReview: { id: "final-review", title: "Last review", status: "done" },
    ...over,
  };
}

const step = (ticked: boolean) => ({ text: "s", done: true, ticked });

describe("gapsFor", () => {
  it("has no gaps for a clean plan", () => {
    expect(gapsFor(plan([task(1, "done"), task(2, "done")]))).toEqual([]);
  });

  it("flags a done task with no commit recorded", () => {
    const { commits: _c, ...bare } = task(2, "done");
    expect(gapsFor(plan([task(1, "done"), bare]))).toEqual([
      { kind: "no-commit", nodeId: "task-2", label: "Task 2", text: "no commit recorded" },
    ]);
  });

  it("accepts a stage sha as the commit", () => {
    const { commits: _c, ...bare } = task(1, "done");
    const node = { ...bare, stages: [{ kind: "implement" as const, label: "Implement", status: "done" as const, sha: "abc1234" }] };
    expect(gapsFor(plan([node]))).toEqual([]);
  });

  it("does not flag an unfinished task for a missing commit", () => {
    const { commits: _c, ...bare } = task(1, "running");
    expect(gapsFor(plan([bare]))).toEqual([]);
  });

  it("flags a task closed with parked items", () => {
    expect(gapsFor(plan([task(1, "done", { parkedAtClose: 2 })]))).toEqual([
      { kind: "closed-with-parked", nodeId: "task-1", label: "Task 1", text: "closed with 2 parked" },
    ]);
  });

  it("flags plan steps left unticked at finish", () => {
    const node = task(1, "done", { steps: [step(true), step(false), step(false), step(false)] });
    expect(gapsFor(plan([node], { steps: { done: 4, total: 4 } }))).toEqual([
      { kind: "unticked-at-finish", nodeId: "task-1", label: "Task 1", text: "3 steps not ticked" },
    ]);
  });

  it("says step in the singular", () => {
    const node = task(1, "done", { steps: [step(true), step(false)] });
    expect(gapsFor(plan([node], { steps: { done: 2, total: 2 } }))[0]?.text).toBe("1 step not ticked");
  });

  it("raises no unticked gap when the plan ticks no step anywhere (the executor does not tick)", () => {
    const nodes = [
      task(1, "done", { steps: [step(false), step(false)] }),
      task(2, "done", { steps: [step(false)] }),
      task(3, "running", { steps: [{ text: "s", done: false, ticked: false }] }),
    ];
    expect(gapsFor(plan(nodes, { steps: { done: 3, total: 4 } }))).toEqual([]);
  });

  it("raises the unticked gap for done tasks once any step in the plan is ticked", () => {
    const nodes = [
      task(1, "done", { steps: [step(false), step(false)] }),
      task(2, "done", { steps: [step(true)] }),
      task(3, "running", { steps: [{ text: "s", done: true, ticked: true }, { text: "s", done: false, ticked: false }] }),
    ];
    expect(gapsFor(plan(nodes, { steps: { done: 4, total: 5 } }))).toEqual([
      { kind: "unticked-at-finish", nodeId: "task-1", label: "Task 1", text: "2 steps not ticked" },
    ]);
  });

  it("ignores brief steps when there is no plan file", () => {
    const node = task(1, "done", { steps: [step(false), step(false)] });
    expect(gapsFor(plan([node]))).toEqual([]);
  });

  it("flags a missing final review once every task is done", () => {
    const { finalReview: _f, ...noFinal } = plan([task(1, "done")]);
    expect(gapsFor(noFinal)).toEqual([
      { kind: "no-final-review", nodeId: "final-review", label: "Final review", text: "final review not run" },
    ]);
    const pending = plan([task(1, "done")], { finalReview: { id: "final-review", title: "Last review", status: "pending" } });
    expect(gapsFor(pending).map((g) => g.kind)).toEqual(["no-final-review"]);
  });

  it("does not flag the final review while tasks remain", () => {
    const { finalReview: _f, ...noFinal } = plan([task(1, "done"), task(2, "running")]);
    expect(gapsFor(noFinal)).toEqual([]);
  });

  it("lists gaps in plan order, the final review last", () => {
    const { commits: _c, ...bare } = task(1, "done", { parkedAtClose: 1 });
    const { finalReview: _f, ...noFinal } = plan([bare, task(2, "done", { parkedAtClose: 3 })]);
    expect(gapsFor(noFinal).map((g) => `${g.nodeId}:${g.kind}`)).toEqual([
      "task-1:no-commit",
      "task-1:closed-with-parked",
      "task-2:closed-with-parked",
      "final-review:no-final-review",
    ]);
  });
});
