// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorPane, LayoutNode } from "../model/layout";
import { PaneTree } from "./PaneTree";

const seen = vi.hoisted(() => [] as { id: string; visible: boolean }[]);
vi.mock("../../files/ui/FilePane", async () => {
  const { createElement } = await import("react");
  return {
    FilePane: ({ pane, visible }: { pane: EditorPane; visible: boolean }) => {
      seen.push({ id: pane.id, visible });
      return createElement("div", { "data-file-pane": pane.id });
    },
  };
});

vi.mock("../../sessions/ui/SessionPane", () => ({ SessionPane: () => null }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  seen.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const leaf = (id: string): LayoutNode => ({ type: "leaf", id });

function render(layout: LayoutNode, ids: string[], visible: boolean) {
  const noop = vi.fn();
  const props: ComponentProps<typeof PaneTree> = {
    visible,
    layout,
    sessions: [],
    editorPanes: ids.map((id) => ({ id, files: [], activeFileId: "" })),
    dirtyFileIds: new Set(),
    fileErrorCounts: new Map(),
    focusedId: ids[0],
    composerFocused: false,
    recents: [],
    onFocus: noop,
    onClose: noop,
    onSelectFile: noop,
    onCloseFile: noop,
    onCloseOtherFiles: noop,
    onReorderFiles: noop,
    onFileDirtyChange: noop,
    onFileErrorCountChange: noop,
    onRatio: noop,
    onCwdChange: noop,
    onBranchChange: noop,
    onModelChange: noop,
    onModelSettingsChange: noop,
    onRuntimeModeChange: noop,
    onSubmit: noop,
    onStop: noop,
    onCompactContext: noop,
    onPlaceSessionInFolder: noop,
    onDeleteQueuedMessage: noop,
    onEditQueuedMessage: noop,
    onQueuedMessageEditingChange: noop,
    onSteerQueuedMessage: noop,
    onResumeQueue: noop,
    onApproval: noop,
    onQuestionReply: noop,
    onOpenFile: noop,
    onOpenDiff: noop,
    onOpenPlan: noop,
    onUpdatePlan: noop,
    onBuildPlan: noop,
    onMovePane: noop,
    onDetachPane: noop,
    onNewTerminal: noop,
  };
  act(() => root.render(createElement(PaneTree, props)));
}

describe("PaneTree visible", () => {
  // A board tab in a background workspace must hear that it is hidden, so it stops polling.
  it("passes the workspace's visibility through to each file pane", () => {
    render(leaf("a"), ["a"], true);
    expect(seen.at(-1)).toEqual({ id: "a", visible: true });
    render(leaf("a"), ["a"], false);
    expect(seen.at(-1)).toEqual({ id: "a", visible: false });
    render(leaf("a"), ["a"], true);
    expect(seen.at(-1)).toEqual({ id: "a", visible: true });
  });
});
