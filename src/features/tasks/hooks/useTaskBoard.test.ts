// @vitest-environment happy-dom
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block, Session } from "../../sessions/model/session";
import type { SddFs } from "../model/sddWorkspace";
import * as sections from "../model/sections";
import { clearSnoozes, snoozeSession } from "../model/taskSnooze";
import { useTaskBoard, type TaskBoard } from "./useTaskBoard";

// Call-through spies: the real builders run, the tests only count the calls.
vi.mock("../model/sections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model/sections")>();
  return {
    ...actual,
    buildTodoSection: vi.fn(actual.buildTodoSection),
    buildAgentSection: vi.fn(actual.buildAgentSection),
    buildOrchestrationSection: vi.fn(actual.buildOrchestrationSection),
  };
});

type Tree = Record<string, { text?: string; mtimeMs?: number }>;

/** In-memory fs keyed by absolute file path; directories are implied by the paths. */
function fakeFs(tree: Tree, delayMs = 0) {
  let lists = 0;
  let loads = 0;
  const fs: SddFs = {
    async listDir(path) {
      lists++;
      if (path.endsWith(".superpowers/sdd")) loads++;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const seen = new Map<string, boolean>();
      for (const file of Object.keys(tree)) {
        if (!file.startsWith(prefix)) continue;
        const [head, ...tail] = file.slice(prefix.length).split("/");
        seen.set(head, tail.length > 0 || seen.get(head) === true);
      }
      if (seen.size === 0) throw new Error(`ENOENT ${path}`);
      return [...seen].map(([name, isDir]) => ({ name, path: `${prefix}${name}`, isDir }));
    },
    async readText(path) {
      const entry = tree[path];
      if (entry?.text === undefined) throw new Error(`ENOENT ${path}`);
      return entry.text;
    },
    async statMtimes(paths) {
      return paths.map((path) => ({ path, mtimeMs: tree[path]?.mtimeMs ?? null }));
    },
  };
  /** `loads` counts workspace-list calls: one per poll. */
  return { fs, lists: () => lists, loads: () => loads };
}

const ROOT = "/proj/.superpowers/sdd";
const LEDGER = "# SDD ledger — plan: docs/plan.md\nTask 1: implemented (abc1234); review: spec ✅\n";

function workspace(slug: string, title: string, ledgerMtimeMs: number): Tree {
  return {
    [`${ROOT}/${slug}/progress.md`]: { text: LEDGER, mtimeMs: ledgerMtimeMs },
    [`${ROOT}/${slug}/task-1-brief.md`]: { text: `### Task 1: ${title}\n- [ ] **Step 1: go**\n`, mtimeMs: ledgerMtimeMs - 10 },
  };
}

const todoBlock: Block = {
  id: "todo-1",
  role: "tool",
  text: "",
  tool: { kind: "todo", status: "completed" },
  taskList: { items: [{ text: "Write docs", status: "pending" }] },
};

function session(id: string, blocks: Block[] = []): Session {
  return { id, cwd: "/proj", blocks, title: id } as unknown as Session;
}

type Input = Parameters<typeof useTaskBoard>[0];
let container: HTMLDivElement;
let root: Root;
let latest: TaskBoard | undefined;
const renders: TaskBoard[] = [];

function Probe(props: { input: Input }) {
  const board = useTaskBoard(props.input);
  latest = board;
  renders.push(board);
  return null;
}

function base(fs: SddFs, over: Partial<Input> = {}): Input {
  return {
    projectCwd: "/proj",
    sessions: [],
    visible: true,
    now: () => Date.now(),
    fs,
    ...over,
  };
}

