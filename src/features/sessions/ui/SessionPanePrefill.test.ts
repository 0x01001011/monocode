// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionPane, type SessionPaneProps } from "./SessionPane";
import { peekComposerPrefill, requestComposerPrefill } from "../model/composerPrefill";

const probes = vi.hoisted(() => ({ quotes: [] as unknown[], runs: [] as unknown[] }));
vi.mock("./Composer", () => ({
  Composer: (props: { quoteRequest?: unknown }) => {
    probes.quotes.push(props.quoteRequest);
    return null;
  },
}));
vi.mock("../hooks/useFileDrop", () => ({ useFileDrop: () => false }));
vi.mock("./AgentTranscript", () => ({ AgentTranscript: () => null }));
vi.mock("../../orchestration/model/orchestration", async (original) => ({
  ...(await original<typeof import("../../orchestration/model/orchestration")>()),
  orchestrator: { subscribe: () => () => {}, snapshot: () => probes.runs, hydrate: async () => {} },
}));
vi.mock("../../monos/model/mono", async (original) => ({
  ...(await original<typeof import("../../monos/model/mono")>()),
  monoForSession: () => undefined,
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  probes.quotes.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const noop = () => {};
function props(): SessionPaneProps {
  return {
    session: {
      id: "chat",
      title: "Chat",
      cwd: "/repo",
      harness: "codex",
      model: "",
      modelSettings: {},
      runtimeMode: "supervised",
      blocks: [{ id: "user", role: "user", text: "Hello" }],
    },
    visible: true,
    focused: true,
    inSplit: false,
    composerFocused: false,
    recents: [],
    onFocus: noop,
    onClose: noop,
    onCwdChange: noop,
    onBranchChange: noop,
    onWorkspaceModeChange: noop,
    onWorktreeBaseChange: noop,
    onModelChange: noop,
    onModelSettingsChange: noop,
    onRuntimeModeChange: noop,
    onSubmit: noop,
    onSaveDraft: noop,
    onRemoveDraft: noop,
    onStop: noop,
    onCompactContext: () => false,
    onPlaceSessionInFolder: noop,
    onDeleteQueuedMessage: noop,
    onEditQueuedMessage: noop,
    onQueuedMessageEditingChange: noop,
    onSteerQueuedMessage: noop,
    onResumeQueue: noop,
    onUsageLimitResume: noop,
    onUsageLimitResumeAtReset: noop,
    onUsageLimitDismiss: noop,
    onApproval: noop,
    onQuestionReply: noop,
    onOpenFile: noop,
    onOpenDiff: noop,
    onOpenPlan: noop,
    onBuildPlan: noop,
    onNewTerminal: noop,
  };
}
function render(pane: SessionPaneProps) {
  act(() => root.render(createElement(SessionPane, pane)));
}

/** The distinct quote requests the composer was handed. */
const requests = () => [...new Map(probes.quotes.filter(Boolean).map((q) => [(q as { id: number }).id, q])).values()];

it("a Tasks prefill lands once in a mounted local session's composer, as plain text, and is consumed", () => {
  const pane = props();
  render(pane);
  expect(requests()).toEqual([]);
  act(() => requestComposerPrefill("chat", "About your decision on Task 4: Keep it"));
  expect(requests()).toEqual([expect.objectContaining({ text: "About your decision on Task 4: Keep it", mode: "plain" })]);
  expect(peekComposerPrefill("chat")).toBeNull();
  render({ ...pane });
  render({ ...pane, focused: false });
  expect(requests()).toHaveLength(1);
});

it("a hidden pane keeps the prefill until it shows", () => {
  const pane = { ...props(), visible: false };
  render(pane);
  act(() => requestComposerPrefill("chat", "Later"));
  expect(requests()).toEqual([]);
  expect(peekComposerPrefill("chat")?.text).toBe("Later");
  render({ ...pane, visible: true });
  expect(requests()).toEqual([expect.objectContaining({ text: "Later", mode: "plain" })]);
});
