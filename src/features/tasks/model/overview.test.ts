import { describe, expect, it } from "vitest";
import { planOverview } from "./overview";
import type { BoardNode, BoardSection, BoardStatus } from "./taskBoard";

const task = (n: number, status: BoardStatus, extra: Partial<BoardNode> = {}): BoardNode => ({
  id: `task-${n}`,
  title: `Title ${n}`,
  index: n,
  status,
  ...extra,
});

const section = (
  statuses: (BoardStatus | [BoardStatus, Partial<BoardNode>])[],
  extra: Partial<BoardSection> = {},
): BoardSection => {
  const nodes = statuses.map((s, i) => (Array.isArray(s) ? task(i + 1, s[0], s[1]) : task(i + 1, s)));
  return {
    source: "sdd",
    id: "sdd:x",
    title: "X",
    done: nodes.filter((n) => n.status === "done").length,
    total: nodes.length,
    nodes,
    ...extra,
  };
};

const final = (status: BoardStatus): BoardNode => ({ id: "final-review", title: "Last review", status });

describe("planOverview counts", () => {
  it("counts each status", () => {
    const o = planOverview(
      section(["done", "done", "done", "running", ["attention", { fixRounds: 3 }], "blocked", "failed", "pending", "pending"]),
    );
    expect(o.tasks).toEqual({ total: 9, done: 3, running: 1, attention: 1, failed: 1, blocked: 1, pending: 2 });
  });

  it("is all zeros for a plan with no tasks", () => {
    const o = planOverview(section([]));
    expect(o.tasks).toEqual({ total: 0, done: 0, running: 0, attention: 0, failed: 0, blocked: 0, pending: 0 });
    expect(o.left).toBe(0);
    expect(o.problems).toEqual([]);
    expect(o.segments).toEqual([]);
    expect(o.current).toBeUndefined();
    expect("steps" in o).toBe(false);
  });

  it("does not count a cancelled task under any status", () => {
    const o = planOverview(section(["done", "cancelled"]));
    expect(o.tasks).toMatchObject({ total: 2, done: 1, pending: 0 });
    expect(o.left).toBe(1);
  });
});

describe("planOverview left", () => {
  it("is the tasks not done", () => {
    expect(planOverview(section(["done", "running", "pending"])).left).toBe(2);
  });

  it("adds the final review when it is not done", () => {
    for (const status of ["pending", "running", "attention"] as const) {
      expect(planOverview(section(["done", "running", "pending"], { finalReview: final(status) })).left).toBe(3);
    }
    expect(planOverview(section(["done", "done"], { finalReview: final("pending") })).left).toBe(1);
  });

  it("does not add a final review that is done or missing", () => {
    expect(planOverview(section(["done", "running"], { finalReview: final("done") })).left).toBe(1);
    expect(planOverview(section(["done", "running"])).left).toBe(1);
  });

  it("is 0 when everything including the final review is done", () => {
    expect(planOverview(section(["done", "done"], { finalReview: final("done") })).left).toBe(0);
    expect(planOverview(section(["done", "done"])).left).toBe(0);
  });
});

describe("planOverview steps", () => {
  it("copies the section's step counts when known", () => {
    expect(planOverview(section(["done"], { steps: { done: 14, total: 31 } })).steps).toEqual({ done: 14, total: 31 });
  });

  it("leaves steps out when unknown", () => {
    expect("steps" in planOverview(section(["done"]))).toBe(false);
  });
});

describe("planOverview current", () => {
  it("is the running task, labelled by its number", () => {
    expect(planOverview(section(["done", "done", "done", "running", "pending"])).current).toEqual({
      id: "task-4",
      label: "Task 4",
    });
  });

  it("is the attention task when nothing else runs", () => {
    expect(planOverview(section(["done", ["attention", { fixRounds: 3 }], "pending"])).current).toEqual({
      id: "task-2",
      label: "Task 2",
    });
  });

  it("prefers the first running or attention task in plan order", () => {
    expect(planOverview(section([["attention", { fixRounds: 4 }], "running"])).current?.id).toBe("task-1");
  });

  it("is absent when nothing runs", () => {
    expect(planOverview(section(["done", "blocked", "pending"])).current).toBeUndefined();
    expect(planOverview(section(["done", "done"])).current).toBeUndefined();
  });

  it("falls back to the position when a node has no index", () => {
    const s = section(["done", "running"]);
    delete s.nodes[1].index;
    expect(planOverview(s).current).toEqual({ id: "task-2", label: "Task 2" });
  });
});

describe("planOverview problems", () => {
  it("lists failed, blocked and heavily fixed tasks in plan order with plain reasons", () => {
    const o = planOverview(
      section([
        "done",
        "failed",
        ["attention", { fixRounds: 3 }],
        "running",
        "blocked",
        ["attention", { fixRounds: 4 }],
        "pending",
      ]),
    );
    expect(o.problems).toEqual([
      { id: "task-2", label: "Task 2", why: "failed" },
      { id: "task-3", label: "Task 3", why: "fix 3 of 5" },
      { id: "task-5", label: "Task 5", why: "blocked" },
      { id: "task-6", label: "Task 6", why: "fix 4 of 5" },
    ]);
  });

  it("caps the fix round at 5", () => {
    expect(planOverview(section([["attention", { fixRounds: 9 }]])).problems[0]?.why).toBe("fix 5 of 5");
    expect(planOverview(section([["attention", { fixRounds: 5 }]])).problems[0]?.why).toBe("fix 5 of 5");
  });

  it("ignores an attention task with fewer than 3 fix rounds, or none recorded", () => {
    expect(planOverview(section([["attention", { fixRounds: 2 }], "attention"])).problems).toEqual([]);
  });

  it("is empty for a healthy plan, and a done task is never a problem", () => {
    expect(planOverview(section(["done", ["done", { fixRounds: 4 }], "running", "pending"])).problems).toEqual([]);
  });

  it("does not list the final review", () => {
    expect(planOverview(section(["done"], { finalReview: final("attention") })).problems).toEqual([]);
  });
});

describe("planOverview segments", () => {
  it("has one per task in plan order, then the final review", () => {
    const o = planOverview(section(["done", "running", "pending"], { finalReview: final("pending") }));
    expect(o.segments).toEqual([
      { id: "task-1", status: "done" },
      { id: "task-2", status: "running" },
      { id: "task-3", status: "pending" },
      { id: "final-review", status: "pending" },
    ]);
  });

  it("carries the final review's own status", () => {
    for (const status of ["done", "running", "attention"] as const) {
      expect(planOverview(section(["done"], { finalReview: final(status) })).segments.at(-1)).toEqual({
        id: "final-review",
        status,
      });
    }
  });

  it("has no final segment without a final review", () => {
    expect(planOverview(section(["done", "done"])).segments).toHaveLength(2);
  });
});
