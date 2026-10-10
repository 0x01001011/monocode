// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatSessionTitle } from "../../features/sessions/model/session";
import { useTaskBoard, type TaskBoard } from "../../features/tasks/hooks/useTaskBoard";
import type { StatusCard } from "../../features/tasks/model/statusCard";
import {
  loadProjectSidebarTab,
  saveProjectSidebarTab,
} from "../../features/settings/model/projectSidebarTab";
import { remotePath } from "../../features/connections/model/remoteProjects";
import { Sidebar } from "./Sidebar";

// Keep native services and heavy children out of these tab tests.
vi.mock("../../features/source-control/hooks/useProjectDiffStats", () => ({
  useProjectDiffStats: vi.fn(() => null),
}));
vi.mock("../../features/source-control/hooks/useGitFileStatuses", () => ({
  useGitFileStatuses: () => ({ files: new Map(), dirs: new Map() }),
}));
vi.mock("./SidebarUpdate", () => ({ SidebarUpdateFooter: () => null }));
vi.mock("../../features/files/ui/FileTree", () => ({
  FileTree: ({ cwd, rootLabel }: { cwd: string; rootLabel?: string }) =>
    createElement("div", { "data-explorer-cwd": cwd }, rootLabel),
}));
vi.mock("../../features/tasks/hooks/useTaskBoard", () => ({ useTaskBoard: vi.fn() }));

const IDLE: StatusCard = { kind: "idle", headline: "", actions: [] };
const RUNNING: StatusCard = {
  kind: "running",
  sessionId: "session-1",
  headline: "A reviewer is checking Task 6",
  reassurance: "Nothing needs you",
  actions: [],
};
const ASK: StatusCard = {
  kind: "needs-you",
  sessionId: "session-1",
  headline: "Session 1 is waiting for you",
  actions: ["answer-in-session"],
};
const FAIL: StatusCard = {
  kind: "struggling",
  headline: "Task 6 keeps failing review",
  actions: ["see-issues"],
};
const QUIET: StatusCard = {
  kind: "quiet",
  headline: "Session 1 has been quiet",
  actions: ["keep-waiting"],
};

function board(statusCard: StatusCard): TaskBoard {
  return {
    sections: [],
    statusCard,
    flow: [],
    gaps: [],
    workspaces: [],
    selectWorkspace: () => {},
    loading: false,
    loaded: true,
  };
}

let container: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof Sidebar>;

function render() {
  act(() => root.render(createElement(Sidebar, props)));
}

