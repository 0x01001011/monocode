// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../sessions/model/session";
import { TaskBoardSurface } from "./TaskBoardSurface";

const view = vi.hoisted(() => ({ props: [] as { projectCwd: string; session?: Session; sessions: { id: string; busy: boolean }[] }[] }));
vi.mock("./TaskBoardView", () => ({
  TaskBoardView: (props: (typeof view.props)[number]) => {
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
});
