import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBrief, parseLedger, reportStatus } from "./sddLedger";

const FIXTURE = join(process.cwd(), "test-fixtures/sdd/skills-index");
const read = (name: string) => readFileSync(join(FIXTURE, name), "utf8");

describe("parseLedger (real fixture)", () => {
  const ledger = parseLedger(read("progress.md"));
  const task = (n: number) => ledger.tasks.find((t) => t.n === n);

  it("reads the plan path from the header", () => {
    expect(ledger.planPath).toBe(
      "docs/superpowers/plans/2026-10-07-skills-index-remote-ranking.md",
    );
  });

  it("task 1 is complete with commits and a clean review", () => {
    expect(task(1)?.complete).toEqual({
      commits: "ebb5db1..129e9e2",
      clean: true,
      parked: 0,
    });
  });

  it("task 2 keeps the implemented verdict and one done fix round", () => {
    const t = task(2);
    expect(t?.implemented?.sha).toBe("95f86ae");
    expect(t?.implemented?.verdict.startsWith("spec ❌")).toBe(true);
    expect(t?.fixes).toEqual([
      {
        round: 1,
        state: "done",
        addressed: 2,
        open: 0,
        commits: "95f86ae..e704fdd",
      },
    ]);
  });

  it("task 7 is complete without commits", () => {
    const complete = task(7)?.complete;
    expect(complete).toBeDefined();
    expect(complete?.commits).toBeUndefined();
    expect(complete?.clean).toBe(true);
    expect(complete?.parked).toBe(0);
  });

  it("collects rulings with and without a Task prefix", () => {
    expect(ledger.rulings.length).toBeGreaterThanOrEqual(9);
    expect(ledger.rulings.some((r) => r.taskIndex === undefined)).toBe(true);
    const mid = ledger.rulings.find((r) => r.taskIndex === 3);
    expect(mid?.text.startsWith("Task 4 must await")).toBe(true);
    const prefixed = ledger.rulings.find((r) => r.taskIndex === 2);
    expect(
      prefixed?.text.startsWith("SkillsPage uses loadDiscoveredSkills"),
    ).toBe(true);
  });

  it("collects minors per task", () => {
    expect(ledger.minors.some((m) => m.taskIndex === 1)).toBe(true);
    expect(
      ledger.minors.some(
        (m) => m.taskIndex === 6 && m.text.startsWith("RemoteSession records"),
      ),
    ).toBe(true);
  });

  it("reads the final review and fix wave", () => {
    expect(ledger.final.review).toContain("Ready to ship");
    expect(ledger.final.fixWave).toBe("complete");
  });

  it("fix rounds dispatched then done end up as a single round", () => {
    expect(task(3)?.fixes).toHaveLength(1);
    expect(task(3)?.fixes[0].state).toBe("done");
  });
});

describe("parseLedger (unit)", () => {
  it("returns empty collections for empty text", () => {
    expect(parseLedger("")).toEqual({
      planPath: undefined,
      tasks: [],
      rulings: [],
      minors: [],
      parked: [],
      final: {},
    });
  });

  it("returns only the plan path for a header-only ledger", () => {
    const l = parseLedger("# SDD ledger — plan: docs/plan.md\n");
    expect(l.planPath).toBe("docs/plan.md");
    expect(l.tasks).toEqual([]);
  });

  it("ignores unknown lines", () => {
    const l = parseLedger(
      "hello\nTask x: nonsense\nTask 1: wat\n\n| table |\nTask 2: fix round oops",
    );
    expect(l.tasks).toEqual([]);
    expect(l.rulings).toEqual([]);
  });

  it("tracks a dispatched fix round and parked notes", () => {
    const l = parseLedger(
      [
        "Task 4: fix round 2/5 dispatched; FIX_BASE=abc",
        "Task 4: parked — needs a human",
        "Task 4: complete (commits a..b, review 2 parked)",
      ].join("\n"),
    );
    expect(l.tasks[0].fixes).toEqual([{ round: 2, state: "dispatched" }]);
    expect(l.parked).toEqual([{ taskIndex: 4, text: "needs a human" }]);
    expect(l.tasks[0].complete).toEqual({
      commits: "a..b",
      clean: false,
      parked: 2,
    });
  });

  it("handles CRLF line endings and a dispatched final wave", () => {
    const l = parseLedger(
      "# SDD ledger — plan: p.md\r\nFinal fix wave: dispatched\r\n",
    );
    expect(l.planPath).toBe("p.md");
    expect(l.final.fixWave).toBe("dispatched");
  });

  it("sorts tasks by number", () => {
    const l = parseLedger("Task 3: complete — x\nTask 1: complete — y");
    expect(l.tasks.map((t) => t.n)).toEqual([1, 3]);
  });
});

describe("parseBrief", () => {
  it("reads the title and steps of task 2's brief", () => {
    const b = parseBrief(read("task-2-brief.md"));
    expect(b.title).toBe("Watcher, event, frontend invalidation");
    expect(b.steps).toHaveLength(5);
    expect(b.steps[0]).not.toContain("**");
  });

  it("accepts the fully bold step form", () => {
    const b = parseBrief(
      "### Task 9: Thing\n- [ ] **Step 1: Write tests** now\n- [x] **Step 2:** Ship",
    );
    expect(b.steps).toEqual(["Step 1: Write tests now", "Step 2: Ship"]);
  });

  it("returns no steps when there are no checkbox lines", () => {
    expect(parseBrief("no steps here")).toEqual({
      title: undefined,
      steps: [],
    });
  });
});

describe("reportStatus", () => {
  it("reads DONE_WITH_CONCERNS from task 2's report", () => {
    expect(reportStatus(read("task-2-report.md"))).toBe("DONE_WITH_CONCERNS");
  });

  it("tolerates a suffix after the status word", () => {
    expect(reportStatus(read("task-4-report.md"))).toBe("DONE_WITH_CONCERNS");
  });

  it("returns undefined without a recognised status", () => {
    expect(reportStatus("nothing\nStatus: WHATEVER")).toBeUndefined();
    expect(reportStatus("")).toBeUndefined();
  });

  it("recognises the other statuses", () => {
    expect(reportStatus("Status: DONE")).toBe("DONE");
    expect(reportStatus("Status: BLOCKED")).toBe("BLOCKED");
    expect(reportStatus("Status: NEEDS_CONTEXT")).toBe("NEEDS_CONTEXT");
  });
});