function tasksTab(): HTMLButtonElement {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ).find((el) => el.textContent === "Tasks" || el.getAttribute("aria-label")?.startsWith("Tasks"))!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
  vi.mocked(useTaskBoard).mockReset().mockReturnValue(board(IDLE));
  props = {
    cwd: "/workspace/project",
    open: true,
    sessions: [
      {
        id: "session-1",
        cwd: "/workspace/project",
        harness: "codex",
        model: "",
        runtimeMode: "supervised",
        title: formatSessionTitle("codex", "Original conversation"),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
    busySessionIds: new Set(),
    approvalSessionIds: new Set(),
    activeSessionId: "session-1",
    status: "idle",
    pending: false,
    tab: "sessions",
    filesSearchOpen: false,
    onSelectSession: vi.fn(),
    onOpenFile: vi.fn(),
    onTabChange: vi.fn(),
    onFilesSearchOpenChange: vi.fn(),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function boardWithFlow(flow: TaskBoard["flow"]): TaskBoard {
  const plan = {
    source: "sdd" as const,
    id: "sdd:p",
    title: "Plan P",
    done: 0,
    total: 1,
    nodes: [{ id: "task-1", title: "Step", index: 1, status: "running" as const }],
  };
  return { ...board(RUNNING), sections: [plan], plan, flow };
}

describe("Sidebar Tasks tab flow strip", () => {
  const strip = () => container.querySelector("ol[aria-label='Superpowers flow']")!;
  const open = (name: string) =>
    act(() => Array.from(strip().querySelectorAll("button")).find((b) => b.textContent?.trim() === name)!.click());

  it("opens the spec and the plan inside the plan root as exact files", () => {
    vi.mocked(useTaskBoard).mockReturnValue(
      boardWithFlow([
        { id: "spec", label: "Spec", status: "done", path: "docs/s.md" },
        { id: "plan", label: "Plan", status: "done", path: "/workspace/project/docs/p.md" },
      ]),
    );
    props = { ...props, tab: "tasks" };
    render();
    open("Spec");
    open("Plan");
    expect(props.onOpenFile).toHaveBeenNthCalledWith(1, "/workspace/project/docs/s.md", undefined, { exact: true });
    expect(props.onOpenFile).toHaveBeenNthCalledWith(2, "/workspace/project/docs/p.md", undefined, { exact: true });
  });

  it.each(["../outside.md", "/etc/passwd.md", "https://example.com/s.md", "~/s.md"])(
    "does not open %s",
    (path) => {
      vi.mocked(useTaskBoard).mockReturnValue(boardWithFlow([{ id: "spec", label: "Spec", status: "done", path }]));
      props = { ...props, tab: "tasks" };
      render();
      open("Spec");
      expect(props.onOpenFile).not.toHaveBeenCalled();
    },
  );
});

describe("Sidebar Tasks tab", () => {
  it("renders a Tasks tab after Changes and selects it on click", () => {
    render();
    const labels = Array.from(container.querySelectorAll('[role="tab"]')).map((el) => el.textContent);
    expect(labels).toEqual(["Sessions", "Explorer", "Changes", "Tasks"]);
    act(() => tasksTab().click());
    expect(props.onTabChange).toHaveBeenCalledWith("tasks");
  });

  it("shows the panel only while the Tasks tab is selected", () => {
    vi.mocked(useTaskBoard).mockReturnValue(board(RUNNING));
    render();
    expect(container.textContent).not.toContain("A reviewer is checking Task 6");
    props = { ...props, tab: "tasks" };
    render();
    expect(container.textContent).toContain("A reviewer is checking Task 6");
    expect(tasksTab().getAttribute("aria-selected")).toBe("true");
  });

  it("reads the board with the tab closed, hidden until the tab is selected", () => {
    render();
    const closed = vi.mocked(useTaskBoard).mock.calls.at(-1)![0];
    expect(closed.visible).toBe(false);
    expect(closed.projectCwd).toBe("/workspace/project");
    props = { ...props, tab: "tasks" };
    render();
    expect(vi.mocked(useTaskBoard).mock.calls.at(-1)![0].visible).toBe(true);
  });

  it("feeds the busy and approval sessions into the board", () => {
    props = {
      ...props,
      busySessionIds: new Set(["session-1"]),
      approvalSessionIds: new Set(["session-1"]),
    };
    render();
    const input = vi.mocked(useTaskBoard).mock.calls.at(-1)![0];
    expect(input.sessions).toEqual([
      expect.objectContaining({ id: "session-1", busy: true, needsInput: true }),
    ]);
  });

  it("has no badge while a task is merely running", () => {
    vi.mocked(useTaskBoard).mockReturnValue(board(RUNNING));
    render();
    expect(tasksTab().getAttribute("aria-label")).toBe("Tasks");
    expect(tasksTab().querySelector("[data-tab-badge]")).toBeNull();
  });

  it("gives a needs-you board an ask badge and an accessible name", () => {
    vi.mocked(useTaskBoard).mockReturnValue(board(ASK));
    render();
    const tab = tasksTab();
    expect(tab.getAttribute("aria-label")).toBe("Tasks, needs you");
    const badge = tab.querySelector<HTMLElement>('[data-tab-badge="ask"]')!;
    expect(badge.getAttribute("aria-hidden")).toBe("true");
    expect(badge.textContent).toBe("?");
  });

  it("gives a failing review an amber disc with an exclamation mark", () => {
    vi.mocked(useTaskBoard).mockReturnValue(board(FAIL));
    render();
    const tab = tasksTab();
    expect(tab.getAttribute("aria-label")).toBe("Tasks, a task is failing review");
    const badge = tab.querySelector<HTMLElement>('[data-tab-badge="fail"]')!;
    expect(badge.getAttribute("aria-hidden")).toBe("true");
    expect(badge.textContent).toBe("!");
  });

  it("gives a quiet run a hollow ring", () => {
    vi.mocked(useTaskBoard).mockReturnValue(board(QUIET));
    render();
    const tab = tasksTab();
    expect(tab.getAttribute("aria-label")).toBe("Tasks, quiet for a while");
    const badge = tab.querySelector<HTMLElement>('[data-tab-badge="quiet"]')!;
    expect(badge.getAttribute("aria-hidden")).toBe("true");
    expect(badge.textContent).toBe("");
  });

  it("leaves the Changes tab label alone", () => {
    vi.mocked(useTaskBoard).mockReturnValue(board(ASK));
    render();
    const changes = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (el) => el.textContent === "Changes",
    )!;
    expect(changes.getAttribute("aria-label")).toBe("Changes");
  });

  it("restores the Tasks panel from a persisted selection", () => {
    vi.mocked(useTaskBoard).mockReturnValue(board(RUNNING));
    saveProjectSidebarTab(props.cwd, "tasks");
    props = { ...props, tab: loadProjectSidebarTab(props.cwd) };
    render();
    expect(props.tab).toBe("tasks");
    expect(tasksTab().getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("A reviewer is checking Task 6");
  });

  it("appends Tasks to an old saved tab order", () => {
    localStorage.setItem(
      "monocode.sidebarTabOrder",
      JSON.stringify(["changes", "files", "inbox", "sessions"]),
    );
    render();
    const labels = Array.from(container.querySelectorAll('[role="tab"]')).map((el) => el.textContent);
    expect(labels).toEqual(["Changes", "Explorer", "Sessions", "Tasks"]);
  });

  it("keeps remote projects' plan files off the board, but shows the transcript sections", () => {
    props = { ...props, cwd: remotePath("env-1", "/home/dev/project"), busySessionIds: new Set(["session-1"]), tab: "tasks" };
    render();
    const input = vi.mocked(useTaskBoard).mock.calls.at(-1)![0];
    expect(input.readPlan).toBe(false);
    expect(input.visible).toBe(true);
    expect(input.sessions).toEqual([]);
  });

  describe("compact rail", () => {
    function railTasks(): HTMLButtonElement {
      const rail = container.querySelector<HTMLElement>("[data-compact-project-rail]")!;
      return Array.from(rail.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((el) =>
        el.getAttribute("aria-label")?.startsWith("Tasks"),
      )!;
    }
    beforeEach(() => {
      props = {
        ...props,
        projectRailOpen: false,
        onSelectProject: vi.fn(),
        onOpenProject: vi.fn(),
      };
    });

    it("lists a plain Tasks tab", () => {
      render();
      expect(railTasks().getAttribute("aria-label")).toBe("Tasks");
    });

    it("carries the badge meaning in its accessible name", () => {
      vi.mocked(useTaskBoard).mockReturnValue(board(ASK));
      render();
      expect(railTasks().getAttribute("aria-label")).toBe("Tasks, needs you");
      act(() => railTasks().click());
      expect(props.onTabChange).toHaveBeenCalledWith("tasks");
    });
  });
});
