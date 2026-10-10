import { describe, expect, it } from "vitest";
import { gapsFor } from "./gaps";
import { shipReadiness } from "./ship";
import type { BoardNode, BoardSection, BoardStatus } from "./taskBoard";
import type { TestRun } from "./testRuns";

function task(n: number, status: BoardStatus, over: Partial<BoardNode> = {}): BoardNode {
  return { id: `task-${n}`, title: `Task ${n}`, index: n, status, commits: `${n}`.repeat(7).replace(/[^0-9a-f]/g, "a"), ...over };
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

const passed: TestRun = { status: "passed", command: "npm test" };
const items = (s: BoardSection, run: TestRun | undefined) => shipReadiness(s, run).items;
const item = (s: BoardSection, run: TestRun | undefined, id: string) => items(s, run).find((i) => i.id === id);

describe("shipReadiness", () => {
  it("is ready when everything is met", () => {
    const s = plan([task(1, "done"), task(2, "done")]);
    const ship = shipReadiness(s, passed);
    expect(ship.ready).toBe(true);
    expect(ship.left).toBe(0);
    expect(ship.items).toEqual([
      { id: "tasks", met: true, text: "every task done" },
      { id: "final", met: true, text: "final review clean" },
      { id: "tests", met: true, text: "tests passed" },
      { id: "gaps", met: true, text: "no gaps" },
    ]);
  });

  it("counts tasks left and points at the first open one", () => {
    const s = plan([task(1, "done"), task(2, "running"), task(3, "pending")]);
    expect(item(s, passed, "tasks")).toEqual({ id: "tasks", met: false, text: "2 tasks left", nodeId: "task-2" });
    expect(item(plan([task(1, "running")]), passed, "tasks")?.text).toBe("1 task left");
  });

  it("is unmet while the final review is missing, pending or running", () => {
    const { finalReview: _f, ...none } = plan([task(1, "done")]);
    expect(item(none, passed, "final")).toEqual({ id: "final", met: false, text: "final review not done", nodeId: "final-review" });
    for (const status of ["pending", "running", "attention"] as const) {
      const s = plan([task(1, "done")], { finalReview: { id: "final-review", title: "Last review", status } });
      expect(item(s, passed, "final")?.met).toBe(false);
    }
  });

  it("reads each test state", () => {
    const s = plan([task(1, "done")]);
    expect(item(s, { status: "failed", command: "x" }, "tests")).toEqual({ id: "tests", met: false, text: "tests failed" });
    expect(item(s, undefined, "tests")).toEqual({ id: "tests", met: "unknown", text: "no test run yet" });
    expect(item(s, { status: "unknown", command: "x" }, "tests")).toEqual({ id: "tests", met: "unknown", text: "test result unknown" });
    expect(item(s, { status: "running", command: "x" }, "tests")).toEqual({ id: "tests", met: "unknown", text: "tests running" });
  });

  it("is not ready with unknown tests, and counts them as left", () => {
    const ship = shipReadiness(plan([task(1, "done")]), undefined);
    expect(ship.ready).toBe(false);
    expect(ship.left).toBe(1);
  });

  it("counts gaps and points at the first", () => {
    const s = plan([task(1, "done", { parkedAtClose: 1 }), task(2, "done", { parkedAtClose: 2 })]);
    expect(item(s, passed, "gaps")).toEqual({ id: "gaps", met: false, text: "2 gaps", nodeId: "task-1" });
    expect(gapsFor(s)).toHaveLength(2);
    expect(item(plan([task(1, "done", { parkedAtClose: 1 })]), passed, "gaps")?.text).toBe("1 gap");
  });

  it("counts a missing final review once, not again as a gap", () => {
    const s = plan([task(1, "done"), task(2, "done")], { finalReview: { id: "final-review", title: "Last review", status: "pending" } });
    expect(gapsFor(s).map((g) => g.kind)).toEqual(["no-final-review"]);
    const ship = shipReadiness(s, passed);
    expect(ship.left).toBe(1);
    expect(ship.ready).toBe(false);
    expect(ship.items.find((i) => i.id === "gaps")).toEqual({ id: "gaps", met: true, text: "no gaps" });
    expect(ship.items.find((i) => i.id === "final")?.met).toBe(false);
  });

  it("counts every unmet item as left", () => {
    const s = plan([task(1, "done"), task(2, "pending")]);
    expect(shipReadiness(s, { status: "failed", command: "x" }).left).toBe(2);
  });

  it("counts deferred as parked plus minors, which never block", () => {
    const s = plan([task(1, "done")], {
      parked: [{ text: "a" }, { text: "b" }],
      minors: [{ text: "c" }],
    });
    const ship = shipReadiness(s, passed);
    expect(ship.deferred).toBe(3);
    expect(ship.ready).toBe(true);
  });

  it("counts distinct short shas across nodes and stages", () => {
    const stage = (sha: string) => ({ kind: "fix" as const, label: "Fix", status: "done" as const, sha });
    const s = plan([
      task(1, "done", { commits: "1111111aaaa..2222222bbbb", stages: [stage("2222222bbbbcccc"), stage("3333333")] }),
      task(2, "done", { commits: "3333333" }),
      task(3, "done", { commits: "not a sha" }),
    ]);
    expect(shipReadiness(s, passed).commits).toBe(3);
  });
});