async function mount(input: Input) {
  await act(async () => root.render(createElement(Probe, { input })));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.mocked(sections.buildTodoSection).mockClear();
  vi.mocked(sections.buildAgentSection).mockClear();
  latest = undefined;
  renders.length = 0;
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

describe("useTaskBoard", () => {
  it("loads the newest workspace and builds a plan section", async () => {
    const { fs } = fakeFs({
      ...workspace("2026-10-01-old-plan", "Old thing", 1_000),
      ...workspace("2026-10-05-new-plan", "New thing", 9_000),
    });
    await mount(base(fs));
    expect(latest?.loading).toBe(false);
    expect(latest?.workspaces.map((w) => w.slug)).toEqual(["2026-10-05-new-plan", "2026-10-01-old-plan"]);
    expect(latest?.selectedWorkspace).toBe("2026-10-05-new-plan");
    expect(latest?.plan?.source).toBe("sdd");
    expect(latest?.plan?.nodes[0]?.title).toBe("New thing");
    expect(latest?.sections.map((s) => s.source)).toEqual(["sdd"]);
  });

  it("polls every 3s while visible and not at all when idle", async () => {
    const visible = fakeFs(workspace("2026-10-05-plan", "A", 9_000));
    await mount(base(visible.fs));
    expect(visible.loads()).toBe(1);
    await advance(2_999);
    expect(visible.loads()).toBe(1);
    await advance(1);
    expect(visible.loads()).toBe(2);
    await advance(3_000);
    expect(visible.loads()).toBe(3);

    const idle = fakeFs(workspace("2026-10-05-plan", "A", 9_000));
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount(base(idle.fs, { visible: false, sessions: [{ id: "s", title: "s", busy: false, needsInput: false }] }));
    await advance(60_000);
    expect(idle.loads()).toBe(0);
    expect(idle.lists()).toBe(0);
  });

  it("stops polling when the panel is hidden and nothing is busy", async () => {
    const { fs, loads } = fakeFs(workspace("2026-10-05-plan", "A", 9_000));
    await mount(base(fs));
    await advance(3_000);
    expect(loads()).toBe(2);
    await mount(base(fs, { visible: false }));
    await advance(60_000);
    expect(loads()).toBe(2);
  });

  it("does not start a new load while one is slow, and the slow result still lands", async () => {
    // Each listDir takes 4s, so one load takes 8s: longer than the 3s interval.
    const { fs, loads } = fakeFs(workspace("2026-10-05-plan", "Slow", 9_000), 4_000);
    await mount(base(fs));
    expect(latest?.plan).toBeUndefined();
    await advance(9_000);
    expect(latest?.plan?.nodes[0]?.title).toBe("Slow");
    // Loads started at 0s and 11s only (8s load + 3s wait), never one per tick.
    expect(loads()).toBe(1);
    await advance(2_000);
    expect(loads()).toBe(2);
    await advance(10_000);
    expect(loads()).toBe(2);
    await advance(1_000);
    expect(loads()).toBe(3);
  });

  it("polls every 15s while hidden but a session is busy", async () => {
    const { fs, lists } = fakeFs(workspace("2026-10-05-plan", "A", 9_000));
    await mount(
      base(fs, { visible: false, sessions: [{ id: "s", title: "s", busy: true, needsInput: false }] }),
    );
    const first = lists();
    await advance(14_000);
    expect(lists()).toBe(first);
    await advance(1_000);
    expect(lists()).toBeGreaterThan(first);
  });

  it("section load failure renders nothing and keeps the rest", async () => {
    const throwing: SddFs = {
      listDir: () => Promise.reject(new Error("boom")),
      readText: () => Promise.reject(new Error("boom")),
      statMtimes: () => Promise.reject(new Error("boom")),
    };
    await mount(base(throwing, { activeSession: session("lead", [todoBlock]) }));
    expect(latest?.plan).toBeUndefined();
    expect(latest?.loading).toBe(false);
    expect(latest?.sections.map((s) => s.source)).toEqual(["todos"]);
  });

  it("ignores a stale poll result after the session changes", async () => {
    const real = fakeFs(workspace("2026-10-05-plan", "Fresh", 9_000));
    const stale = fakeFs(workspace("2026-01-01-stale-plan", "Stale", 9_000));
    let release: (() => void) | undefined;
    let first = true;
    // The first load hangs and then answers with stale content; later loads answer at once.
    const slowFs: SddFs = {
      listDir: async (path) => {
        if (first) {
          first = false;
          await new Promise<void>((resolve) => (release = resolve));
          return stale.fs.listDir(path);
        }
        return real.fs.listDir(path);
      },
      readText: (path) => (path.includes("stale") ? stale.fs.readText(path) : real.fs.readText(path)),
      statMtimes: (paths) => real.fs.statMtimes(paths),
    };
    await mount(base(slowFs, { activeSession: session("a") }));
    expect(latest?.plan).toBeUndefined();
    await mount(base(slowFs, { activeSession: session("b") }));
    expect(latest?.plan?.nodes[0]?.title).toBe("Fresh");
    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest?.selectedWorkspace).toBe("2026-10-05-plan");
    expect(latest?.plan?.nodes[0]?.title).toBe("Fresh");
  });

  it("selectWorkspace switches the plan", async () => {
    const { fs } = fakeFs({
      ...workspace("2026-10-01-old-plan", "Old thing", 1_000),
      ...workspace("2026-10-05-new-plan", "New thing", 9_000),
    });
    await mount(base(fs));
    await act(async () => latest?.selectWorkspace("2026-10-01-old-plan"));
    await advance(0);
    expect(latest?.selectedWorkspace).toBe("2026-10-01-old-plan");
    expect(latest?.plan?.nodes[0]?.title).toBe("Old thing");
  });

  it("reloads immediately when the transcript grows", async () => {
    const { fs, lists } = fakeFs(workspace("2026-10-05-plan", "A", 9_000));
    await mount(base(fs, { activeSession: session("lead", []) }));
    const before = lists();
    await mount(base(fs, { activeSession: session("lead", [todoBlock]) }));
    expect(lists()).toBeGreaterThan(before);
  });

  it("is safe under StrictMode and stops polling after unmount", async () => {
    const { fs, lists } = fakeFs(workspace("2026-10-05-plan", "A", 9_000));
    await act(async () => root.render(createElement(StrictMode, null, createElement(Probe, { input: base(fs) }))));
    expect(latest?.plan?.nodes[0]?.title).toBe("A");
    await act(async () => root.unmount());
    root = createRoot(container);
    const after = lists();
    await advance(30_000);
    expect(lists()).toBe(after);
  });

  it("keeps the same section objects when a poll finds nothing new", async () => {
    const { fs } = fakeFs(workspace("2026-10-05-plan", "A", 9_000));
    await mount(base(fs));
    const before = latest;
    await advance(3_000);
    expect(latest?.sections).toBe(before?.sections);
    expect(latest?.plan).toBe(before?.plan);
  });

  it("does not reload per block while hidden, only on the hidden cadence", async () => {
    const { fs, loads } = fakeFs(workspace("2026-10-05-plan", "A", 9_000));
    const busy = [{ id: "s", title: "s", busy: true, needsInput: false }];
    const grow = (n: number) =>
      session("lead", Array.from({ length: n }, (_, i) => ({ ...todoBlock, id: `t${i}` })));
    await mount(base(fs, { visible: false, sessions: busy, activeSession: grow(0) }));
    expect(loads()).toBe(1);
    for (let n = 1; n <= 10; n++) {
      await mount(base(fs, { visible: false, sessions: busy, activeSession: grow(n) }));
      await advance(100);
    }
    expect(loads()).toBe(1);
    await advance(14_000);
    expect(loads()).toBe(2);
  });

  it("builds no sections while hidden, and builds them when visible", async () => {
    const { fs } = fakeFs(workspace("2026-10-05-plan", "A", 9_000));
    const busy = [{ id: "s", title: "s", busy: true, needsInput: false }];
    await mount(base(fs, { visible: false, sessions: busy, activeSession: session("lead", [todoBlock]) }));
    await mount(
      base(fs, { visible: false, sessions: busy, activeSession: session("lead", [todoBlock, { ...todoBlock, id: "t2" }]) }),
    );
    expect(sections.buildTodoSection).not.toHaveBeenCalled();
    expect(sections.buildAgentSection).not.toHaveBeenCalled();
    expect(latest?.sections).toEqual([]);

    await mount(base(fs, { visible: true, sessions: busy, activeSession: session("lead", [todoBlock]) }));
    expect(sections.buildTodoSection).toHaveBeenCalled();
    expect(sections.buildAgentSection).toHaveBeenCalled();
    expect(latest?.sections.map((x) => x.source)).toContain("todos");
  });

  it("keeps the status card current from the plan while hidden", async () => {
    const { fs } = fakeFs(workspace("2026-10-05-plan", "A", 9_000));
    const busy = [{ id: "s", title: "s", busy: true, needsInput: false }];
    await mount(base(fs, { visible: false, sessions: busy, activeSession: session("s") }));
    expect(latest?.sections).toEqual([]);
    expect(latest?.statusCard.kind).not.toBe("idle");
  });

  describe("quiet threshold and snooze", () => {
    const NOW = 1_700_000_000_000;
    const MIN = 60_000;
    const silent = (ago: number) => [{ id: "s", title: "s", busy: true, needsInput: false, lastActivityAt: NOW - ago }];
    const quietInput = (fs: SddFs, over: Partial<Input> = {}) =>
      base(fs, { now: () => NOW, sessions: silent(6 * MIN), activeSession: session("s"), ...over });

    afterEach(() => clearSnoozes());

    it("uses five minutes by default and the given quietAfterMs when set", async () => {
      const { fs } = fakeFs(workspace("2026-10-05-plan", "A", 9_000));
      await mount(quietInput(fs));
      expect(latest?.statusCard.kind).toBe("quiet");
      await mount(quietInput(fs, { sessions: silent(2 * MIN) }));
      expect(latest?.statusCard.kind).not.toBe("quiet");
      await mount(quietInput(fs, { sessions: silent(2 * MIN), quietAfterMs: MIN }));
      expect(latest?.statusCard.kind).toBe("quiet");
      await mount(quietInput(fs, { quietAfterMs: 10 * MIN }));
      expect(latest?.statusCard.kind).not.toBe("quiet");
    });

    it("a snoozed session is not quiet until the snooze ends", async () => {
      const { fs } = fakeFs(workspace("2026-10-05-plan", "A", 9_000));
      await mount(quietInput(fs));
      expect(latest?.statusCard.kind).toBe("quiet");
      await act(async () => snoozeSession("s", 10 * MIN, NOW));
      expect(latest?.statusCard.kind).not.toBe("quiet");
      await mount(quietInput(fs, { now: () => NOW + 10 * MIN + 1 }));
      expect(latest?.statusCard.kind).toBe("quiet");
    });
  });
});
