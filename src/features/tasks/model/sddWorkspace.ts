import type { SddSnapshot } from "./sddBoard";

export type SddFs = {
  listDir(path: string): Promise<{ name: string; path: string; isDir: boolean }[]>;
  readText(path: string): Promise<string>;
  statMtimes(paths: string[]): Promise<{ path: string; mtimeMs: number | null }[]>;
};

export type SddWorkspaceRef = { dir: string; slug: string; ledgerMtimeMs: number };

const LEDGER = "progress.md";
const BRIEF = /^task-(\d+)-brief\.md$/;
const REPORT = /^task-(\d+)-report\.md$/;
const REVIEW = /^review-.+\.diff$/;

const join = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;

/**
 * Lists `<projectCwd>/.superpowers/sdd/<slug>/` workspaces, newest ledger first.
 * A missing or unreadable directory means there are none.
 */
export async function findSddWorkspaces(fs: SddFs, projectCwd: string): Promise<SddWorkspaceRef[]> {
  let entries: Awaited<ReturnType<SddFs["listDir"]>>;
  try {
    entries = await fs.listDir(join(projectCwd, ".superpowers/sdd"));
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.isDir);
  if (dirs.length === 0) return [];
  const stats = await fs.statMtimes(dirs.map((d) => join(d.path, LEDGER)));
  const mtimeByPath = new Map(stats.map((s) => [s.path, s.mtimeMs]));
  return dirs
    .map((d) => ({
      dir: d.path,
      slug: d.name,
      ledgerMtimeMs: mtimeByPath.get(join(d.path, LEDGER)) ?? 0,
    }))
    .sort((a, b) => b.ledgerMtimeMs - a.ledgerMtimeMs || b.slug.localeCompare(a.slug));
}

async function readOptional(fs: SddFs, path: string): Promise<string | undefined> {
  try {
    return await fs.readText(path);
  } catch {
    return undefined;
  }
}

/**
 * Reads one workspace: `progress.md`, the briefs and reports, and the mtimes of
 * those files plus the review packages (whose contents are never read).
 */
export async function loadSddSnapshot(fs: SddFs, ref: SddWorkspaceRef): Promise<SddSnapshot> {
  const entries = (await fs.listDir(ref.dir)).filter((e) => !e.isDir);
  const briefFiles = entries.filter((e) => BRIEF.test(e.name));
  const reportFiles = entries.filter((e) => REPORT.test(e.name));
  const reviewFiles = entries.filter((e) => REVIEW.test(e.name));
  const ledgerFile = entries.find((e) => e.name === LEDGER);
  const statted = [...(ledgerFile ? [ledgerFile] : []), ...briefFiles, ...reportFiles, ...reviewFiles];

  const [ledgerText, briefTexts, reportTexts, stats] = await Promise.all([
    ledgerFile ? readOptional(fs, ledgerFile.path) : undefined,
    Promise.all(briefFiles.map((f) => readOptional(fs, f.path))),
    Promise.all(reportFiles.map((f) => readOptional(fs, f.path))),
    statted.length ? fs.statMtimes(statted.map((f) => f.path)) : [],
  ]);

  const collect = (files: typeof entries, texts: (string | undefined)[], pattern: RegExp) => {
    const out: Record<number, string> = {};
    files.forEach((f, i) => {
      const text = texts[i];
      if (text !== undefined) out[Number(pattern.exec(f.name)?.[1])] = text;
    });
    return out;
  };

  const mtimeByPath = new Map(stats.map((s) => [s.path, s.mtimeMs]));
  const mtimes: Record<string, number> = {};
  for (const f of statted) {
    const ms = mtimeByPath.get(f.path);
    if (typeof ms === "number" && Number.isFinite(ms)) mtimes[f.name] = ms;
  }

  return {
    slug: ref.slug,
    dir: ref.dir,
    ledgerText: ledgerText ?? "",
    briefs: collect(briefFiles, briefTexts, BRIEF),
    reports: collect(reportFiles, reportTexts, REPORT),
    mtimes,
    reviews: reviewFiles.flatMap((f) =>
      f.name in mtimes ? [{ name: f.name, mtimeMs: mtimes[f.name] }] : [],
    ),
  };
}
