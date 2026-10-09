import { describe, expect, it } from "vitest";
import { buildSddSection } from "./sddBoard";
import { findSddWorkspaces, loadSddSnapshot, type SddFs } from "./sddWorkspace";

type Tree = Record<string, { text?: string; mtimeMs?: number }>;

/** In-memory fs keyed by absolute file path; directories are implied by the paths. */
function fakeFs(tree: Tree) {
  const reads: string[] = [];
  let statCalls = 0;
  let listCalls = 0;
  const fs: SddFs = {
    async listDir(path) {
      listCalls++;
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const seen = new Map<string, boolean>();
      for (const file of Object.keys(tree)) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const [head, ...tail] = rest.split("/");
        seen.set(head, tail.length > 0 || seen.get(head) === true);
      }
      if (seen.size === 0) throw new Error(`ENOENT ${path}`);
      return [...seen].map(([name, isDir]) => ({ name, path: `${prefix}${name}`, isDir }));
    },
    async readText(path) {
      reads.push(path);
      const entry = tree[path];
      if (entry?.text === undefined) throw new Error(`ENOENT ${path}`);
      return entry.text;
    },
    async statMtimes(paths) {
      statCalls++;
      return paths.map((path) => ({ path, mtimeMs: tree[path]?.mtimeMs ?? null }));
    },
  };
  return { fs, reads, stats: () => statCalls, lists: () => listCalls };
}

const ROOT = "/proj/.superpowers/sdd";

describe("findSddWorkspaces", () => {
  it("finds nothing when .superpowers/sdd is missing", async () => {
    const { fs } = fakeFs({ "/proj/src/a.ts": { text: "x" } });
    expect(await findSddWorkspaces(fs, "/proj")).toEqual([]);
  });

  it("orders workspaces by ledger mtime, newest first", async () => {
    const { fs } = fakeFs({
      [`${ROOT}/2026-10-01-old/progress.md`]: { text: "", mtimeMs: 1_000 },
      [`${ROOT}/2026-10-05-new/progress.md`]: { text: "", mtimeMs: 9_000 },
      [`${ROOT}/2026-10-03-mid/progress.md`]: { text: "", mtimeMs: 5_000 },
      [`${ROOT}/stray-file.txt`]: { text: "" },
    });
    const refs = await findSddWorkspaces(fs, "/proj/");
    expect(refs.map((r) => r.slug)).toEqual(["2026-10-05-new", "2026-10-03-mid", "2026-10-01-old"]);
    expect(refs[0]).toEqual({
      dir: `${ROOT}/2026-10-05-new`,
      slug: "2026-10-05-new",
      ledgerMtimeMs: 9_000,
    });
  });

  it("keeps a workspace without a ledger, with mtime 0", async () => {
    const { fs } = fakeFs({ [`${ROOT}/2026-10-09-x/task-1-brief.md`]: { text: "### Task 1: A" } });
    const refs = await findSddWorkspaces(fs, "/proj");
    expect(refs).toEqual([{ dir: `${ROOT}/2026-10-09-x`, slug: "2026-10-09-x", ledgerMtimeMs: 0 }]);
  });
});

describe("loadSddSnapshot", () => {
  const DIR = `${ROOT}/2026-10-09-demo`;
  const tree: Tree = {
    [`${DIR}/progress.md`]: {
      text: "# SDD ledger — plan: p.md\nTask 1: complete (commits a..b, review clean)\n",
      mtimeMs: 500,
    },
    [`${DIR}/task-1-brief.md`]: { text: "### Task 1: One\n- [ ] **Step 1:** do it\n", mtimeMs: 100 },
    [`${DIR}/task-2-brief.md`]: { text: "### Task 2: Two\n", mtimeMs: 100 },
    [`${DIR}/task-1-report.md`]: { text: "Status: DONE\n", mtimeMs: 200 },
    [`${DIR}/review-a..b.diff`]: { text: "diff --git secret", mtimeMs: 300 },
    [`${DIR}/final-fix-brief.md`]: { text: "not ours", mtimeMs: 400 },
    [`${DIR}/notes.txt`]: { text: "not ours" },
  };

  it("reads only briefs, reports, review packages and progress", async () => {
    const { fs, reads, stats, lists } = fakeFs(tree);
    const snap = await loadSddSnapshot(fs, { dir: DIR, slug: "2026-10-09-demo", ledgerMtimeMs: 500 });
    expect([...reads].sort()).toEqual(
      [
        `${DIR}/progress.md`,
        `${DIR}/task-1-brief.md`,
        `${DIR}/task-1-report.md`,
        `${DIR}/task-2-brief.md`,
      ].sort(),
    );
    expect(lists()).toBe(1);
    expect(stats()).toBe(1);
    expect(Object.keys(snap.briefs).map(Number)).toEqual([1, 2]);
    expect(Object.keys(snap.reports).map(Number)).toEqual([1]);
    expect(snap.mtimes["task-1-report.md"]).toBe(200);
    expect(snap.mtimes["progress.md"]).toBe(500);
    expect(snap.reviews).toEqual([{ name: "review-a..b.diff", mtimeMs: 300 }]);
    expect(snap.dir).toBe(DIR);
    expect(snap.slug).toBe("2026-10-09-demo");
  });

  it("loads a workspace with no ledger: nothing done, no throw", async () => {
    const dir = `${ROOT}/2026-10-09-fresh`;
    const { fs } = fakeFs({
      [`${dir}/task-1-brief.md`]: { text: "### Task 1: One\n", mtimeMs: 10 },
      [`${dir}/task-2-brief.md`]: { text: "### Task 2: Two\n", mtimeMs: 10 },
    });
    const snap = await loadSddSnapshot(fs, { dir, slug: "2026-10-09-fresh", ledgerMtimeMs: 0 });
    expect(snap.ledgerText).toBe("");
    const section = buildSddSection(snap, 1_000);
    expect(section.done).toBe(0);
    expect(section.total).toBe(2);
    // No ledger line yet, but the first brief marks the first task as the one in progress.
    expect(section.nodes.map((n) => n.status)).toEqual(["running", "pending"]);
  });

  it("leaves unknown mtimes out", async () => {
    const dir = `${ROOT}/2026-10-09-nomtime`;
    const { fs } = fakeFs({ [`${dir}/task-1-brief.md`]: { text: "### Task 1: One\n" } });
    const snap = await loadSddSnapshot(fs, { dir, slug: "s", ledgerMtimeMs: 0 });
    expect(snap.mtimes).toEqual({});
  });
});
