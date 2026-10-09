import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSddSection, type SddSnapshot } from "./sddBoard";

const FIXTURE = join(process.cwd(), "test-fixtures/sdd/skills-index");
const read = (name: string) => readFileSync(join(FIXTURE, name), "utf8");

// Invented mtimes (the fixture directory has none that survive a checkout).
// Every brief was written up front at 13:59:19 UTC; task N's report lands
// N * 10 minutes later (task 1 at 14:09:19, task 8 at 15:19:19). The review
// package for task 2's implementation lands 2 minutes after its report and the
// package for its fix round 7 minutes after (still before report 3).
const T0 = Date.UTC(2026, 9, 7, 13, 59, 19);
const MIN = 60_000;
const reportAt = (n: number) => T0 + n * 10 * MIN;
const NOW = T0 + 10 * 60 * MIN;

const REVIEW_T2 = { name: "review-129e9e2..95f86ae.diff", mtimeMs: reportAt(2) + 2 * MIN };
const REVIEW_T2_FIX = { name: "review-95f86ae..e704fdd.diff", mtimeMs: reportAt(2) + 7 * MIN };

function fixtureSnapshot(
  overrides: { ledgerText?: string; skipBriefs?: number[]; withReviews?: boolean } = {},
): SddSnapshot {
  const briefs: Record<number, string> = {};
  const reports: Record<number, string> = {};
  const mtimes: Record<string, number> = { "progress.md": T0 + 100 * MIN };
  for (let n = 1; n <= 8; n++) {
    if (!overrides.skipBriefs?.includes(n)) {
      briefs[n] = read(`task-${n}-brief.md`);
      mtimes[`task-${n}-brief.md`] = T0;
    }
    if (n <= 7) {
      reports[n] = read(`task-${n}-report.md`);
      mtimes[`task-${n}-report.md`] = reportAt(n);
    }
  }
  return {
    slug: "2026-10-07-skills-index-remote-ranking",
    dir: "/proj/.superpowers/sdd/2026-10-07-skills-index-remote-ranking",
    ledgerText: overrides.ledgerText ?? read("progress.md"),
    briefs,
    reports,
    mtimes,
    reviews: overrides.withReviews === false ? [] : [REVIEW_T2, REVIEW_T2_FIX],
  };
}

/** The fixture ledger cut after `Task 6: complete`. */
function ledgerThroughTask6(): string {
  const lines = read("progress.md").split("\n");
  const at = lines.findIndex((l) => l.startsWith("Task 6: complete"));
  return lines.slice(0, at + 1).join("\n");
}

/** Every time on the board is undefined or finite, and no span runs backwards. */
function expectSaneTimes(section: ReturnType<typeof buildSddSection>): void {
  const all = [...section.nodes, ...(section.finalReview ? [section.finalReview] : [])];
  for (const n of all) {
    for (const t of [n.startedAt, n.endedAt, ...(n.stages ?? []).flatMap((s) => [s.startedAt, s.endedAt])]) {
      if (t !== undefined) expect(Number.isFinite(t)).toBe(true);
    }
    if (n.startedAt !== undefined && n.endedAt !== undefined) {
      expect(n.endedAt).toBeGreaterThanOrEqual(n.startedAt);
    }
    for (const s of n.stages ?? []) {
      if (s.startedAt !== undefined && s.endedAt !== undefined) {
        expect(s.endedAt).toBeGreaterThanOrEqual(s.startedAt);
      }
    }
  }
  if (section.startedAt !== undefined) expect(Number.isFinite(section.startedAt)).toBe(true);
}

const node = (section: ReturnType<typeof buildSddSection>, n: number) =>
  section.nodes.find((x) => x.index === n)!;

