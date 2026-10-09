// @vitest-environment happy-dom
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block, Session } from "../../sessions/model/session";
import type { SddFs } from "../model/sddWorkspace";
import { useTaskBoard, type TaskBoard } from "./useTaskBoard";

type Tree = Record<string, { text?: string; mtimeMs?: number }>;

/** In-memory fs keyed by absolute file path; directories are implied by the paths. */
function fakeFs(tree: Tree) {
  let lists = 0;
  const fs: SddFs = {
    async listDir(path) {
      lists++;
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
  return { fs, lists: () => lists };
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
    const afterFirst = visible.lists();
    expect(afterFirst).toBeGreaterThan(0);
    await advance(3_000);
    const afterOne = visible.lists();
    expect(afterOne).toBeGreaterThan(afterFirst);
    await advance(3_000);
    expect(visible.lists()).toBeGreaterThan(afterOne);

    const idle = fakeFs(workspace("2026-10-05-plan", "A", 9_000));
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount(base(idle.fs, { visible: false, sessions: [{ id: "s", title: "s", busy: false, needsInput: false }] }));
    await advance(60_000);
    expect(idle.lists()).toBe(0);
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
});
