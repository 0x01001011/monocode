import { describe, expect, it } from "vitest";
import type { StatusCard } from "./statusCard";
import {
  STOP_AFTER_TASK_TEXT,
  changeDecisionText,
  effectForAction,
  effectForNode,
} from "./taskActions";
import type { BoardNode, BoardSection } from "./taskBoard";

const card = (patch: Partial<StatusCard> = {}): StatusCard => ({
  kind: "running",
  sessionId: "s1",
  headline: "Working",
  actions: [],
  ...patch,
});
const node = (patch: Partial<BoardNode> = {}): BoardNode => ({ id: "t1", title: "Task 1", status: "done", ...patch });
const section: BoardSection = { source: "sdd", id: "sdd:x", title: "X", done: 0, total: 1, nodes: [] };
const ctx = { projectCwd: "/proj", sddDir: "/proj/.superpowers/sdd/x", sessionId: "s9" };

describe("effectForAction", () => {
  it.each(["answer-in-session", "open-session", "open-reviewer"] as const)("%s selects the card's session", (action) => {
    expect(effectForAction(action, card(), { activeSessionId: "a" })).toEqual({ kind: "select-session", sessionId: "s1" });
  });

  it("falls back to the active session when the card names none", () => {
    expect(effectForAction("open-session", card({ sessionId: undefined }), { activeSessionId: "a" })).toEqual({
      kind: "select-session",
      sessionId: "a",
    });
  });

  it("does nothing when no session is known", () => {
    expect(effectForAction("open-session", card({ sessionId: undefined }), {})).toEqual({ kind: "none" });
    expect(effectForAction("stop-after-task", card({ sessionId: undefined }), {})).toEqual({ kind: "none" });
    expect(effectForAction("keep-waiting", card({ sessionId: undefined }), {})).toEqual({ kind: "none" });
  });

  it("stop-after-task queues the stop message and never interrupts", () => {
    expect(effectForAction("stop-after-task", card(), {})).toEqual({
      kind: "queue-message",
      sessionId: "s1",
      text: STOP_AFTER_TASK_TEXT,
    });
    expect(STOP_AFTER_TASK_TEXT).toBe("Stop after the current task and summarize where you are.");
  });

  it("remind-later and keep-waiting snooze for 10 minutes", () => {
    for (const action of ["remind-later", "keep-waiting"] as const) {
      expect(effectForAction(action, card(), {})).toEqual({ kind: "snooze", sessionId: "s1", ms: 600_000 });
    }
  });

  it("see-issues and review-decisions are handled locally by the UI", () => {
    expect(effectForAction("see-issues", card(), {})).toEqual({ kind: "none" });
    expect(effectForAction("review-decisions", card(), {})).toEqual({ kind: "none" });
  });
});

describe("effectForNode", () => {
  it("opens a report, brief or review by absolute path", () => {
    for (const kind of ["report", "brief", "review"] as const) {
      const n = node({ target: { kind, ref: `/proj/.superpowers/sdd/x/task-2-${kind}.md` } });
      expect(effectForNode(n, section, ctx)).toEqual({ kind: "open-file", path: `/proj/.superpowers/sdd/x/task-2-${kind}.md` });
    }
  });

  it("resolves a relative file name against the sdd directory, else the project", () => {
    const n = node({ target: { kind: "report", ref: "task-2-report.md" } });
    expect(effectForNode(n, section, ctx)).toEqual({ kind: "open-file", path: "/proj/.superpowers/sdd/x/task-2-report.md" });
    expect(effectForNode(n, section, { projectCwd: "/proj/" })).toEqual({ kind: "open-file", path: "/proj/task-2-report.md" });
  });

  it("scrolls the transcript of the board's session", () => {
    const n = node({ target: { kind: "transcript", ref: "block-7" } });
    expect(effectForNode(n, section, ctx)).toEqual({ kind: "scroll-transcript", sessionId: "s9", blockId: "block-7" });
    expect(effectForNode(n, section, { projectCwd: "/proj" })).toEqual({ kind: "none" });
  });

  it("selects the session of a session node", () => {
    expect(effectForNode(node({ target: { kind: "session", ref: "w1" } }), section, ctx)).toEqual({
      kind: "select-session",
      sessionId: "w1",
    });
  });

  it("opens a commit range", () => {
    expect(effectForNode(node({ target: { kind: "commit", ref: "abc1234..def5678" } }), section, ctx)).toEqual({
      kind: "open-commit",
      range: "abc1234..def5678",
    });
    expect(effectForNode(node({ target: { kind: "commit", ref: "" } }), section, ctx)).toEqual({ kind: "none" });
  });

  it("does nothing for a node with no target", () => {
    expect(effectForNode(node(), section, ctx)).toEqual({ kind: "none" });
  });
});

describe("changeDecisionText", () => {
  it("names the task and quotes the decision", () => {
    expect(changeDecisionText({ taskIndex: 4, text: "Record usage at send" })).toBe(
      "About your decision on Task 4: Record usage at send",
    );
  });

  it("leaves the task out when the note has none", () => {
    expect(changeDecisionText({ text: "Use polling" })).toBe("About your decision: Use polling");
  });
});