describe("buildSddSection", () => {
  it("maps the real ledger to 5-of-8 style progress", () => {
    const section = buildSddSection(fixtureSnapshot({ ledgerText: ledgerThroughTask6() }), NOW);
    expect(section.source).toBe("sdd");
    expect(section.title).toBe("Skills index remote ranking");
    expect(section.total).toBe(8);
    expect(section.done).toBe(6);
    expect(node(section, 6).status).toBe("done");
    expect(node(section, 7).status).toBe("running");
    expect(node(section, 8).status).toBe("pending");
    expect(section.planPath).toBe(
      "docs/superpowers/plans/2026-10-07-skills-index-remote-ranking.md",
    );
  });

  it("titles and steps come from the brief, with the step label stripped", () => {
    const section = buildSddSection(fixtureSnapshot(), NOW);
    expect(node(section, 2).title).toBe("Watcher, event, frontend invalidation");
    const steps = node(section, 2).steps!;
    expect(steps).toHaveLength(5);
    expect(steps[0].text.startsWith("Rust test `watcher_bumps_revision_on_new_skill`")).toBe(true);
    expect(steps.every((s) => !/^Step\s+\d+/.test(s.text))).toBe(true);
  });

  it("done task with one fix round says fixed in 1 round", () => {
    const t2 = node(buildSddSection(fixtureSnapshot(), NOW), 2);
    expect(t2.status).toBe("done");
    expect(t2.fixRounds).toBe(1);
    expect(t2.commits).toBe("129e9e2..e704fdd");
    expect(t2.summary).toBe("Review found issues. Fixed in 1 round, then passed.");
    expect(t2.stages?.map((s) => [s.kind, s.label, s.status])).toEqual([
      ["implement", "Implement", "done"],
      ["review", "Review", "attention"],
      ["fix", "R1", "done"],
    ]);
  });

  it("a done task with no fixes passed first review", () => {
    const t1 = node(buildSddSection(fixtureSnapshot(), NOW), 1);
    expect(t1.summary).toBe("Passed first review.");
  });

  it("a fixed task without verdict text says passed after N fixes", () => {
    const ledger = [
      "Task 1: fix round 1/5 dispatched",
      "Task 1: fix round 1/5 (1 addressed, 0 open; commits a1b2c3d..e4f5a6b)",
      "Task 1: fix round 2/5 dispatched",
      "Task 1: fix round 2/5 (1 addressed, 0 open; commits e4f5a6b..0102030)",
      "Task 1: complete (commits a1b2c3d..0102030, review clean)",
    ].join("\n");
    const t1 = node(buildSddSection(fixtureSnapshot({ ledgerText: ledger }), NOW), 1);
    expect(t1.summary).toBe("Passed after 2 fixes.");
  });

  it("running task past round 3 is attention", () => {
    const ledger = `${ledgerThroughTask6()}\nTask 7: fix round 3/5 dispatched\n`;
    const t7 = node(buildSddSection(fixtureSnapshot({ ledgerText: ledger }), NOW), 7);
    expect(t7.status).toBe("attention");
    expect(t7.fixRounds).toBe(3);
    expect(t7.stages?.at(-1)).toMatchObject({ kind: "fix", label: "R3", status: "running" });
  });

  it("blocked report marks blocked", () => {
    const snap = fixtureSnapshot({ ledgerText: ledgerThroughTask6() });
    snap.reports[7] = "# Task 7 report\n\nStatus: BLOCKED\n";
    const section = buildSddSection(snap, NOW);
    expect(node(section, 7).status).toBe("blocked");
    expect(node(section, 8).status).toBe("pending");
  });

  it("DONE_WITH_CONCERNS on the running task does not change its status", () => {
    const section = buildSddSection(fixtureSnapshot({ ledgerText: ledgerThroughTask6() }), NOW);
    expect(node(section, 7).status).toBe("running");
  });

  it("steps are done only when the task is done", () => {
    const lines = read("progress.md").split("\n");
    const through5 = lines
      .slice(0, lines.findIndex((l) => l.startsWith("Task 5: complete")) + 1)
      .join("\n");
    const section = buildSddSection(fixtureSnapshot({ ledgerText: through5 }), NOW);
    expect(node(section, 5).steps!.length).toBeGreaterThan(0);
    expect(node(section, 5).steps!.every((s) => s.done)).toBe(true);
    expect(node(section, 6).status).toBe("running");
    expect(node(section, 6).steps).toHaveLength(4);
    expect(node(section, 6).steps!.every((s) => !s.done)).toBe(true);
  });

  it("task without a brief keeps number-only title", () => {
    const section = buildSddSection(fixtureSnapshot({ skipBriefs: [3] }), NOW);
    expect(node(section, 3).title).toBe("Task 3");
    expect(node(section, 3).steps ?? []).toEqual([]);
    expect(node(section, 4).title).toBe("Ranking with usage (TS)");
  });

  it("later tasks stay pending even with a stray brief", () => {
    const section = buildSddSection(fixtureSnapshot({ ledgerText: ledgerThroughTask6() }), NOW);
    expect(node(section, 8).status).toBe("pending");
    expect(node(section, 8).startedAt).toBeUndefined();
    expect(node(section, 8).stages).toBeUndefined();
  });

  it("final review node pending until the ledger names it", () => {
    const early = buildSddSection(fixtureSnapshot({ ledgerText: ledgerThroughTask6() }), NOW);
    expect(early.finalReview).toMatchObject({
      status: "pending",
      title: "Last review of the whole branch",
    });

    const ledger = read("progress.md");
    const full = buildSddSection(fixtureSnapshot(), NOW);
    expect(ledger).toContain("Final fix wave: complete");
    expect(full.finalReview?.status).toBe("done");

    const midWave = ledger.replace("Final fix wave: complete", "Final fix wave: dispatched");
    const running = buildSddSection(fixtureSnapshot({ ledgerText: midWave }), NOW);
    expect(running.finalReview?.status).toBe("running");
  });

  it("decisions come from rulings with task index", () => {
    const section = buildSddSection(fixtureSnapshot(), NOW);
    expect(section.decisions!.length).toBeGreaterThanOrEqual(8);
    expect(section.decisions).toContainEqual(
      expect.objectContaining({
        taskIndex: 2,
        text: expect.stringContaining("SkillsPage uses loadDiscoveredSkills"),
      }),
    );
    expect(section.decisions!.some((d) => d.taskIndex === undefined)).toBe(true);
    expect(section.minors!.some((m) => m.taskIndex === 1)).toBe(true);
    expect(section.parked).toEqual([]);
  });

  it("durations come from mtimes and are undefined when missing", () => {
    const section = buildSddSection(fixtureSnapshot(), NOW);
    expect(section.startedAt).toBe(T0);
    const t1 = node(section, 1);
    expect(t1.startedAt).toBe(T0);
    expect(t1.endedAt).toBe(reportAt(1)); // no review package: falls back to the report
    const t2 = node(section, 2);
    expect(t2.startedAt).toBe(t1.endedAt);
    expect(t2.endedAt).toBe(REVIEW_T2_FIX.mtimeMs); // last package before report 3
    expect(node(section, 3).startedAt).toBe(t2.endedAt);
    expect(t2.stages![0].endedAt).toBe(reportAt(2));
    expect(t2.stages![1].startedAt).toBe(REVIEW_T2.mtimeMs);
    expect(t2.stages![2].endedAt).toBe(REVIEW_T2_FIX.mtimeMs);

    const bare = fixtureSnapshot();
    bare.mtimes = {};
    bare.reviews = [];
    const none = buildSddSection(bare, NOW);
    expect(none.startedAt).toBeUndefined();
    for (const n of none.nodes) {
      expect(n.startedAt).toBeUndefined();
      expect(n.endedAt).toBeUndefined();
    }
    expectSaneTimes(none);
  });

  it("DONE_WITH_CONCERNS report keeps the task running", () => {
    const snap = fixtureSnapshot({ ledgerText: ledgerThroughTask6() });
    snap.reports[7] = "Status: DONE_WITH_CONCERNS\n";
    expect(node(buildSddSection(snap, NOW), 7).status).toBe("running");
  });

  it("the first unfinished task runs once the ledger has Task lines, even with no report", () => {
    const snap = fixtureSnapshot({ ledgerText: ledgerThroughTask6() });
    delete snap.reports[7];
    delete snap.mtimes["task-7-report.md"];
    const section = buildSddSection(snap, NOW);
    expect(node(section, 7).status).toBe("running");
    expect(node(section, 8).status).toBe("pending");
  });

  it("a stray later report does not skip the first unfinished task", () => {
    const snap = fixtureSnapshot({ ledgerText: ledgerThroughTask6() });
    delete snap.reports[7];
    snap.reports[8] = "Status: DONE\n";
    const section = buildSddSection(snap, NOW);
    expect(node(section, 7).status).toBe("running");
    expect(node(section, 8).status).toBe("pending");
  });

  it("a brief alone does not start a task", () => {
    const snap = fixtureSnapshot({ ledgerText: "" });
    snap.reports = {};
    const section = buildSddSection(snap, NOW);
    expect(section.nodes.every((n) => n.status === "pending")).toBe(true);
    expect(section.startedAt).toBeUndefined();
  });

  it("a missing report mtime in the middle of the run never gives a negative duration", () => {
    const snap = fixtureSnapshot();
    delete snap.mtimes["task-3-report.md"];
    const section = buildSddSection(snap, NOW);
    expectSaneTimes(section);
    // Task 2 can no longer be bounded by report 3, but its own packages still end it.
    expect(node(section, 2).endedAt).toBe(REVIEW_T2_FIX.mtimeMs);
    // Task 3 has no package and no report mtime: its end is unknown, not guessed.
    expect(node(section, 3).endedAt).toBeUndefined();
    expect(node(section, 4).startedAt).toBeUndefined();
  });

  it("no sha match falls back to the report mtime", () => {
    const snap = fixtureSnapshot();
    snap.reviews = [{ name: "review-aaaaaaa..bbbbbbb.diff", mtimeMs: reportAt(1) + MIN }];
    const section = buildSddSection(snap, NOW);
    expect(node(section, 1).endedAt).toBe(reportAt(1));
    expect(node(section, 2).endedAt).toBe(reportAt(2));
  });

  describe("plan-base packages", () => {
    const ledger = [
      "Task 1: implemented (129e9e2); review: spec ✅",
      "Task 1: complete (commits ebb5db1..129e9e2, review clean)",
      "Task 2: complete (commits 129e9e2..e704fdd, review clean)",
    ].join("\n");

    it("keeps the first task's own package and drops the whole-branch one", () => {
      const own1 = { name: "review-ebb5db1..129e9e2.diff", mtimeMs: reportAt(1) + 3 * MIN };
      const own2 = { name: "review-129e9e2..e704fdd.diff", mtimeMs: reportAt(2) + 3 * MIN };
      const whole = { name: "review-ebb5db1..e704fdd.diff", mtimeMs: reportAt(2) + 8 * MIN };
      const snap = fixtureSnapshot({ ledgerText: ledger });
      snap.reviews = [own1, own2, whole];
      const section = buildSddSection(snap, NOW);
      expect(node(section, 1).endedAt).toBe(own1.mtimeMs);
      expect(node(section, 1).stages?.find((x) => x.kind === "review")?.startedAt).toBe(own1.mtimeMs);
      expect(node(section, 2).endedAt).toBe(own2.mtimeMs);
    });

    it("does not filter when the first task has no commit range", () => {
      const snap = fixtureSnapshot({ ledgerText: "Task 1: complete — done by hand\nTask 2: complete (commits 129e9e2..e704fdd, review clean)" });
      const pkg = { name: "review-129e9e2..e704fdd.diff", mtimeMs: reportAt(2) + 3 * MIN };
      snap.reviews = [pkg];
      expect(node(buildSddSection(snap, NOW), 2).endedAt).toBe(pkg.mtimeMs);
    });
  });

  describe("whole-branch review packages", () => {
    const ledger = [
      "Task 1: complete (commits aaaa111..bbbb222, review clean)",
      "Task 2: complete (commits bbbb222..cccc333, review clean)",
    ].join("\n");
    const twoTasks = (reviews: { name: string; mtimeMs: number }[]) => {
      const snap = fixtureSnapshot({ ledgerText: ledger });
      for (const n of [3, 4, 5, 6, 7, 8]) {
        delete snap.briefs[n];
        delete snap.reports[n];
        delete snap.mtimes[`task-${n}-brief.md`];
        delete snap.mtimes[`task-${n}-report.md`];
      }
      snap.reviews = reviews;
      return buildSddSection(snap, NOW);
    };

    it("do not extend the last task's end", () => {
      const own = { name: "review-bbbb222..cccc333.diff", mtimeMs: reportAt(2) + 3 * MIN };
      const wholeBranch = { name: "review-aaaa111..cccc333.diff", mtimeMs: reportAt(2) + 50 * MIN };
      const section = twoTasks([own, wholeBranch]);
      expect(node(section, 2).endedAt).toBe(own.mtimeMs);
    });

    it("are ignored even when they are the only match", () => {
      const wholeBranch = { name: "review-aaaa111..cccc333.diff", mtimeMs: reportAt(2) + 5 * MIN };
      expect(node(twoTasks([wholeBranch]), 2).endedAt).toBe(reportAt(2));
    });

    it("named by the FINAL REVIEW line are ignored too", () => {
      const withFinal = `${ledger}\nFINAL REVIEW (opus, dddd444..cccc333): ship\n`;
      const snap = fixtureSnapshot({ ledgerText: withFinal });
      for (const n of [3, 4, 5, 6, 7, 8]) {
        delete snap.briefs[n];
        delete snap.reports[n];
      }
      snap.reviews = [{ name: "review-dddd444..cccc333.diff", mtimeMs: reportAt(2) + 40 * MIN }];
      expect(node(buildSddSection(snap, NOW), 2).endedAt).toBe(reportAt(2));
    });
  });

  it("clamps an end that falls before its start", () => {
    const snap = fixtureSnapshot();
    // Briefs were written long after task 1's report was recorded.
    for (let n = 1; n <= 8; n++) snap.mtimes[`task-${n}-brief.md`] = reportAt(1) + 600 * MIN;
    const section = buildSddSection(snap, NOW);
    expect(node(section, 1).startedAt).toBe(reportAt(1) + 600 * MIN);
    expect(node(section, 1).endedAt).toBeUndefined();
    expect(node(section, 1).stages![0].endedAt).toBeUndefined();
    expectSaneTimes(section);
  });

  it("an empty workspace is an empty section", () => {
    const section = buildSddSection(
      { slug: "2026-10-09-tasks-panel", dir: "/x", ledgerText: "", briefs: {}, reports: {}, mtimes: {}, reviews: [] },
      NOW,
    );
    expect(section.title).toBe("Tasks panel");
    expect(section.total).toBe(0);
    expect(section.done).toBe(0);
    expect(section.nodes).toEqual([]);
  });
});
