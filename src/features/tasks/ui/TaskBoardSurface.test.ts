// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveQuietAfterMinutes } from "../../settings/model/tasksPrefs";
import type { Session } from "../../sessions/model/session";
import { TaskActionsContext, type TaskActions } from "../hooks/useTaskActions";
import { TaskBoardSurface } from "./TaskBoardSurface";

type ViewProps = {
  projectCwd: string;
  planCwd?: string;
  session?: Session;
  sessions: { id: string; busy: boolean }[];
  quietAfterMs?: number;
  onAction?: (...args: unknown[]) => void;
  onOpenNode?: (...args: unknown[]) => void;
  onOpenPlan?: (...args: unknown[]) => void;
  onChangeDecision?: (...args: unknown[]) => void;
};
const view = vi.hoisted(() => ({ props: [] as ViewProps[] }));
vi.mock("./TaskBoardView", () => ({
  TaskBoardView: (props: ViewProps) => {
    view.props.push(props);
    return null;
  },
}));

const session = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, cwd: "/proj", title: id, blocks: [], ...over }) as unknown as Session;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  view.props.length = 0;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  localStorage.clear();
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("TaskBoardSurface", () => {
  it("gives the view its own session and the project's sessions as status inputs", () => {
    const sessions = [session("a"), session("b", { busy: true }), session("x", { cwd: "/other" })];
    act(() => root.render(createElement(TaskBoardSurface, { projectCwd: "/proj", sessionId: "a", sessions })));
    const props = view.props.at(-1);
    expect(props?.projectCwd).toBe("/proj");
    expect(props?.session).toBe(sessions[0]);
    expect(props?.sessions.map((s) => [s.id, s.busy])).toEqual([["a", false], ["b", true]]);
  });

  it("reads the plan from the tab's working copy, defaulting to the project", () => {
    act(() =>
      root.render(createElement(TaskBoardSurface, { projectCwd: "/proj", planCwd: "/wt/mc-1", sessionId: "a", sessions: [session("a")] })),
    );
    expect(view.props.at(-1)).toMatchObject({ projectCwd: "/proj", planCwd: "/wt/mc-1" });
    act(() => root.render(createElement(TaskBoardSurface, { projectCwd: "/proj", sessionId: "a", sessions: [session("a")] })));
    expect(view.props.at(-1)?.planCwd).toBe("/proj");
  });

  it("still renders when the session is not loaded", () => {
    act(() => root.render(createElement(TaskBoardSurface, { projectCwd: "/proj", sessionId: "gone", sessions: [] })));
    expect(view.props.at(-1)?.session).toBeUndefined();
  });

  it("does not mount the board for a remote project", () => {
    act(() =>
      root.render(createElement(TaskBoardSurface, { projectCwd: "remote://machine/repo", sessionId: "a", sessions: [session("a")] })),
    );
    expect(view.props).toHaveLength(0);
    expect(container.textContent).toContain("not available for remote projects");
  });

  it("passes the quiet threshold from the setting", () => {
    const render = () =>
      act(() => root.render(createElement(TaskBoardSurface, { projectCwd: "/proj", sessionId: "a", sessions: [session("a")] })));
    render();
    expect(view.props.at(-1)?.quietAfterMs).toBe(5 * 60_000);
    act(() => saveQuietAfterMinutes(3));
    expect(view.props.at(-1)?.quietAfterMs).toBe(3 * 60_000);
  });

  it("hands the view the shared task actions, bound to its own session", () => {
    const actions: TaskActions = {
      onAction: vi.fn(),
      onOpenNode: vi.fn(),
      onOpenPlan: vi.fn(),
      onChangeDecision: vi.fn(),
    };
    act(() =>
      root.render(
        createElement(
          TaskActionsContext.Provider,
          { value: actions },
          createElement(TaskBoardSurface, { projectCwd: "/proj", sessionId: "a", sessions: [session("a")] }),
        ),
      ),
    );
    const props = view.props.at(-1);
    expect(props?.onAction).toBe(actions.onAction);
    expect(props?.onOpenPlan).toBe(actions.onOpenPlan);
    const n = { id: "n" };
    const sec = { id: "sec" };
    props?.onOpenNode?.(n, sec);
    expect(actions.onOpenNode).toHaveBeenCalledWith(n, sec, "a");
    props?.onChangeDecision?.({ text: "x" });
    expect(actions.onChangeDecision).toHaveBeenCalledWith({ text: "x" }, "a");
  });

  it("leaves the actions undefined outside a provider", () => {
    act(() => root.render(createElement(TaskBoardSurface, { projectCwd: "/proj", sessionId: "a", sessions: [session("a")] })));
    expect(view.props.at(-1)?.onAction).toBeUndefined();
    expect(view.props.at(-1)?.onOpenNode).toBeUndefined();
  });
});
