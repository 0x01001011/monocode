import { gapsFor } from "./gaps";
import { shortSha, type BoardNode, type BoardSection } from "./taskBoard";
import type { TestRun } from "./testRuns";

export type ShipItem = {
  id: "tasks" | "final" | "tests" | "gaps";
  /** `"unknown"`: not claimed either way (never run, piped, still running). Not ready, but not a failure. */
  met: boolean | "unknown";
  text: string;
  /** The row that reveals the unmet item. */
  nodeId?: string;
};

export type Ship = {
  /** Every item is met. Deferred items never block. */
  ready: boolean;
  items: ShipItem[];
  /** Items not met (unknown counts). */
  left: number;
  /** Parked plus small issues saved for the end. */
  deferred: number;
  /** Distinct commits across tasks and stages. */
  commits: number;
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function testsItem(run: TestRun | undefined): ShipItem {
  if (!run) return { id: "tests", met: "unknown", text: "no test run yet" };
  switch (run.status) {
    case "passed":
      return { id: "tests", met: true, text: "tests passed" };
    case "failed":
      return { id: "tests", met: false, text: "tests failed" };
    case "running":
      return { id: "tests", met: "unknown", text: "tests running" };
    default:
      return { id: "tests", met: "unknown", text: "test result unknown" };
  }
}

function countCommits(section: BoardSection): number {
  const seen = new Set<string>();
  const add = (node: BoardNode) => {
    if (node.commits) for (const sha of shortSha(node.commits)) seen.add(sha);
    for (const stage of node.stages ?? []) if (stage.sha) for (const sha of shortSha(stage.sha)) seen.add(sha);
  };
  for (const node of section.nodes) add(node);
  if (section.finalReview) add(section.finalReview);
  return seen.size;
}

/**
 * Whether the branch can ship, from files already read: every task done, a clean final
 * review, a passing last test run and no gaps. No git or GitHub calls. Pure.
 */
export function shipReadiness(section: BoardSection, testRun: TestRun | undefined): Ship {
  const left = Math.max(0, section.total - section.done);
  const open = section.nodes.find((n) => n.status !== "done");
  const tasks: ShipItem =
    left === 0
      ? { id: "tasks", met: true, text: "every task done" }
      : { id: "tasks", met: false, text: `${plural(left, "task", "tasks")} left`, ...(open ? { nodeId: open.id } : {}) };
  const final: ShipItem =
    section.finalReview?.status === "done"
      ? { id: "final", met: true, text: "final review clean" }
      : { id: "final", met: false, text: "final review not done", nodeId: "final-review" };
  // A missing final review is the "final" item's business; counting it here too would say two things for one.
  const gaps = gapsFor(section).filter((g) => g.kind !== "no-final-review");
  const gapItem: ShipItem = gaps.length === 0
    ? { id: "gaps", met: true, text: "no gaps" }
    : { id: "gaps", met: false, text: plural(gaps.length, "gap", "gaps"), nodeId: gaps[0]!.nodeId };
  const items = [tasks, final, testsItem(testRun), gapItem];
  const unmet = items.filter((i) => i.met !== true).length;
  return {
    ready: unmet === 0,
    items,
    left: unmet,
    deferred: (section.parked?.length ?? 0) + (section.minors?.length ?? 0),
    commits: countCommits(section),
  };
}
