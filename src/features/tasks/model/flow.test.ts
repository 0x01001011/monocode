import { describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import { deriveFlow, type FlowInput, type FlowPhase } from "./flow";
import type { BoardNode, BoardSection, BoardStatus } from "./taskBoard";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function task(n: number, status: BoardStatus, over: Partial<BoardNode> = {}): BoardNode {
  return { id: `task-${n}`, title: `Task ${n}`, index: n, status, ...over };
}

function plan(statuses: BoardStatus[], over: Partial<BoardSection> = {}): BoardSection {
  const nodes = statuses.map((s, i) => task(i + 1, s));
  return {
    source: "sdd",
    id: "sdd:p",
    title: "P",
    done: nodes.filter((n) => n.status === "done").length,
    total: nodes.length,
    nodes,
    planPath: "docs/superpowers/plans/p.md",
    specPath: "docs/superpowers/specs/p-design.md",
    ...over,
  };
}

const final = (status: BoardStatus): BoardNode => ({ id: "final-review", title: "Last review", status });

let seq = 0;
function shell(command: string, status = "completed", endedAgo = 4 * MIN): Block {
  seq += 1;
  return {
    id: `s${seq}`,
    role: "tool",
    text: "",
    tool: { kind: "execute", title: command, status },
    toolStartedAt: NOW - endedAgo - 1000,
    toolEndedAt: status === "running" || status === "in_progress" ? undefined : NOW - endedAgo,
  } as Block;
}

function flow(p: BoardSection, over: Partial<FlowInput> = {}): FlowPhase[] {
  return deriveFlow({ plan: p, subagentsRunning: 0, now: NOW, ...over });
}
const phase = (phases: FlowPhase[], id: FlowPhase["id"]) => phases.find((x) => x.id === id);

describe("deriveFlow phases", () => {
  it("lists spec, plan, build, check in order with the evidence it has", () => {
    const phases = flow(plan(["done", "running", "pending"]));
    expect(phases.map((x) => x.id)).toEqual(["spec", "plan", "build", "check"]);
    expect(phases.map((x) => x.label)).toEqual(["Spec", "Plan", "Build", "Check"]);
    expect(phase(phases, "spec")).toEqual({
      id: "spec",
      label: "Spec",
      status: "done",
      path: "docs/superpowers/specs/p-design.md",
    });
    expect(phase(phases, "plan")).toEqual({
      id: "plan",
      label: "Plan",
      status: "done",
      detail: "3 tasks",
      path: "docs/superpowers/plans/p.md",
    });
  });

  it("no spec line means no Spec phase, and no plan path means no Plan phase", () => {
    const { specPath: _s, ...noSpec } = plan(["running"]);
    expect(flow(noSpec).map((x) => x.id)).toEqual(["plan", "build", "check"]);
    const { planPath: _p, specPath: _q, ...bare } = plan(["running"]);
    expect(flow(bare).map((x) => x.id)).toEqual(["build", "check"]);
  });

  it("says '1 task' for a one-task plan", () => {
    expect(phase(flow(plan(["pending"])), "plan")?.detail).toBe("1 task");
  });

  it("a plan with no tasks has no Build phase", () => {
    expect(flow(plan([])).map((x) => x.id)).toEqual(["spec", "plan", "check"]);
  });
});

describe("Build", () => {
  const build = (statuses: BoardStatus[], over: Partial<FlowInput> = {}, extra: Partial<BoardSection> = {}) =>
    phase(flow(plan(statuses, extra), over), "build");

  it("is pending, with no detail, while no task has started", () => {
    expect(build(["pending", "pending"])).toEqual({ id: "build", label: "Build", status: "pending" });
  });

  it("is running with 'N of M' while a task runs", () => {
    expect(build(["done", "done", "done", "running", "pending", "pending"])).toMatchObject({
      status: "running",
      detail: "3 of 6",
    });
  });

  it("stays running between tasks once some are done", () => {
    expect(build(["done", "pending"])).toMatchObject({ status: "running", detail: "1 of 2" });
  });

  it("is done when every task is done", () => {
    expect(build(["done", "done", "done"])).toMatchObject({ status: "done", detail: "3 of 3" });
  });

  it("a struggling task (fix round 3 or more) maps to attention, ahead of running", () => {
    const p = plan(["done", "attention", "pending"]);
    p.nodes[1] = task(2, "attention", { fixRounds: 3 });
    expect(phase(flow(p), "build")).toMatchObject({ status: "attention", detail: "1 of 3" });
    const running = plan(["done", "running"]);
    running.nodes[1] = task(2, "running", { fixRounds: 4 });
    expect(phase(flow(running), "build")?.status).toBe("attention");
  });

  it("fix rounds on a finished task do not count", () => {
    const p = plan(["done", "running"]);
    p.nodes[0] = task(1, "done", { fixRounds: 3 });
    expect(phase(flow(p), "build")?.status).toBe("running");
  });

  it("a blocked task shows as blocked", () => {
    expect(build(["done", "blocked", "pending"])).toMatchObject({ status: "blocked", detail: "1 of 3" });
  });

  it("adds the subagents working, singular and plural", () => {
    expect(build(["done", "running"], { subagentsRunning: 2 })?.detail).toBe("1 of 2, 2 subagents working");
    expect(build(["done", "running"], { subagentsRunning: 1 })?.detail).toBe("1 of 2, 1 subagent working");
  });

  it("shows subagents alone when no task has finished yet", () => {
    expect(build(["pending", "pending"], { subagentsRunning: 1 })).toMatchObject({
      status: "pending",
      detail: "1 subagent working",
    });
  });
});

describe("Check", () => {
  const check = (over: Partial<FlowInput> = {}, finalStatus?: BoardStatus) =>
    phase(flow(plan(["done"], finalStatus ? { finalReview: final(finalStatus) } : {}), over), "check");

  it("is pending with no detail when nothing has run", () => {
    expect(check()).toEqual({ id: "check", label: "Check", status: "pending" });
    expect(check({ blocks: [shell("git status")] })).toEqual({ id: "check", label: "Check", status: "pending" });
  });

  it("a pending final review adds nothing", () => {
    expect(check({}, "pending")).toEqual({ id: "check", label: "Check", status: "pending" });
  });

  it("reports the last test run and its age", () => {
    expect(check({ blocks: [shell("npm test")] })).toMatchObject({ status: "pending", detail: "tests passed 4m ago" });
    expect(check({ blocks: [shell("npm test", "failed", 2 * MIN)] })).toMatchObject({
      status: "failed",
      detail: "tests failed 2m ago",
    });
    expect(check({ blocks: [shell("npm test", "completed", 5_000)] })?.detail).toBe("tests passed <1m ago");
    expect(check({ blocks: [shell("npm test", "completed", 75 * MIN)] })?.detail).toBe("tests passed 1h 15m ago");
  });

  it("still reports a test run that is older than the plan: it shows what the last run was", () => {
    const p = plan(["done"], { startedAt: NOW - MIN });
    const phases = flow(p, { blocks: [shell("cargo test", "completed", 3 * 60 * MIN)] });
    expect(phase(phases, "check")?.detail).toBe("tests passed 3h 00m ago");
  });

  it("a clock a little behind the test run reads as just now, never a dash", () => {
    expect(check({ blocks: [shell("npm test", "completed", -3000)] })?.detail).toBe("tests passed <1m ago");
  });

  it("leaves the age out when the run has no time", () => {
    const block = { ...shell("npm test"), toolStartedAt: undefined, toolEndedAt: undefined } as Block;
    expect(check({ blocks: [block] })?.detail).toBe("tests passed");
  });

  it("a test run in flight is running", () => {
    expect(check({ blocks: [shell("npm test", "running")] })).toMatchObject({ status: "running", detail: "tests running" });
  });

  it("the final review running is running", () => {
    expect(check({}, "running")).toMatchObject({ status: "running", detail: "final review running" });
  });

  it("a final review with findings is attention", () => {
    expect(check({}, "attention")).toMatchObject({ status: "attention", detail: "final review found issues" });
  });

  it("is done when the final review is done and the latest run passed", () => {
    expect(check({ blocks: [shell("npm test")] }, "done")).toMatchObject({
      status: "done",
      detail: "tests passed 4m ago, final review done",
    });
  });

  it("a finished final review without a passing run is not done", () => {
    expect(check({}, "done")?.status).toBe("pending");
  });

  it("the newest run decides: a pass after a failure is passed", () => {
    const blocks = [shell("npm test", "failed", 10 * MIN), shell("npm test", "completed", 2 * MIN)];
    expect(check({ blocks }, "done")?.status).toBe("done");
  });

  describe("precedence: failed > running > attention > done > pending", () => {
    it("failed tests beat a running final review", () => {
      expect(check({ blocks: [shell("npm test", "failed")] }, "running")).toMatchObject({
        status: "failed",
        detail: "tests failed 4m ago, final review running",
      });
    });

    it("failed tests beat a final review with findings and a finished one", () => {
      expect(check({ blocks: [shell("npm test", "failed")] }, "attention")?.status).toBe("failed");
      expect(check({ blocks: [shell("npm test", "failed")] }, "done")?.status).toBe("failed");
    });

    it("a running test beats findings", () => {
      expect(check({ blocks: [shell("npm test", "running")] }, "attention")?.status).toBe("running");
    });

    it("a running final review beats a passed run", () => {
      expect(check({ blocks: [shell("npm test")] }, "running")?.status).toBe("running");
    });

    it("findings beat a passed run", () => {
      expect(check({ blocks: [shell("npm test")] }, "attention")?.status).toBe("attention");
    });
  });
});

describe("a finished plan", () => {
  it("reads done across the board once tests passed and the final review is done", () => {
    const p = plan(["done", "done", "done"], { finalReview: final("done") });
    const phases = flow(p, { blocks: [shell("npm run check:web")] });
    expect(phases.map((x) => [x.id, x.status])).toEqual([
      ["spec", "done"],
      ["plan", "done"],
      ["build", "done"],
      ["check", "done"],
    ]);
  });
});
