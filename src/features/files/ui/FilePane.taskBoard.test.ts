// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newEditorPane, newFileTab, newTaskBoardTab } from "../../workspace/model/layout";
import { newSession } from "../../sessions/model/session";
import { FilePane } from "./FilePane";

const surface = vi.hoisted(() => ({ renders: [] as { projectCwd: string; sessionId: string; sessions: unknown }[] }));
vi.mock("../../tasks/ui/TaskBoardSurface", () => ({
  TaskBoardSurface: (props: { projectCwd: string; sessionId: string; sessions: unknown }) => {
    surface.renders.push(props);
    return createElement("div", { "data-testid": "board" }, `board for ${props.sessionId}`);
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
  isTauri: () => false,
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

describe("file pane task board tabs", () => {
  let root: Root;
  let container: HTMLDivElement;
  let props: ComponentProps<typeof FilePane>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    surface.renders.length = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const noop = () => {};
    props = {
      pane: newEditorPane(newTaskBoardTab("/repo", "session-a", "/project")),
      focused: true,
      dirtyFileIds: new Set(),
      fileErrorCounts: new Map(),
      sessions: [],
      onFocus: noop,
      onSelectFile: noop,
      onCloseFile: noop,
      onCloseOtherFiles: noop,
      onDirtyChange: noop,
      onErrorCountChange: noop,
      onReorderFiles: noop,
      onOpenFile: noop,
      onUpdatePlan: noop,
      onBuildPlan: noop,
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders the board for the active task board tab and keeps it out of the file loop", async () => {
    await act(async () => root.render(createElement(FilePane, props)));
    expect(container.textContent).toContain("board for session-a");
    expect(surface.renders.at(-1)).toMatchObject({ projectCwd: "/project", sessionId: "session-a" });
    // The generic loop would have mounted a second surface for the board's cwd path.
    const surfaceArea = container.querySelector("[data-testid=board]")?.parentElement?.parentElement;
    expect(surfaceArea?.children).toHaveLength(1);
  });

  it("falls back to the tab cwd when no project cwd is stored", async () => {
    const pane = newEditorPane(newTaskBoardTab("/repo", "session-b"));
    await act(async () => root.render(createElement(FilePane, { ...props, pane })));
    expect(surface.renders.at(-1)).toMatchObject({ projectCwd: "/repo", sessionId: "session-b" });
  });

  it("mounts the board only while its tab is active and re-renders it with new sessions", async () => {
    const board = newTaskBoardTab("/repo", "session-a");
    const file = newFileTab("/repo/a.txt", "/repo");
    const pane = { ...newEditorPane(file), files: [file, board], activeFileId: file.id };
    await act(async () => root.render(createElement(FilePane, { ...props, pane })));
    expect(container.textContent).not.toContain("board for");

    const shown = { ...pane, activeFileId: board.id };
    await act(async () => root.render(createElement(FilePane, { ...props, pane: shown })));
    expect(container.textContent).toContain("board for session-a");

    const before = surface.renders.length;
    const session = { ...newSession("codex", "/repo"), id: "session-a" };
    await act(async () => root.render(createElement(FilePane, { ...props, pane: shown, sessions: [session] })));
    expect(surface.renders.length).toBeGreaterThan(before);
    expect(surface.renders.at(-1)?.sessions).toEqual([session]);
  });
});
