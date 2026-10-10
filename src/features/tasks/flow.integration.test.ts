// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block, Session } from "../sessions/model/session";
import {
  CWD,
  MIN,
  NOW,
  PLAN_PATH,
  SPEC_PATH,
  fixtureFs,
  ledgerUpTo,
  runningAgentBlock,
  sessionWith,
  shellBlock,
  userBlock,
  withSpecLine,
  type FixtureOptions,
} from "./flow.integration.fixtures";
import { useTaskBoard, type TaskBoard } from "./hooks/useTaskBoard";
import type { SddFs } from "./model/sddWorkspace";
import { TasksPanel } from "./ui/TasksPanel";

// --- Inputs ---------------------------------------------------------------------------------

const PIPED_RUN = "cd /repo && npx vitest run src/features/tasks 2>&1 | tail -20";

/** The mid-run ledger: the real one, cut after Task 4 completed. */
const MID_RUN: FixtureOptions = { transform: ledgerUpTo("Task 4: complete") };
/** The real ledger as written: tasks 1-7 complete, the final review done, Task 8 in progress. */
const WHOLE: FixtureOptions = {};
/** The real ledger plus the one line that finishes Task 8. */
const FINISHED: FixtureOptions = {
  transform: (name, text) => (name === "progress.md" ? `${text.trimEnd()}\nTask 8: complete (commits 0487660..a1b2c3d, review clean)\n` : text),
};

const piped = () => shellBlock(PIPED_RUN, { startedAt: NOW - 30 * MIN, endedAt: NOW - 29 * MIN });
const unrelatedCommit = () => shellBlock('git commit -m "fix vitest"', { startedAt: NOW - 20 * MIN, endedAt: NOW - 20 * MIN + 2000 });
const npmTestPassed = () => shellBlock("npm test", { startedAt: NOW - 6 * MIN, endedAt: NOW - 5 * MIN });
const cargoTestFailed = () => shellBlock("cargo test", { status: "failed", startedAt: NOW - 3 * MIN, endedAt: NOW - 2 * MIN });
const npmTestCancelled = () => shellBlock("npm test", { status: "cancelled", startedAt: NOW - 90_000, endedAt: NOW - 60_000 });
/** The plan's own implementer: handed a task brief, so the plan section already shows it. */
const planImplementer = () =>
  runningAgentBlock("Task 5 implementer", `Implement the task in .superpowers/sdd/skills-index/task-5-brief.md`, NOW - 4 * MIN);
/** A subagent that has nothing to do with the plan. */
const unrelatedReviewer = () => runningAgentBlock("Correctness review", "Review the diff of the settings page", NOW - 2 * MIN);

const transcript = (...tail: Block[]): Block[] => [userBlock("run the plan"), piped(), unrelatedCommit(), planImplementer(), unrelatedReviewer(), ...tail];

// --- Harness --------------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
let board: TaskBoard | undefined;
let onOpenFile: ReturnType<typeof vi.fn<(path: string) => void>>;

function Harness(props: { fs: SddFs; session: Session }) {
  const live = useTaskBoard({
    projectCwd: CWD,
    activeSession: props.session,
    sessions: [],
    visible: true,
    now: () => NOW,
    fs: props.fs,
  });
  board = live;
  return createElement(TasksPanel, { board: live, now: NOW, onOpenFile });
}

async function render(options: FixtureOptions, blocks: Block[]) {
  await act(async () => root.render(createElement(Harness, { fs: fixtureFs(options), session: sessionWith(blocks) })));
}

type Phase = { label: string; glyph: string | null | undefined; detail: string; current: boolean; button: boolean };

/** The flow strip as a reader gets it: label, glyph name, detail, current step, whether it opens. */
function strip(scope: ParentNode = container): Phase[] {
  const list = scope.querySelector('ol[aria-label="Superpowers flow"]');
  if (!list) return [];
  return [...list.querySelectorAll(":scope > li")].map((li) => {
    const head = li.firstElementChild;
    return {
      label: head?.firstChild?.textContent ?? "",
      glyph: li.querySelector('[role="img"]')?.getAttribute("aria-label"),
      detail: (li.children[1]?.textContent ?? "").replace(/\s*›$/, ""),
      current: li.getAttribute("aria-current") === "step",
      button: head?.tagName === "BUTTON",
    };
  });
}

const labels = (phases: Phase[]) => phases.map((p) => p.label);
const phaseOf = (phases: Phase[], label: string) => phases.find((p) => p.label === label);

function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
const stripButton = (label: string, scope: ParentNode = container) =>
  [...scope.querySelectorAll('ol[aria-label="Superpowers flow"] button')].find((b) => b.firstChild?.textContent === label);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onOpenFile = vi.fn<(path: string) => void>();
  board = undefined;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// --- Scenarios ------------------------------------------------------------------------------

