import { describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import type {
  OrchestrationDispatch,
  OrchestrationRun,
  OrchestrationTask,
} from "../../orchestration/model/orchestrationState";
import type { BoardNode, BoardSection } from "./taskBoard";
import {
  buildAgentSection,
  buildOrchestrationSection,
  buildTodoSection,
  dropMirroredTodos,
  isSddStageAgent,
} from "./sections";

const T0 = Date.UTC(2026, 9, 9, 10, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;

function todoBlock(id: string, items: [string, "pending" | "in_progress" | "completed" | "cancelled"][]): Block {
  return {
    id,
    role: "tool",
    text: "",
    tool: { kind: "todo", status: "completed" },
    taskList: { items: items.map(([text, status]) => ({ text, status })) },
  };
}

function agentBlock(id: string, extra: Partial<Block> & { status?: string } = {}): Block {
  const { status, ...rest } = extra;
  return {
    id,
    role: "tool",
    text: "Review the diff",
    tool: { kind: "agent", title: "Review the diff", ...(status ? { status } : {}) },
    agentRun: { name: "Correctness review", model: "claude-opus", steps: [] },
    ...rest,
  };
}

function task(id: string, over: Partial<OrchestrationTask> = {}): OrchestrationTask {
  return {
    id,
    sessionId: `s-${id}`,
    title: `Title ${id}`,
    harness: "claude",
    model: "m",
    prompt: "",
    files: [],
    scopes: [],
    dependsOn: [],
    status: "queued",
    accepted: false,
    result: "",
    delivered: false,
    ...over,
  } as OrchestrationTask;
}

function dispatch(taskId: string, startedAt: number, updatedAt: number, id = `d-${taskId}-${startedAt}`): OrchestrationDispatch {
  return { id, taskId, sessionId: `s-${taskId}`, startedAt, updatedAt, state: "completed", stage: "settled" } as OrchestrationDispatch;
}

function run(tasks: OrchestrationTask[], dispatches: OrchestrationDispatch[] = []): OrchestrationRun {
  return { version: 2, leadId: "lead", cwd: "/p", status: "active", allowedHarnesses: [], maxWorkers: 2, cli: "", tasks, dispatches, continuations: 0, requests: {} };
}

function section(titles: string[], total = titles.length): BoardSection {
  const nodes: BoardNode[] = titles.map((title, i) => ({ id: `t${i + 1}`, title, index: i + 1, status: "pending" }));
  return { source: "sdd", id: "plan", title: "Plan", done: 0, total, nodes };
}

describe("buildTodoSection", () => {
  it("todos use the latest list only", () => {
    const blocks = [
      todoBlock("a", [["Old one", "completed"], ["Old two", "pending"]]),
      { id: "u", role: "assistant", text: "hi" } as Block,
      todoBlock("b", [["Write tests", "completed"], ["Implement", "in_progress"], ["Ship", "pending"], ["Drop", "cancelled"]]),
    ];
    const s = buildTodoSection(blocks)!;
    expect(s.source).toBe("todos");
    expect(s.nodes.map((n) => n.title)).toEqual(["Write tests", "Implement", "Ship", "Drop"]);
    expect(s.nodes.map((n) => n.status)).toEqual(["done", "running", "pending", "cancelled"]);
    expect(s.done).toBe(1);
    expect(s.total).toBe(4);
  });

  it("returns undefined without a list", () => {
    expect(buildTodoSection([])).toBeUndefined();
    expect(buildTodoSection([todoBlock("a", [])])).toBeUndefined();
  });
});

describe("buildAgentSection", () => {
  it("agent block running then completed gets times", () => {
    const running = agentBlock("r", { status: "in_progress", toolStartedAt: T0 });
    const s1 = buildAgentSection([running], T0 + 5 * SEC)!;
    expect(s1.source).toBe("agents");
    expect(s1.nodes[0]).toMatchObject({ id: "r", title: "Correctness review", status: "running", startedAt: T0, models: "claude-opus", target: { kind: "transcript", ref: "r" } });
    expect(s1.nodes[0].endedAt).toBeUndefined();
    expect(s1.done).toBe(0);

    const finished = { ...running, tool: { ...running.tool, status: "completed" }, toolEndedAt: T0 + 3 * MIN };
    const s2 = buildAgentSection([finished], T0 + 10 * MIN)!;
    expect(s2.nodes[0]).toMatchObject({ status: "done", startedAt: T0, endedAt: T0 + 3 * MIN });
    expect(s2.done).toBe(1);
    expect(s2.total).toBe(1);
  });

  it("restored agent block has no times and does not throw", () => {
    const restored = agentBlock("x", { status: "completed" });
    const endedOnly = agentBlock("y", { status: "completed", toolEndedAt: T0 });
    const s = buildAgentSection([restored, endedOnly], T0)!;
    for (const n of s.nodes) {
      expect(n.status).toBe("done");
      expect(n.startedAt).toBeUndefined();
    }
    expect(s.nodes[1].endedAt).toBe(T0);
  });

  it("ignores a stale toolEndedAt while the status is running again", () => {
    const b = agentBlock("z", { status: "in_progress", toolStartedAt: T0, toolEndedAt: T0 + MIN });
    expect(buildAgentSection([b], T0 + 2 * MIN)!.nodes[0].endedAt).toBeUndefined();
  });

  it("never reports an end before the start", () => {
    const b = agentBlock("z", { status: "completed", toolStartedAt: T0 + MIN, toolEndedAt: T0 });
    expect(buildAgentSection([b], T0 + 2 * MIN)!.nodes[0].endedAt).toBeUndefined();
  });

  it("failed agent maps to failed", () => {
    const failed = agentBlock("f", { status: "failed", toolStartedAt: T0, toolEndedAt: T0 + MIN });
    const s = buildAgentSection([failed], T0 + 2 * MIN)!;
    expect(s.nodes[0].status).toBe("failed");
    expect(s.done).toBe(0);
  });

  it("finds agent tool blocks without agentRun and skips other tools", () => {
    const bare: Block = { id: "b", role: "tool", text: "Do it", tool: { kind: "task", title: "Do it", status: "completed" } };
    const other: Block = { id: "o", role: "tool", text: "ls", tool: { kind: "execute", title: "ls", status: "completed" } };
    const s = buildAgentSection([bare, other], T0)!;
    expect(s.nodes.map((n) => n.id)).toEqual(["b"]);
    expect(s.nodes[0].title).toBe("Do it");
    expect(buildAgentSection([other], T0)).toBeUndefined();
  });
});

describe("SDD stage agents", () => {
  const SLUG = "2026-10-09-tasks-panel";
  const sdd = (id: string, text: string, extra: Partial<Block> = {}) => agentBlock(id, { text, tool: { kind: "agent", title: "Agent" }, ...extra });

  it("recognises implementers and reviewers by the files they are handed", () => {
    const marked = [
      sdd("brief", "Implement the task in .superpowers/sdd/2026-10-09-tasks-panel/task-3-brief.md"),
      sdd("report", "Read task-3-report.md and review it"),
      sdd("diff", "Review the package review-423e98a..f64a336.diff"),
      sdd("dir", "Work from /wt/.superpowers/sdd/2026-10-09-tasks-panel"),
      sdd("step", "", {
        agentRun: { name: "Implementer", steps: [{ id: "s", kind: "tool", text: "Read", detail: "/wt/x/task-12-brief.md" }] },
      }),
      sdd("detail", "", { tool: { kind: "agent", title: "Agent", detail: "see task-1-brief.md" } }),
    ];
    for (const block of marked) expect(isSddStageAgent(block, SLUG, false)).toBe(true);
    expect(isSddStageAgent(sdd("other", "Explore how the sidebar renders tabs"), SLUG, true)).toBe(false);
  });

  it("an agent with nothing readable counts as a stage only in the session that owns the plan", () => {
    const blank = sdd("blank", "", { agentRun: { name: "Subagent", steps: [] } });
    expect(isSddStageAgent(blank, SLUG, true)).toBe(true);
    expect(isSddStageAgent(blank, SLUG, false)).toBe(false);
  });

  it("buildAgentSection leaves out what the skip test matches", () => {
    const blocks = [sdd("a", "task-1-brief.md"), sdd("b", "Explore the repo")];
    const s = buildAgentSection(blocks, T0, (b) => isSddStageAgent(b, SLUG, true))!;
    expect(s.nodes.map((n) => n.id)).toEqual(["b"]);
    expect(buildAgentSection([sdd("a", "task-1-brief.md")], T0, (b) => isSddStageAgent(b, SLUG, true))).toBeUndefined();
  });
});

describe("buildOrchestrationSection", () => {
  it("undefined run returns undefined", () => {
    expect(buildOrchestrationSection(undefined, T0)).toBeUndefined();
    expect(buildOrchestrationSection(run([]), T0)).toBeUndefined();
  });

  it("orchestration maps statuses and keeps dependsOn", () => {
    const statuses = [
      ["queued", "pending"], ["running", "running"], ["cancelling", "running"], ["completed", "done"],
      ["failed", "failed"], ["interrupted", "failed"], ["blocked", "blocked"], ["cancelled", "cancelled"],
    ] as const;
    const tasks = statuses.map(([status], i) => task(`t${i}`, { status, dependsOn: i ? [`t${i - 1}`] : [] }));
    const s = buildOrchestrationSection(run(tasks), T0)!;
    expect(s.source).toBe("orchestration");
    expect(s.nodes.map((n) => n.status)).toEqual(statuses.map(([, b]) => b));
    expect(s.nodes[3].dependsOn).toEqual(["t2"]);
    expect(s.nodes[0].target).toEqual({ kind: "session", ref: "s-t0" });
    expect(s.total).toBe(8);
    expect(s.done).toBe(1);
  });

  it("orchestration time comes from the latest dispatch of the task", () => {
    const tasks = [task("a", { status: "completed" }), task("b", { status: "running" }), task("c", { status: "queued" })];
    const dispatches = [
      dispatch("a", T0, T0 + MIN),
      dispatch("a", T0 + 5 * MIN, T0 + 9 * MIN),
      dispatch("b", T0 + 2 * MIN, T0 + 3 * MIN),
      dispatch("c", T0, T0 + MIN),
    ];
    const s = buildOrchestrationSection(run(tasks, dispatches), T0 + 20 * MIN)!;
    expect(s.nodes[0]).toMatchObject({ startedAt: T0 + 5 * MIN, endedAt: T0 + 9 * MIN });
    expect(s.nodes[1].startedAt).toBe(T0 + 2 * MIN);
    expect(s.nodes[1].endedAt).toBeUndefined();
    expect(s.nodes[2].startedAt).toBeUndefined();
    expect(s.nodes[2].endedAt).toBeUndefined();
    expect(s.startedAt).toBe(T0 + 2 * MIN);
  });

  it("works when the run has no dispatches", () => {
    const r = { ...run([task("a", { status: "completed" })]), dispatches: undefined };
    expect(buildOrchestrationSection(r, T0)!.nodes[0].startedAt).toBeUndefined();
  });
});

describe("dropMirroredTodos", () => {
  const todos = (titles: string[]) =>
    buildTodoSection([todoBlock("a", titles.map((t) => [t, "pending"] as [string, "pending"]))]);

  it("dropMirroredTodos hides a list that mirrors the plan", () => {
    const plan = section(["Parse the ledger", "Build the board", "Render the panel"]);
    expect(dropMirroredTodos(todos(["Task 1: Parse the ledger", "2. build the board", "RENDER THE PANEL"]), plan)).toBeUndefined();
  });

  it("hides a list that matches at least 80 percent of a plan of the same size", () => {
    const plan = section(["a1", "a2", "a3", "a4", "a5"]);
    expect(dropMirroredTodos(todos(["a1", "a2", "a3", "a4", "something else"]), plan)).toBeUndefined();
    expect(dropMirroredTodos(todos(["a1", "a2", "a3", "x", "y"]), plan)).toBeDefined();
  });

  it("dropMirroredTodos keeps an unrelated list", () => {
    const plan = section(["Parse the ledger", "Build the board"]);
    const t = todos(["Fix the typo", "Update the docs"]);
    expect(dropMirroredTodos(t, plan)).toBe(t);
    expect(dropMirroredTodos(t, undefined)).toBe(t);
    expect(dropMirroredTodos(undefined, plan)).toBeUndefined();
  });
});
