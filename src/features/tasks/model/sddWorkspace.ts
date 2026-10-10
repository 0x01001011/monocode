import { MAX_PLAN_BYTES } from "./planFile";
import { planFilePath } from "./planRoot";
import type { SddSnapshot } from "./sddBoard";
import { parseLedger } from "./sddLedger";

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

const WORKSPACE_DIR = /^(.*?)[\\/]\.superpowers[\\/]sdd[\\/][^\\/]+[\\/]*$/;

/** The directory that holds `.superpowers/sdd/<slug>`: what the ledger's relative paths mean. */
function planRootOf(workspaceDir: string): string | undefined {
  const root = WORKSPACE_DIR.exec(workspaceDir)?.[1];
  return root === undefined ? undefined : root || "/";
}

/**
 * The plan file the ledger names, read once. Undefined without a plan path, for a path
 * outside the plan root, and on any failure or a file over 512 KB: the plan file only adds
 * detail, so the board never depends on it.
 */
async function readPlanText(fs: SddFs, dir: string, ledgerText: string | undefined): Promise<string | undefined> {
  try {
    const planPath = parseLedger(ledgerText ?? "").planPath;
    const root = planRootOf(dir);
    if (!planPath || root === undefined) return undefined;
    const path = planFilePath(root, planPath);
    if (path === undefined) return undefined;
    const text = await fs.readText(path);
    return typeof text === "string" && text.length <= MAX_PLAN_BYTES ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads one workspace: `progress.md`, the briefs and reports, the plan file the ledger
 * names, and the mtimes of those files plus the review packages (whose contents are never read).
 */
export async function loadSddSnapshot(fs: SddFs, ref: SddWorkspaceRef): Promise<SddSnapshot> {
  const entries = (await fs.listDir(ref.dir)).filter((e) => !e.isDir);
  const briefFiles = entries.filter((e) => BRIEF.test(e.name));
  const reportFiles = entries.filter((e) => REPORT.test(e.name));
  const reviewFiles = entries.filter((e) => REVIEW.test(e.name));
  const ledgerFile = entries.find((e) => e.name === LEDGER);
  const statted = [...(ledgerFile ? [ledgerFile] : []), ...briefFiles, ...reportFiles, ...reviewFiles];

  const ledgerRead = ledgerFile ? readOptional(fs, ledgerFile.path) : Promise.resolve(undefined);
  const [ledgerText, planText, briefTexts, reportTexts, stats] = await Promise.all([
    ledgerRead,
    ledgerRead.then((text) => readPlanText(fs, ref.dir, text)),
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
    ...(planText !== undefined ? { planText } : {}),
    briefs: collect(briefFiles, briefTexts, BRIEF),
    reports: collect(reportFiles, reportTexts, REPORT),
    mtimes,
    reviews: reviewFiles.flatMap((f) =>
      f.name in mtimes ? [{ name: f.name, mtimeMs: mtimes[f.name] }] : [],
    ),
  };
}
