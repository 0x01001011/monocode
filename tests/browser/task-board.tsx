import { createRoot } from "react-dom/client";
import type { SddFs } from "../../src/features/tasks/model/sddWorkspace";
import type { StatusSessionInput } from "../../src/features/tasks/model/statusCard";
import { TaskBoardView } from "../../src/features/tasks/ui/TaskBoardView";
import "../../src/styles/index.css";
// The real fixture workspaces: the real ledger parser, briefs and reports read them.
import skillsLedger from "../../test-fixtures/sdd/skills-index/progress.md?raw";
import controllerLedger from "../../test-fixtures/sdd/controller-formats/progress.md?raw";

const briefFiles = import.meta.glob("../../test-fixtures/sdd/skills-index/task-*-{brief,report}.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const MIN = 60_000;
const PLAN_CWD = "/work/monocode";
const SDD_ROOT = `${PLAN_CWD}/.superpowers/sdd`;
const SKILLS_DIR = `${SDD_ROOT}/skills-index`;
const CONTROLLER_DIR = `${SDD_ROOT}/controller-formats`;
const LOADED_AT = Date.now();

// The ledger's `plan:` line names this file; it resolves against the plan root (`PLAN_CWD`).
const PLAN_FILE = `${PLAN_CWD}/docs/superpowers/plans/2026-10-07-skills-index-remote-ranking.md`;

/** A plan file with 9 tasks and 31 steps: eight the ledger knows and a ninth it has not reached. */
function planFileText(): string {
  const stepsPerTask = [4, 3, 5, 3, 4, 3, 2, 4, 3];
  const titles = [
    "Revision counter",
    "Skills watcher",
    "Usage store",
    "Record usage on send",
    "Host scanner",
    "Remote picker",
    "End-to-end check",
    "Ship the branch",
    "Write the changelog entry",
  ];
  const stepText = ["Write the failing test", "Make it pass", "Run the module's tests", "Run the type check", "Commit the change"];
  // The running task (8) has its first two steps ticked; every task before it is done.
  const ticked = (task: number, step: number) => task < 8 || (task === 8 && step < 2);
  const lines = ["# Skills index remote ranking", ""];
  stepsPerTask.forEach((count, i) => {
    const task = i + 1;
    lines.push(`### Task ${task}: ${titles[i]}`, "");
    for (let step = 0; step < count; step++) lines.push(`- [${ticked(task, step) ? "x" : " "}] **Step ${step + 1}:** ${stepText[step % stepText.length]}`);
    lines.push("");
  });
  return lines.join("\n");
}

/** Extra ledger lines per scene, so the real parser derives a task in trouble. */
const LEDGER_EXTRA: Record<string, string> = {
  trouble: "\nTask 8: fix round 3/5 dispatched; FIX_BASE=0487660\n",
};
let ledger = skillsLedger;

const skillsFiles: Record<string, string> = { "progress.md": skillsLedger };
for (const [path, text] of Object.entries(briefFiles)) skillsFiles[path.split("/").pop()!] = text;

/** Plausible modification times: the newest report is minutes old and each earlier task is older. */
function mtimeOf(dir: string, name: string): number {
  if (dir === CONTROLLER_DIR) return LOADED_AT - 3 * 60 * MIN;
  if (name === "progress.md") return LOADED_AT - 2 * MIN;
  const match = /^task-(\d+)-(brief|report)\.md$/.exec(name);
  if (!match) return LOADED_AT - 90 * MIN;
  const n = Number(match[1]);
  const report = LOADED_AT - (9 - n) * 11 * MIN - 6 * MIN;
  return match[2] === "report" ? report : report - 8 * MIN;
}

/** An in-memory SddFs holding two workspaces; the skills-index one has the newest ledger. */
const fs: SddFs = {
  async listDir(path) {
    const dir = path.replace(/\/+$/, "");
    if (dir === SDD_ROOT) {
      return [
        { name: "controller-formats", path: CONTROLLER_DIR, isDir: true },
        { name: "skills-index", path: SKILLS_DIR, isDir: true },
      ];
    }
    if (dir === SKILLS_DIR) return Object.keys(skillsFiles).map((name) => ({ name, path: `${dir}/${name}`, isDir: false }));
    if (dir === CONTROLLER_DIR) return [{ name: "progress.md", path: `${dir}/progress.md`, isDir: false }];
    throw new Error(`ENOENT ${path}`);
  },
  async readText(path) {
    const at = path.lastIndexOf("/");
    const dir = path.slice(0, at);
    const name = path.slice(at + 1);
    if (path === PLAN_FILE) return planFileText();
    const text =
      dir === SKILLS_DIR
        ? name === "progress.md"
          ? ledger
          : skillsFiles[name]
        : dir === CONTROLLER_DIR && name === "progress.md"
          ? controllerLedger
          : undefined;
    if (text === undefined) throw new Error(`ENOENT ${path}`);
    return text;
  },
  async statMtimes(paths) {
    return paths.map((path) => {
      const at = path.lastIndexOf("/");
      return { path, mtimeMs: mtimeOf(path.slice(0, at), path.slice(at + 1)) };
    });
  },
};

const owner = (patch: Partial<StatusSessionInput>): StatusSessionInput => ({
  id: "s1",
  title: "skills-index",
  busy: false,
  needsInput: false,
  workCwd: PLAN_CWD,
  ...patch,
});

/** Every status-card state the spec may ask for; the real derivation turns each into a card. */
const SCENES: Record<string, StatusSessionInput[]> = {
  natural: [owner({})],
  running: [owner({ busy: true, lastActivityAt: LOADED_AT })],
  "needs-you": [
    owner({ busy: true, needsInput: true, question: "Keep password login as a fallback?", askedAt: LOADED_AT - 3 * MIN, lastActivityAt: LOADED_AT - 3 * MIN }),
  ],
  quiet: [owner({ busy: true, lastActivityAt: LOADED_AT - 12 * MIN })],
  // Task 8 is on fix round 3 of 5: the overview lists it under "Needs a look".
  trouble: [owner({ busy: true, lastActivityAt: LOADED_AT })],
};

const root = createRoot(document.getElementById("root")!);

declare global {
  interface Window {
    showBoard(scene?: string): void;
    setTheme(theme: "dark" | "light", palette?: "default" | "colorblind" | "high-contrast"): void;
  }
}

window.showBoard = (scene = "natural") => {
  const sessions = SCENES[scene];
  if (!sessions) throw new Error(`Unknown task board scene "${scene}"; known: ${Object.keys(SCENES).join(", ")}`);
  ledger = skillsLedger + (LEDGER_EXTRA[scene] ?? "");
  root.render(<TaskBoardView key={scene} projectCwd={PLAN_CWD} sessions={sessions} fs={fs} quietAfterMs={5 * MIN} onOpenPlan={() => {}} onOpenNode={() => {}} onChangeDecision={() => {}} />);
};

window.setTheme = (theme, palette = "default") => {
  const html = document.documentElement;
  html.classList.toggle("theme-light", theme === "light");
  html.classList.remove("diff-palette-colorblind", "diff-palette-high-contrast");
  if (palette !== "default") html.classList.add(`diff-palette-${palette}`);
};

window.showBoard("natural");
