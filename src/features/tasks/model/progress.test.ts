import { describe, expect, it } from "vitest";
import { timeLine } from "./progress";
import type { BoardNode, BoardSection } from "./taskBoard";

const MIN = 60_000;
const T0 = 1_000_000_000_000;

function task(n: number, patch: Partial<BoardNode> = {}): BoardNode {
  return { id: `task-${n}`, title: `T${n}`, index: n, status: "done", startedAt: T0 + (n - 1) * 10 * MIN, endedAt: T0 + n * 10 * MIN, ...patch };
}

function plan(done: number, total: number, patch: Partial<BoardSection> = {}): BoardSection {
  const nodes = Array.from({ length: total }, (_, i) =>
    i < done ? task(i + 1) : task(i + 1, { status: "pending", startedAt: undefined, endedAt: undefined }),
  );
  return { source: "sdd", id: "sdd:a", title: "A", done, total, startedAt: T0, nodes, ...patch };
}

describe("timeLine", () => {
  it("says how long it has run, without the counts", () => {
    expect(timeLine(plan(2, 5), T0 + 25 * MIN)).toBe("25m so far");
  });

  it("adds the estimate from the third finished task", () => {
    expect(timeLine(plan(2, 5), T0 + 25 * MIN)).not.toContain("about");
    expect(timeLine(plan(3, 5), T0 + 50 * MIN)).toBe("50m so far · about 20m left");
  });

  it("says how long a finished plan took, ending at the last task", () => {
    expect(timeLine(plan(3, 3), T0 + 999 * MIN)).toBe("took 30m");
  });

  it("is undefined when the start is unknown", () => {
    expect(timeLine(plan(1, 3, { startedAt: undefined }), T0 + 5 * MIN)).toBeUndefined();
  });

  it("drops the estimate when no finished task has both times", () => {
    const p = plan(3, 5);
    p.nodes = p.nodes.map((n) => ({ ...n, startedAt: undefined }));
    expect(timeLine(p, T0 + 50 * MIN)).toBe("50m so far");
  });
});
