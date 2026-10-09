// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusCard } from "../model/statusCard";
import { STOP_AFTER_TASK_TEXT } from "../model/taskActions";
import { buildTaskActionHost, type TaskActionHostDeps } from "./taskActionHost";
import { useTaskActions, type TaskActions } from "./useTaskActions";

function deps(over: Partial<TaskActionHostDeps> = {}) {
  const calls: [string, ...unknown[]][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const value: TaskActionHostDeps = {
    selectSession: record("selectSession"),
    isBusy: () => true,
    canSteer: () => true,
    submit: record("submit"),
    isMono: () => false,
    requestComposerPrefill: record("requestComposerPrefill"),
    scheduleReminder: record("scheduleReminder"),
    openFile: record("openFile"),
    openCommit: record("openCommit"),
    scrollToBlock: record("scrollToBlock"),
    ...over,
  };
  return { value, calls };
}

describe("buildTaskActionHost", () => {
  it("queueMessage steers a steerable harness and queues any other, never with interrupt options", async () => {
    const steer = deps();
    await buildTaskActionHost(steer.value).queueMessage("s1", STOP_AFTER_TASK_TEXT);
    expect(steer.calls).toEqual([["submit", "s1", STOP_AFTER_TASK_TEXT, { followUpBehavior: "steer" }]]);

    const queue = deps({ canSteer: () => false });
    await buildTaskActionHost(queue.value).queueMessage("s1", STOP_AFTER_TASK_TEXT);
    expect(queue.calls).toEqual([["submit", "s1", STOP_AFTER_TASK_TEXT, { followUpBehavior: "queue" }]]);
    for (const [, , , options] of [...steer.calls, ...queue.calls]) {
      expect(Object.keys(options as object)).toEqual(["followUpBehavior"]);
    }
  });

  it("prefillComposer only records a draft, never submits, and skips a Mono", () => {
    const d = deps();
    const host = buildTaskActionHost(d.value);
    host.prefillComposer("s1", "About your decision on Task 4: x");
    expect(d.calls).toEqual([["requestComposerPrefill", "s1", "About your decision on Task 4: x"]]);
    const mono = deps({ isMono: () => true });
    buildTaskActionHost(mono.value).prefillComposer("m1", "x");
    expect(mono.calls).toEqual([]);
  });

  it("opens absolute files exactly, relative ones by search, and commits by the range's end", () => {
    const d = deps();
    const host = buildTaskActionHost(d.value);
    host.openFile("/w/task-2-report.md");
    host.openFile("docs/plan.md");
    host.openCommit("129e9e2..e704fdd");
    host.openCommit("abc1234");
    expect(d.calls).toEqual([
      ["openFile", "/w/task-2-report.md", { exact: true }],
      ["openFile", "docs/plan.md", undefined],
      ["openCommit", "e704fdd", "129e9e2..e704fdd"],
      ["openCommit", "abc1234", "abc1234"],
    ]);
  });

  describe("through useTaskActions", () => {
    let actions: TaskActions;
    let root: ReturnType<typeof createRoot>;
    function Probe({ value }: { value: TaskActionHostDeps }) {
      actions = useTaskActions(buildTaskActionHost(value), { projectCwd: "/proj" });
      return null;
    }
    beforeEach(() => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      root = createRoot(document.createElement("div"));
    });
    afterEach(() => {
      act(() => root.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("Remind me schedules a reminder for the card's session ten minutes from now", () => {
      const d = deps();
      act(() => root.render(createElement(Probe, { value: d.value })));
      const card: StatusCard = { kind: "needs-you", sessionId: "s1", headline: "", actions: ["remind-later"] };
      act(() => actions.onAction("remind-later", card));
      expect(d.calls).toEqual([["scheduleReminder", ["s1"], 1_700_000_000_000 + 10 * 60_000]]);
    });

    it("Change this prefills the composer, then selects the session, and never submits", async () => {
      const d = deps();
      act(() => root.render(createElement(Probe, { value: d.value })));
      act(() => actions.onChangeDecision({ taskIndex: 4, text: "Keep it" }, "s1"));
      expect(d.calls).toEqual([
        ["requestComposerPrefill", "s1", "About your decision on Task 4: Keep it"],
        ["selectSession", "s1"],
      ]);
      expect(d.calls.some(([name]) => name === "submit")).toBe(false);
    });
  });
});
