import { describe, expect, it } from "vitest";
import { gapsFor } from "./gaps";
import { shipReadiness } from "./ship";
import { planSummaryMarkdown } from "./summary";
import type { BoardNode, BoardSection } from "./taskBoard";

const stage = (kind: "implement" | "review" | "fix", status: "done" | "attention", sha?: string) => ({
  kind,
  label: kind,
  status,
  ...(sha ? { sha } : {}),
});

function fixture(over: Partial<BoardSection> = {}): BoardSection {
  const nodes: BoardNode[] = [
    { id: "task-1", title: "Parse the ledger", index: 1, status: "done", commits: "1111111aaaaa", stages: [stage("implement", "done", "1111111aaaaa"), stage("review", "done")] },
    { id: "task-2", title: "Draw the lanes", index: 2, status: "done", commits: "2222222bbbb..4444444dddd", fixRounds: 2, parkedAtClose: 1, stages: [stage("implement", "done", "2222222bbbb"), stage("review", "attention"), stage("fix", "done", "4444444dddd")] },
    { id: "task-3", title: "Ship node", index: 3, status: "running" },
  ];
  return {
    source: "sdd",
    id: "sdd:p",
    title: "Tasks graph",
    done: 2,
    total: 3,
    nodes,
    steps: { done: 8, total: 12 },
    parked: [{ taskIndex: 2, text: "Rename lane helper" }],
    minors: [{ text: "Tidy a comment" }],
    ...over,
  };
}

describe("planSummaryMarkdown", () => {
  it("summarises a three-task plan", () => {
    const s = fixture();
    const ship = shipReadiness(s, undefined);
    expect(planSummaryMarkdown(s, ship, gapsFor(s))).toMatchInlineSnapshot(`
      "# Tasks graph

      2 of 3 tasks done · 8 of 12 steps · 3 commits

      - [x] Task 1: Parse the ledger · review clean · 1111111
      - [x] Task 2: Draw the lanes · fixed in 2 rounds · 2222222..4444444
      - [ ] Task 3: Ship node · not reviewed · no commit

      Deferred
      - Task 2: Rename lane helper
      - Tidy a comment

      Gaps
      - Task 2: closed with 1 parked

      Ship: 4 things before ship
      "
    `);
  });

  it("says ready to ship and skips the empty lists", () => {
    const s = fixture({ done: 3, parked: [], minors: [] });
    s.nodes[2] = { ...s.nodes[2]!, status: "done", commits: "5555555", stages: [stage("implement", "done", "5555555"), stage("review", "done")] };
    s.nodes[1] = { ...s.nodes[1]!, parkedAtClose: 0 };
    s.finalReview = { id: "final-review", title: "Last review", status: "done" };
    const ship = shipReadiness(s, { status: "passed", command: "npm test" });
    const md = planSummaryMarkdown(s, ship, gapsFor(s));
    expect(md).not.toContain("Deferred");
    expect(md).not.toContain("Gaps");
    expect(md.trimEnd().endsWith("Ship: Ready to ship")).toBe(true);
  });

  it("says one thing in the singular", () => {
    const s = fixture({ done: 3, parked: [], minors: [] });
    s.nodes[2] = { ...s.nodes[2]!, status: "done", commits: "5555555" };
    s.nodes[1] = { ...s.nodes[1]!, parkedAtClose: 0 };
    s.finalReview = { id: "final-review", title: "Last review", status: "done" };
    const ship = shipReadiness(s, undefined);
    expect(planSummaryMarkdown(s, ship, gapsFor(s))).toContain("Ship: 1 thing before ship");
  });
});
