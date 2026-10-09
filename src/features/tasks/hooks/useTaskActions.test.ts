// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusCard } from "../model/statusCard";
import { STOP_AFTER_TASK_TEXT } from "../model/taskActions";
import type { BoardNode, BoardSection } from "../model/taskBoard";
import { useTaskActions, type TaskActionHost, type TaskActions } from "./useTaskActions";

function fakeHost(busy: readonly string[] = ["s1", "active"]) {
  const calls: [string, ...unknown[]][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const host: TaskActionHost = {
    selectSession: record("selectSession"),
    queueMessage: record("queueMessage"),
    prefillComposer: record("prefillComposer"),
    openFile: record("openFile"),
    openCommit: record("openCommit"),
    scrollToBlock: record("scrollToBlock"),
    snooze: record("snooze"),
    remind: record("remind"),
    isBusy: (sessionId) => busy.includes(sessionId),
  };
  return { host, calls };
}

const card = (patch: Partial<StatusCard> = {}): StatusCard => ({ kind: "running", sessionId: "s1", headline: "", actions: [], ...patch });
const node = (patch: Partial<BoardNode> = {}): BoardNode => ({ id: "n", title: "Task 1", status: "done", ...patch });
const section: BoardSection = { source: "sdd", id: "sdd:x", title: "X", done: 0, total: 1, nodes: [] };

let container: HTMLDivElement;
let root: Root;
let actions: TaskActions;

function Probe(props: { host: TaskActionHost; activeSessionId?: string }) {
  actions = useTaskActions(props.host, { projectCwd: "/proj", activeSessionId: props.activeSessionId });
  return null;
}
/** `null` means no active session. */
const mount = (host: TaskActionHost, activeSessionId: string | null = "active") =>
  act(() => root.render(createElement(Probe, { host, activeSessionId: activeSessionId ?? undefined })));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("useTaskActions", () => {
  it("answer, open session and open reviewer select the card's session", () => {
    const { host, calls } = fakeHost();
    mount(host);
    for (const action of ["answer-in-session", "open-session", "open-reviewer"] as const) actions.onAction(action, card());
    expect(calls).toEqual([["selectSession", "s1"], ["selectSession", "s1"], ["selectSession", "s1"]]);
  });

  it("falls back to the active session when the card has none", () => {
    const { host, calls } = fakeHost();
    mount(host);
    actions.onAction("open-session", card({ sessionId: undefined }));
    expect(calls).toEqual([["selectSession", "active"]]);
  });

  it("stop after task queues the stop message and selects nothing", () => {
    const { host, calls } = fakeHost();
    mount(host);
    actions.onAction("stop-after-task", card());
    expect(calls).toEqual([["queueMessage", "s1", STOP_AFTER_TASK_TEXT]]);
  });

  it("stop after task sends nothing, and starts no turn, when the session is not busy", () => {
    const { host, calls } = fakeHost([]);
    mount(host);
    actions.onAction("stop-after-task", card());
    expect(calls).toEqual([]);
  });

  it("remind later schedules a real reminder ten minutes from now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const { host, calls } = fakeHost();
      mount(host);
      actions.onAction("remind-later", card());
      expect(calls).toEqual([["remind", "s1", 1_700_000_000_000 + 600_000]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keep waiting snoozes the quiet state for 10 minutes", () => {
    const { host, calls } = fakeHost();
    mount(host);
    actions.onAction("keep-waiting", card());
    expect(calls).toEqual([["snooze", "s1", 600_000]]);
  });

  it("logs a failing host call instead of throwing or leaving a rejection", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host } = fakeHost();
    mount({
      ...host,
      selectSession: () => Promise.reject(new Error("no such session")),
      openFile: () => {
        throw new Error("boom");
      },
    });
    expect(() => actions.onAction("open-session", card())).not.toThrow();
    expect(() => actions.onOpenPlan("p.md")).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("see issues and review decisions touch nothing", () => {
    const { host, calls } = fakeHost();
    mount(host);
    actions.onAction("see-issues", card());
    actions.onAction("review-decisions", card());
    expect(calls).toEqual([]);
  });

  it("opens report files and commits", () => {
    const { host, calls } = fakeHost();
    mount(host);
    actions.onOpenNode(node({ target: { kind: "report", ref: "/p/task-1-report.md" } }), section);
    actions.onOpenNode(node({ target: { kind: "commit", ref: "aaaa111..bbbb222" } }), section);
    expect(calls).toEqual([["openFile", "/p/task-1-report.md"], ["openCommit", "aaaa111..bbbb222"]]);
  });

  it("opens a session node by selecting it", () => {
    const { host, calls } = fakeHost();
    mount(host);
    actions.onOpenNode(node({ target: { kind: "session", ref: "w1" } }), section);
    expect(calls).toEqual([["selectSession", "w1"]]);
  });

  it("jumps to a transcript block in the board's own session, then selects it", () => {
    const { host, calls } = fakeHost();
    mount(host);
    actions.onOpenNode(node({ target: { kind: "transcript", ref: "blk" } }), section, "tab-session");
    expect(calls).toEqual([["scrollToBlock", "tab-session", "blk"], ["selectSession", "tab-session"]]);
    calls.length = 0;
    actions.onOpenNode(node({ target: { kind: "transcript", ref: "blk" } }), section);
    expect(calls).toEqual([["scrollToBlock", "active", "blk"], ["selectSession", "active"]]);
  });

  it("selects the session even when the host cannot scroll", () => {
    const { host, calls } = fakeHost();
    mount({ ...host, scrollToBlock: undefined });
    actions.onOpenNode(node({ target: { kind: "transcript", ref: "blk" } }), section);
    expect(calls).toEqual([["selectSession", "active"]]);
  });

  it("opens the plan file", () => {
    const { host, calls } = fakeHost();
    mount(host);
    actions.onOpenPlan("docs/plan.md");
    expect(calls).toEqual([["openFile", "docs/plan.md"]]);
  });

  it("change decision prefills the composer and never sends", () => {
    const { host, calls } = fakeHost();
    mount(host);
    actions.onChangeDecision({ taskIndex: 4, text: "Record usage at send" });
    actions.onChangeDecision({ text: "Use polling" }, "tab-session");
    // The text is recorded for that session's composer first, then the session is shown; nothing is sent.
    expect(calls).toEqual([
      ["prefillComposer", "active", "About your decision on Task 4: Record usage at send"],
      ["selectSession", "active"],
      ["prefillComposer", "tab-session", "About your decision: Use polling"],
      ["selectSession", "tab-session"],
    ]);
    expect(calls.some(([name]) => name === "queueMessage")).toBe(false);
  });

  it("does nothing when no session is known", () => {
    const { host, calls } = fakeHost();
    mount(host, null);
    actions.onAction("stop-after-task", card({ sessionId: undefined }));
    actions.onChangeDecision({ text: "x" });
    expect(calls).toEqual([]);
  });

  it("keeps the callbacks stable and uses the newest host", () => {
    const first = fakeHost();
    const second = fakeHost();
    mount(first.host);
    const before = actions;
    mount(second.host);
    expect(actions.onAction).toBe(before.onAction);
    actions.onOpenPlan("p.md");
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual([["openFile", "p.md"]]);
  });
});