describe("Tasks flow, from the real ledger to the DOM", () => {
  it("(a) a plan mid-run with passing tests", async () => {
    await render(MID_RUN, transcript(npmTestPassed()));

    // The real ledger is read through the fs: the hook found the one workspace and its plan.
    expect(board?.selectedWorkspace).toBe("skills-index");
    expect(board?.plan?.planPath).toBe(PLAN_PATH);
    expect(board?.plan?.specPath).toBe(SPEC_PATH);

    expect(strip()).toEqual([
      { label: "Spec", glyph: "done", detail: "", current: false, button: true },
      { label: "Plan", glyph: "done", detail: "8 tasks", current: false, button: true },
      // 4 of 8 from the ledger; the plan's own running implementer stage and the unrelated
      // reviewer count once each, and the implementer block is not counted a second time.
      { label: "Build", glyph: "running", detail: "4 of 8, 2 subagents working", current: true, button: false },
      // Tests passed 5m ago (npm test ended NOW - 5m); the piped run and the commit are older/ignored.
      { label: "Check", glyph: "not started", detail: "tests passed 5m ago", current: false, button: false },
      // Four tasks and the final review are still open.
      { label: "Ship", glyph: "not ready", detail: "2 left", current: false, button: false },
    ]);
    expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(container.textContent).toContain("4 of 8 tasks · 5 left");
    // The unrelated reviewer shows under the other agents; the plan's implementer does not.
    expect(container.textContent).toContain("Other agents here");
    expect(container.textContent).toContain("Correctness review");
    expect(container.textContent).not.toContain("Task 5 implementer");
  });

  it("(a) Spec and Plan open their files through the callback with the repo-relative path", async () => {
    await render(MID_RUN, transcript(npmTestPassed()));
    const phases = strip();
    expect(phases.map((p) => [p.label, p.button])).toEqual([["Spec", true], ["Plan", true], ["Build", false], ["Check", false], ["Ship", false]]);
    expect(stripButton("Spec")?.getAttribute("title")).toBe(SPEC_PATH);
    click(stripButton("Spec"));
    click(stripButton("Plan"));
    expect(onOpenFile.mock.calls).toEqual([[SPEC_PATH], [PLAN_PATH]]);
  });

  it("(b) a failing latest test run makes Check failed with the red glyph, even after a finished final review", async () => {
    await render(WHOLE, transcript(npmTestPassed(), cargoTestFailed()));
    const check = phaseOf(strip(), "Check");
    // The ledger says the final review is done; the newest test run still decides.
    expect(check).toEqual({
      label: "Check",
      glyph: "failed",
      detail: "tests failed 2m ago, final review done",
      current: false,
      button: false,
    });
    // Build is still moving (Task 8), so it keeps the current step.
    expect(strip().filter((p) => p.current).map((p) => p.label)).toEqual(["Build"]);
    expect(container.querySelector('ol[aria-label="Superpowers flow"] [role="img"][aria-label="failed"]')).not.toBeNull();
  });

  it("(c) a piped run reads as tests ran, never passed", async () => {
    // Only the piped vitest run and the commit that merely names vitest: no npm test.
    await render(MID_RUN, [userBlock("go"), piped(), unrelatedCommit()]);
    const check = phaseOf(strip(), "Check");
    expect(check?.detail).toBe("tests ran 29m ago");
    expect(check?.glyph).toBe("not started");
    expect(container.textContent).not.toContain("tests passed");
    expect(container.textContent).not.toContain("tests failed");
  });

  it("(d) a cancelled latest run is ignored and the previous run is shown", async () => {
    await render(MID_RUN, [userBlock("go"), piped(), npmTestPassed(), npmTestCancelled()]);
    expect(phaseOf(strip(), "Check")?.detail).toBe("tests passed 5m ago");
    // Same ledger, no cancelled call: the strip is identical, so the cancelled call changed nothing.
    const withCancelled = strip();
    await render(MID_RUN, [userBlock("go"), piped(), npmTestPassed()]);
    expect(strip()).toEqual(withCancelled);
  });

  it("(e) a finished plan with the final review done and no test run: Check done on the review alone, Ship is current", async () => {
    await render(FINISHED, [userBlock("ship it"), unrelatedCommit(), shellBlock("git status", { startedAt: NOW - MIN, endedAt: NOW - MIN })]);
    expect(strip()).toEqual([
      { label: "Spec", glyph: "done", detail: "", current: false, button: true },
      { label: "Plan", glyph: "done", detail: "8 tasks", current: false, button: true },
      { label: "Build", glyph: "done", detail: "8 of 8", current: false, button: false },
      { label: "Check", glyph: "done", detail: "final review done", current: false, button: false },
      // Every task and the final review are done, but no test run was found and a gap remains: Ship is what is next.
      { label: "Ship", glyph: "not ready", detail: "2 left", current: true, button: false },
    ]);
    expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
  });

  it("(f) a ledger with Spec: n/a shows no Spec phase", async () => {
    await render({ ...MID_RUN, transform: compose(MID_RUN.transform!, withSpecLine("Spec: n/a")) }, transcript(npmTestPassed()));
    const phases = strip();
    expect(labels(phases)).toEqual(["Plan", "Build", "Check", "Ship"]);
    expect(board?.plan?.specPath).toBeUndefined();
    // The rest of the flow is unaffected.
    expect(phaseOf(phases, "Plan")?.detail).toBe("8 tasks");
    expect(phaseOf(phases, "Check")?.detail).toBe("tests passed 5m ago");
  });

  it("(g) a spec path that leaves the repo shows Spec as text, with no button, and nothing opens", async () => {
    const options = { ...MID_RUN, transform: compose(MID_RUN.transform!, withSpecLine("Spec: ../../etc/passwd.md")) };
    await render(options, transcript(npmTestPassed()));
    const phases = strip();
    expect(labels(phases)).toEqual(["Spec", "Plan", "Build", "Check", "Ship"]);
    expect(phaseOf(phases, "Spec")).toMatchObject({ glyph: "done", button: false });
    // The safe Plan next to it still opens.
    expect(phases.filter((p) => p.button).map((p) => p.label)).toEqual(["Plan"]);
    expect(stripButton("Spec")).toBeUndefined();
    // Clicking the text does nothing, and no other path is sent to the editor.
    const spec = [...container.querySelectorAll('ol[aria-label="Superpowers flow"] li')][0];
    click(spec.firstElementChild);
    click(stripButton("Plan"));
    expect(onOpenFile.mock.calls).toEqual([[PLAN_PATH]]);
    expect(onOpenFile).not.toHaveBeenCalledWith(expect.stringContaining("passwd"));
  });

  it("(g) a path that is not even a document is dropped by the ledger: no Spec phase, nothing to open", async () => {
    const options = { ...MID_RUN, transform: compose(MID_RUN.transform!, withSpecLine("Spec: ../../etc/passwd")) };
    await render(options, transcript(npmTestPassed()));
    expect(labels(strip())).toEqual(["Plan", "Build", "Check", "Ship"]);
    click(stripButton("Plan"));
    expect(onOpenFile.mock.calls).toEqual([[PLAN_PATH]]);
  });

  it("(g) a plan path that leaves the repo shows Plan as text, with no button", async () => {
    const options = {
      ...MID_RUN,
      transform: compose(MID_RUN.transform!, (name, text) => (name === "progress.md" ? text.replace(PLAN_PATH, "../../outside/plan.md") : text)),
    };
    await render(options, transcript(npmTestPassed()));
    const phases = strip();
    expect(labels(phases)).toEqual(["Spec", "Plan", "Build", "Check", "Ship"]);
    expect(phases.filter((p) => p.button).map((p) => p.label)).toEqual(["Spec"]);
    expect(container.textContent).not.toContain("Open plan");
  });

  it("(i) a 5000-block transcript with 70 KB shell commands derives the board in well under a second", async () => {
    const huge = "x".repeat(70 * 1024);
    const blocks: Block[] = [userBlock("start"), npmTestPassed()];
    for (let i = 0; blocks.length < 5000; i++) {
      blocks.push(
        i % 5 === 0
          ? userBlock(`turn ${i}`)
          : i % 5 === 1
            ? shellBlock(`cat > /tmp/generated-${i}.ts <<'EOF'\n${huge}\nEOF`, { startedAt: NOW - 25 * MIN, endedAt: NOW - 24 * MIN })
            : shellBlock(`ls -la src/features/tasks # ${i} ${huge}`, { startedAt: NOW - 25 * MIN, endedAt: NOW - 24 * MIN }),
      );
    }
    expect(blocks).toHaveLength(5000);

    const started = performance.now();
    await render(MID_RUN, blocks);
    const elapsed = performance.now() - started;

    // The only test run is the oldest block: the scan walked every newer one to find it.
    expect(phaseOf(strip(), "Check")?.detail).toBe("tests passed 5m ago");
    expect(board?.flow.map((p) => p.id)).toEqual(["spec", "plan", "build", "check", "ship"]);
    expect(elapsed).toBeLessThan(1000);
  });
});

/** Applies fixture transforms left to right. */
function compose(...steps: NonNullable<FixtureOptions["transform"]>[]): NonNullable<FixtureOptions["transform"]> {
  return (name, text) => steps.reduce((acc, step) => step(name, acc), text);
}
