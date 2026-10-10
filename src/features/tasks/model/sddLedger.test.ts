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
      reviewClean: true,
    });
  });

  it("task 2 keeps the implemented verdict and one done fix round", () => {
    const t = task(2);
    expect(t?.implemented?.sha).toBe("95f86ae");
    expect(t?.implemented?.verdict?.startsWith("spec ❌")).toBe(true);
    expect(t?.fixes).toEqual([
      {
        round: 1,
        state: "done",
        addressed: 2,
        open: 0,
        commits: "95f86ae..e704fdd",
        base: "95f86ae",
      },
    ]);
  });

  it("task 7 is complete without commits", () => {
    const complete = task(7)?.complete;
    expect(complete).toBeDefined();
    expect(complete?.commits).toBeUndefined();
    expect(complete?.clean).toBe(true);
    expect(complete?.parked).toBe(0);
    expect(complete?.reviewClean).toBe(false);
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

describe("parseLedger (controller formats fixture)", () => {
  const ledger = parseLedger(
    readFileSync(join(process.cwd(), "test-fixtures/sdd/controller-formats/progress.md"), "utf8"),
  );
  const task = (n: number) => ledger.tasks.find((t) => t.n === n);

  it("reads `implemented (sha); review pending` as implemented with no verdict yet", () => {
    expect(task(1)?.implemented).toEqual({ sha: "2b33c9d" });
    expect(task(5)?.implemented).toEqual({ sha: "f7ded6c" });
  });

  it("reads a bare `implemented (sha)` and the old `; review:` form", () => {
    expect(task(3)?.implemented).toEqual({ sha: "423e98a" });
    expect(task(2)?.implemented).toEqual({ sha: "cbe0ed2", verdict: "spec ✅" });
  });

  it("a separate `Task N: review:` line sets the verdict", () => {
    expect(task(4)?.implemented?.sha).toBe("f64a336");
    expect(task(4)?.implemented?.verdict).toMatch(/^spec ❌ \(DONE_WITH_CONCERNS vs spec\), Important x2/);
  });

  it("keeps the commits of a fix round whose finding holds parentheses", () => {
    expect(task(4)?.fixes).toEqual([
      { round: 1, state: "done", addressed: 3, open: 1, commits: "f64a336..bd63c32", base: "f64a336" },
      { round: 2, state: "done", addressed: 2, open: 0, commits: "bd63c32..7c2c240", base: "bd63c32" },
    ]);
  });

  it("a fix round whose code is in but whose re-review is pending stays dispatched with its sha", () => {
    expect(task(5)?.fixes).toEqual([{ round: 1, state: "dispatched", base: "f7ded6c", implementedSha: "4220ff1" }]);
  });

  it("a parked line is a parked note with its full text, not a ruling", () => {
    expect(ledger.parked).toEqual([
      {
        taskIndex: 2,
        text: "no boundary tests for 59_999 and 60_000 — Ruling: the final review decides whether they are worth adding",
      },
    ]);
    expect(ledger.rulings.map((r) => r.text)).not.toContain("the final review decides whether they are worth adding");
    expect(ledger.rulings).toHaveLength(3);
    expect(task(2)?.complete).toMatchObject({ parked: 1, clean: false });
  });

  it("records whether the complete line says the review was clean", () => {
    expect(task(1)?.complete?.reviewClean).toBe(true);
    expect(task(3)?.complete?.reviewClean).toBe(false);
    expect(task(4)?.complete?.reviewClean).toBe(true);
  });

  it("reads the final review and a dispatched wave", () => {
    expect(ledger.final.review).toContain("Ready with fixes");
    expect(ledger.final.fixWave).toBe("dispatched");
  });
});

describe("parseLedger (unit)", () => {
  it("a ruling inside a task line keeps the task's state change", () => {
    const l = parseLedger("Task 2: implemented (abc1234); review: spec ✅. Ruling: keep the cache — cost: none");
    expect(l.tasks[0].implemented).toEqual({ sha: "abc1234", verdict: "spec ✅. Ruling: keep the cache — cost: none" });
    expect(l.rulings).toEqual([{ taskIndex: 2, text: "keep the cache — cost: none" }]);
  });

  it("takes the sha as the first token of an implemented line's parentheses", () => {
    const l = parseLedger("Task 3: implemented (423e98a, by a fresh agent); review pending");
    expect(l.tasks[0].implemented).toEqual({ sha: "423e98a" });
  });

  it("a later `review:` line overrides nothing but the verdict", () => {
    const l = parseLedger(["Task 6: review: spec ✅", "Task 6: implemented (abc1234); review pending"].join("\n"));
    expect(l.tasks[0].implemented).toEqual({ sha: "abc1234", verdict: "spec ✅" });
  });

  it("a FINAL REVIEW line that mentions a Ruling stays the final review", () => {
    const l = parseLedger("FINAL REVIEW (opus, a1b2c3d..d4e5f6a): Ready to merge. Ruling: none needed");
    expect(l.final.review).toBe("(opus, a1b2c3d..d4e5f6a): Ready to merge. Ruling: none needed");
    expect(l.rulings).toEqual([]);
  });

  it("a minor line that mentions a Ruling stays a minor", () => {
    const l = parseLedger("Task 3: minor (deferred): the Ruling: x is untested");
    expect(l.minors).toEqual([{ taskIndex: 3, text: "the Ruling: x is untested" }]);
    expect(l.rulings).toEqual([]);
  });

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
        "Task 4: fix round 2/5 dispatched; FIX_BASE=abc1234",
        "Task 4: parked — needs a human",
        "Task 4: complete (commits a..b, review 2 parked)",
      ].join("\n"),
    );
    expect(l.tasks[0].fixes).toEqual([{ round: 2, state: "dispatched", base: "abc1234" }]);
    expect(l.parked).toEqual([{ taskIndex: 4, text: "needs a human" }]);
    expect(l.tasks[0].complete).toEqual({
      commits: "a..b",
      clean: false,
      parked: 2,
      reviewClean: false,
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

describe("parseLedger spec path", () => {
  const specOf = (...lines: string[]) => parseLedger(lines.join("\n")).specPath;

  it("reads the Spec line of the real ledgers", () => {
    expect(parseLedger(read("progress.md")).specPath).toBe(
      "docs/superpowers/specs/2026-10-07-skills-index-remote-ranking-design.md",
    );
    const formats = readFileSync(join(process.cwd(), "test-fixtures/sdd/controller-formats/progress.md"), "utf8");
    expect(parseLedger(formats).specPath).toBe("docs/superpowers/specs/2026-10-09-tasks-panel-design.md");
  });

  it("drops a trailing parenthetical and trailing punctuation", () => {
    expect(specOf("Spec: docs/specs/a.md (+ prototypes/x/index.html, PRODUCT.md)")).toBe("docs/specs/a.md");
    expect(specOf("Spec: docs/specs/a.md.")).toBe("docs/specs/a.md");
    expect(specOf("Spec: `docs/specs/a.md`,")).toBe("docs/specs/a.md");
  });

  it("takes the first token that is a repo-style file path", () => {
    expect(specOf("Spec: see design.md and more")).toBe("design.md");
    expect(specOf("Spec: docs/a.md docs/b.md")).toBe("docs/a.md");
    expect(specOf("Spec: docs/notes.TXT")).toBe("docs/notes.TXT");
    expect(specOf("Spec: docs/spec.mdx")).toBe("docs/spec.mdx");
    expect(specOf("Spec: [the design](docs/specs/a.md)")).toBe("docs/specs/a.md");
  });

  it.each([
    ["docs/specs/a.md#goals", "docs/specs/a.md"],
    ["docs/specs/a.md:42", "docs/specs/a.md"],
    ["docs/specs/a.md:42:7", "docs/specs/a.md"],
    ["docs/specs/a.md:12#top", "docs/specs/a.md"],
    ["`docs/specs/a.md#goals`", "docs/specs/a.md"],
    ['"docs/specs/a.md"', "docs/specs/a.md"],
    ["'docs/specs/a.md',", "docs/specs/a.md"],
    ["<docs/specs/a.md>", "docs/specs/a.md"],
    ["**docs/specs/a.md**", "docs/specs/a.md"],
    ["(docs/specs/a.md)", undefined],
    ["C:\\work\\specs\\a.md", "C:\\work\\specs\\a.md"],
    ["C:/work/specs/a.md:3", "C:/work/specs/a.md"],
    ["C:\\work\\specs\\a.txt", undefined],
    ["/abs/specs/a.md", "/abs/specs/a.md"],
  ])("cleans %s", (value, expected) => {
    expect(specOf(`Spec: ${value}`)).toBe(expected);
  });

  it.each([
    "n/a",
    "N/A",
    "TBD / pending",
    "and/or",
    "1/2",
    "docs/specs/a",
    "docs/specs/",
    "the docs/specs/a design",
    "https://example.com/specs/a.md",
    "http://example.com/a.md#x",
    "file:///tmp/a.md",
    "docs/spec.pdf",
    "docs/spec.md.bak",
  ])("rejects %s", (value) => {
    expect(specOf(`Spec: ${value}`)).toBeUndefined();
  });

  it("takes a path with spaces whole when the line is exactly that path", () => {
    expect(specOf("Spec: docs/my spec.md")).toBe("docs/my spec.md");
    expect(specOf("Spec: docs/my specs/final spec.md")).toBe("docs/my specs/final spec.md");
    expect(specOf("Spec: docs/my spec.md (+ prototypes/x.html)")).toBe("docs/my spec.md");
    expect(specOf("Spec: `docs/my spec.md`")).toBe("docs/my spec.md");
    expect(specOf("Spec: docs/my spec.md#goals")).toBe("docs/my spec.md");
  });

  it("does not glue words to a path", () => {
    expect(specOf("Spec: see docs/spec.md")).toBe("docs/spec.md");
    expect(specOf("Spec: docs/a.md and docs/b.md")).toBe("docs/a.md");
    expect(specOf("Spec: docs/a.md, docs/b.md")).toBe("docs/a.md");
    expect(specOf("Spec: docs/a.md approved")).toBe("docs/a.md");
  });

  it("ignores a line with no path-like token", () => {
    expect(specOf("Spec: TBD")).toBeUndefined();
    expect(specOf("Spec:")).toBeUndefined();
    expect(specOf("Spec: (see docs/specs/a.md)")).toBeUndefined();
  });

  it("is absent without a Spec line, and a Task line never counts", () => {
    expect(specOf("# SDD ledger — plan: docs/plans/p.md")).toBeUndefined();
    expect(specOf("Task 1: Spec: docs/specs/a.md")).toBeUndefined();
  });

  it("the first usable Spec line wins", () => {
    expect(specOf("Spec: nothing here", "Spec: docs/specs/a.md", "Spec: docs/specs/b.md")).toBe("docs/specs/a.md");
    expect(specOf("Spec: n/a", "Spec: https://x.dev/a.md", "Spec: docs/specs/b.md", "Spec: docs/specs/c.md")).toBe(
      "docs/specs/b.md",
    );
  });
});
