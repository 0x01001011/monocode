import { describe, expect, it } from "vitest";
import type { BoardNode, BoardSection, BoardStage } from "./taskBoard";
import { deriveStatusCard, tabBadge, type StatusCard, type StatusSessionInput } from "./statusCard";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 9, 14, 0, 0);
const NOW = T0 + 60 * MIN;
const QUIET = 5 * MIN;

const session = (over: Partial<StatusSessionInput> & { id: string }): StatusSessionInput => ({
  title: over.id,
  busy: false,
  needsInput: false,
  ...over,
});

const stage = (kind: BoardStage["kind"], label: string, status: BoardStage["status"], startedAt?: number): BoardStage => ({
  kind,
  label,
  status,
  ...(startedAt !== undefined ? { startedAt } : {}),
});

const doneNode = (index: number): BoardNode => ({
  id: `task-${index}`,
  title: `Finished task ${index}`,
  index,
  status: "done",
  startedAt: T0 + (index - 1) * 10 * MIN,
  endedAt: T0 + index * 10 * MIN,
});

function plan(nodes: BoardNode[], over: Partial<BoardSection> = {}): BoardSection {
  return {
    source: "sdd",
    id: "2026-10-09-tasks-panel",
    title: "Tasks panel",
    done: nodes.filter((n) => n.status === "done").length,
    total: nodes.length,
    startedAt: T0,
    nodes,
    ...over,
  };
}

/** Task 6 running; `lastStage` decides whether the reviewer is on it. */
const runningPlan = (lastStage: BoardStage["kind"] = "implement"): BoardSection =>
  plan([
    doneNode(5),
    {
      id: "task-6",
      title: "Desktop remote wiring",
      index: 6,
      status: "running",
      startedAt: NOW - (2 * MIN + 14_000),
      stages: [
        stage("implement", "Code written", "done", NOW - 7 * MIN),
        stage(lastStage, lastStage === "review" ? "Review in progress" : "Code in progress", "running", NOW - 2 * MIN),
      ],
    },
    { id: "task-7", title: "Next", index: 7, status: "pending" },
  ]);

const strugglingPlan = (rounds = 3): BoardSection =>
  plan([
    doneNode(5),
    {
      id: "task-6",
      title: "Desktop remote wiring",
      index: 6,
      status: "attention",
      startedAt: T0,
      fixRounds: rounds,
    },
  ]);

const active = (over: Partial<StatusSessionInput> = {}) => session({ id: "s1", title: "main", busy: true, ...over });

describe("deriveStatusCard", () => {
  it("no sessions and no plan is idle", () => {
    const card = deriveStatusCard({ sessions: [], now: NOW, quietAfterMs: QUIET });
    expect(card).toEqual({ kind: "idle", headline: "", actions: [] });
  });

  it("needs-you for the active session names the question and its age", () => {
    const card = deriveStatusCard({
      sessions: [
        active({
          needsInput: true,
          question: "Keep password login as a fallback?",
          askedAt: NOW - 3 * MIN,
        }),
      ],
      activeSessionId: "s1",
      plan: runningPlan(),
      now: NOW,
      quietAfterMs: QUIET,
    });
    expect(card.kind).toBe("needs-you");
    expect(card.sessionId).toBe("s1");
    expect(card.headline).toBe("This session is waiting for your answer");
    expect(card.detail).toBe("Task 6 asks: “Keep password login as a fallback?” · 3m ago");
    expect(card.actions).toEqual(["answer-in-session", "remind-later"]);
    expect(card.since).toBe(NOW - 3 * MIN);
  });

  it("needs-you has no detail without a question and drops the age without askedAt", () => {
    const base = { activeSessionId: "s1", now: NOW, quietAfterMs: QUIET };
    expect(
      deriveStatusCard({ ...base, sessions: [active({ needsInput: true, askedAt: NOW - MIN })] }).detail,
    ).toBeUndefined();
    expect(
      deriveStatusCard({ ...base, sessions: [active({ needsInput: true, question: "Proceed?" })], plan: runningPlan() })
        .detail,
    ).toBe("Task 6 asks: “Proceed?”");
    expect(
      deriveStatusCard({
        ...base,
        sessions: [active({ needsInput: true, question: "Proceed?", askedAt: NOW - 10_000 })],
        plan: runningPlan(),
      }).detail,
    ).toBe("Task 6 asks: “Proceed?” · just now");
  });

  it("an alert from another session names that session", () => {
    const card = deriveStatusCard({
      sessions: [active(), session({ id: "s2", title: "ssh-hardening", needsInput: true, question: "Why?" })],
      activeSessionId: "s1",
      plan: runningPlan(),
      now: NOW,
      quietAfterMs: QUIET,
    });
    expect(card.kind).toBe("needs-you");
    expect(card.sessionId).toBe("s2");
    expect(card.headline).toBe("ssh-hardening is waiting for your answer");
    expect(card.detail).toBe("The agent asks: “Why?”");
  });

  it("needs-you outranks struggling", () => {
    const card = deriveStatusCard({
      sessions: [active({ needsInput: true })],
      activeSessionId: "s1",
      plan: strugglingPlan(),
      now: NOW,
      quietAfterMs: QUIET,
    });
    expect(card.kind).toBe("needs-you");
  });

  it("struggling when a task is on fix round 3 or more", () => {
    const card = deriveStatusCard({
      sessions: [active({ lastActivityAt: NOW - MIN })],
      activeSessionId: "s1",
      plan: strugglingPlan(),
      now: NOW,
      quietAfterMs: QUIET,
    });
    expect(card).toMatchObject({
      kind: "struggling",
      sessionId: "s1",
      headline: "Task 6 is on fix round 3 of 5",
      detail: "The reviewer has sent it back 3 times. If round 5 fails, it stops and asks you.",
      actions: ["see-issues"],
    });
  });

  it("two fix rounds is still just running", () => {
    const p = strugglingPlan(2);
    p.nodes[1] = { ...p.nodes[1], status: "running" };
    const card = deriveStatusCard({
      sessions: [active({ lastActivityAt: NOW - MIN })],
      activeSessionId: "s1",
      plan: p,
      now: NOW,
      quietAfterMs: QUIET,
    });
    expect(card.kind).toBe("running");
  });

  it("struggling outranks quiet", () => {
    const card = deriveStatusCard({
      sessions: [active({ lastActivityAt: NOW - 20 * MIN })],
      activeSessionId: "s1",
      plan: strugglingPlan(4),
      now: NOW,
      quietAfterMs: QUIET,
    });
    expect(card.kind).toBe("struggling");
    expect(card.headline).toBe("Task 6 is on fix round 4 of 5");
  });

  it("quiet needs lastActivityAt older than quietAfterMs and ignores a session that is not busy", () => {
    const base = { activeSessionId: "s1", plan: runningPlan(), now: NOW, quietAfterMs: QUIET };
    const quiet = deriveStatusCard({ ...base, sessions: [active({ lastActivityAt: NOW - 6 * MIN })] });
    expect(quiet).toMatchObject({
      kind: "quiet",
      sessionId: "s1",
      headline: "No activity on Task 6 for 6m",
      actions: ["open-reviewer", "keep-waiting"],
      since: NOW - 6 * MIN,
    });

    const justUnder = deriveStatusCard({ ...base, sessions: [active({ lastActivityAt: NOW - 4 * MIN })] });
    expect(justUnder.kind).toBe("running");

    const atThreshold = deriveStatusCard({ ...base, sessions: [active({ lastActivityAt: NOW - QUIET })] });
    expect(atThreshold.kind).toBe("quiet");

    const notBusy = deriveStatusCard({
      sessions: [active({ busy: false, lastActivityAt: NOW - 30 * MIN })],
      activeSessionId: "s1",
      now: NOW,
      quietAfterMs: QUIET,
    });
    expect(notBusy.kind).toBe("idle");

    const unknownActivity = deriveStatusCard({ ...base, sessions: [active()] });
    expect(unknownActivity.kind).toBe("running");
  });

  it("quiet on another session is named by its title", () => {
    const card = deriveStatusCard({
      sessions: [active({ lastActivityAt: NOW - MIN }), session({ id: "s2", title: "ssh-hardening", busy: true, lastActivityAt: NOW - 8 * MIN })],
      activeSessionId: "s1",
      plan: runningPlan(),
      now: NOW,
      quietAfterMs: QUIET,
    });
    expect(card.kind).toBe("quiet");
    expect(card.sessionId).toBe("s2");
    expect(card.headline).toBe("No activity on ssh-hardening for 8m");
  });

  it("running names the task, the stage and how long it has run", () => {
    const base = { sessions: [active({ lastActivityAt: NOW - 10_000 })], activeSessionId: "s1", now: NOW, quietAfterMs: QUIET };
    const working = deriveStatusCard({ ...base, plan: runningPlan("implement") });
    expect(working).toMatchObject({
      kind: "running",
      sessionId: "s1",
      headline: "The agent is working on Task 6",
      detail: "Desktop remote wiring · 2m 14s so far",
      reassurance: "Nothing needs you",
      actions: ["stop-after-task", "open-session"],
      since: NOW - (2 * MIN + 14_000),
    });
    const reviewing = deriveStatusCard({ ...base, plan: runningPlan("review") });
    expect(reviewing.headline).toBe("A reviewer is checking Task 6");
    expect(reviewing.detail).toBe("Desktop remote wiring · 2m 14s so far");
  });

  it("running falls back when there is no indexed task", () => {
    const base = { activeSessionId: "s1", now: NOW, quietAfterMs: QUIET };
    expect(deriveStatusCard({ ...base, sessions: [active()] }).headline).toBe("The agent is working");
    const p = plan([{ id: "a", title: "Wire the remote", status: "running" }]);
    const card = deriveStatusCard({ ...base, sessions: [active()], plan: p });
    expect(card.headline).toBe("The agent is working on Wire the remote");
    expect(card.detail).toBe("Wire the remote");
  });

  it("a running plan node counts even when no session reports busy", () => {
    const card = deriveStatusCard({
      sessions: [active({ busy: false })],
      activeSessionId: "s1",
      plan: runningPlan(),
      now: NOW,
      quietAfterMs: QUIET,
    });
    expect(card.kind).toBe("running");
  });

  it("done when every task is finished and nothing runs", () => {
    const nodes = [1, 2, 3].map(doneNode);
    const p = plan(nodes, {
      decisions: Array.from({ length: 9 }, (_, i) => ({ taskIndex: 1, text: `d${i}` })),
    });
    const card = deriveStatusCard({
      sessions: [active({ busy: false })],
      activeSessionId: "s1",
      plan: p,
      now: NOW,
      quietAfterMs: QUIET,
    });
    expect(card).toMatchObject({
      kind: "done",
      headline: "Plan finished in 30m",
      detail: "9 decisions to look over",
      actions: ["review-decisions"],
    });
  });

  it("done without decisions has no detail and an unknown duration stays unknown", () => {
    const nodes = [1, 2].map(doneNode);
    const base = { sessions: [], now: NOW, quietAfterMs: QUIET };
    expect(deriveStatusCard({ ...base, plan: plan(nodes) }).detail).toBeUndefined();
    const noTimes = plan([{ id: "a", title: "A", index: 1, status: "done" }], { startedAt: undefined });
    const card = deriveStatusCard({ ...base, plan: noTimes });
    expect(card.kind).toBe("done");
    expect(card.headline).toBe("Plan finished");
    expect(card.since).toBeUndefined();
  });

  it("an empty plan (0 of 0) is idle, as is a partly finished plan with nothing running", () => {
    const base = { sessions: [], now: NOW, quietAfterMs: QUIET };
    expect(deriveStatusCard({ ...base, plan: plan([]) }).kind).toBe("idle");
    expect(deriveStatusCard({ ...base, plan: plan([doneNode(1), { id: "t2", title: "T2", index: 2, status: "pending" }]) }).kind).toBe("idle");
  });

  it("others counts the busy sessions the card does not name, and names the quietest", () => {
    const card = deriveStatusCard({
      sessions: [
        active({ lastActivityAt: NOW - MIN }),
        session({ id: "s2", title: "ssh-hardening", busy: true, lastActivityAt: NOW - 6 * MIN }),
        session({ id: "s3", title: "docs", busy: true, lastActivityAt: NOW - 5 * MIN }),
        session({ id: "s4", title: "idle one" }),
      ],
      activeSessionId: "s1",
      plan: runningPlan(),
      now: NOW,
      quietAfterMs: QUIET,
    });
    expect(card.kind).toBe("quiet");
    expect(card.sessionId).toBe("s2");
    expect(card.others).toEqual({ count: 2, kind: "quiet", text: "2 other runs · docs quiet 5m" });
  });

  it("others: one run, no one quiet, or a waiting session", () => {
    const base = { activeSessionId: "s1", now: NOW, quietAfterMs: QUIET };
    const running = deriveStatusCard({
      ...base,
      sessions: [active({ lastActivityAt: NOW - MIN }), session({ id: "s2", title: "docs", busy: true, lastActivityAt: NOW - MIN })],
    });
    expect(running.others).toEqual({ count: 1, kind: "running", text: "1 other run" });

    const waiting = deriveStatusCard({
      ...base,
      sessions: [
        active({ lastActivityAt: NOW - MIN }),
        session({ id: "s2", title: "docs", busy: true, lastActivityAt: NOW - 9 * MIN }),
        session({ id: "s3", title: "ssh-hardening", needsInput: true }),
      ],
    });
    // The card names ssh-hardening, so the line covers only the remaining runs.
    expect(waiting.sessionId).toBe("s3");
    expect(waiting.others).toEqual({ count: 2, kind: "quiet", text: "2 other runs · docs quiet 9m" });
  });

  it("others never includes the session the card names, and compares ids not titles", () => {
    const card = deriveStatusCard({
      sessions: [
        active({ lastActivityAt: NOW - MIN }),
        session({ id: "s2", title: "ssh-hardening", needsInput: true, askedAt: NOW - 2 * MIN }),
        session({ id: "s3", title: "ssh-hardening-v2", needsInput: true, askedAt: NOW - MIN }),
      ],
      activeSessionId: "s1",
      plan: runningPlan(),
      now: NOW,
      quietAfterMs: QUIET,
    });
    expect(card.kind).toBe("needs-you");
    expect(card.sessionId).toBe("s2");
    expect(card.sessionTitle).toBe("ssh-hardening");
    expect(card.others?.text).toBe("2 other runs · ssh-hardening-v2 needs you");

    const only = deriveStatusCard({
      sessions: [active({ lastActivityAt: NOW - MIN }), session({ id: "s2", title: "ssh-hardening", needsInput: true })],
      activeSessionId: "s1",
      now: NOW,
      quietAfterMs: QUIET,
    });
    expect(only.sessionId).toBe("s2");
    expect(only.others).toEqual({ count: 1, kind: "running", text: "1 other run" });

    const alone = deriveStatusCard({
      sessions: [session({ id: "s2", title: "ssh-hardening", needsInput: true })],
      activeSessionId: "s1",
      now: NOW,
      quietAfterMs: QUIET,
    });
    expect(alone.others).toBeUndefined();
  });

  it("an active session that is quiet plus another waiting: needs-you names the other, others mentions only the rest", () => {
    const card = deriveStatusCard({
      sessions: [
        active({ lastActivityAt: NOW - 8 * MIN }),
        session({ id: "s2", title: "ssh-hardening", needsInput: true, question: "Why?" }),
      ],
      activeSessionId: "s1",
      plan: runningPlan(),
      now: NOW,
      quietAfterMs: QUIET,
    });
    expect(card.kind).toBe("needs-you");
    expect(card.sessionId).toBe("s2");
    expect(card.headline).toBe("ssh-hardening is waiting for your answer");
    expect(card.others).toEqual({ count: 1, kind: "quiet", text: "1 other run · main quiet 8m" });
    expect(card.others?.text).not.toContain("ssh-hardening");
  });

  it("a running plan node belongs to the active session even when another one is busy", () => {
    const card = deriveStatusCard({
      sessions: [
        session({ id: "s0", title: "docs", busy: true, lastActivityAt: NOW - MIN }),
        active({ lastActivityAt: NOW - MIN }),
      ],
      activeSessionId: "s1",
      plan: runningPlan(),
      now: NOW,
      quietAfterMs: QUIET,
    });
    expect(card.kind).toBe("running");
    expect(card.sessionId).toBe("s1");
    expect(card.sessionTitle).toBe("main");
    expect(card.others).toEqual({ count: 1, kind: "running", text: "1 other run" });
  });

  it("sessionTitle is absent when the card names no session", () => {
    const card = deriveStatusCard({ sessions: [], now: NOW, quietAfterMs: QUIET });
    expect(card.sessionTitle).toBeUndefined();
  });

  it("others is omitted when no other session is busy or waiting", () => {
    const card = deriveStatusCard({
      sessions: [active(), session({ id: "s2", title: "idle" })],
      activeSessionId: "s1",
      now: NOW,
      quietAfterMs: QUIET,
    });
    expect(card.others).toBeUndefined();
  });

  it("never reads the clock and survives an empty plan and empty sessions", () => {
    const realNow = Date.now;
    Date.now = () => {
      throw new Error("Date.now must not be read");
    };
    try {
      expect(() => deriveStatusCard({ sessions: [], plan: plan([]), now: NOW, quietAfterMs: QUIET })).not.toThrow();
    } finally {
      Date.now = realNow;
    }
  });
});

describe("tabBadge", () => {
  it("maps kinds", () => {
    const card = (kind: StatusCard["kind"]): StatusCard => ({ kind, headline: "", actions: [] });
    expect(tabBadge(card("needs-you"))).toBe("ask");
    expect(tabBadge(card("struggling"))).toBe("fail");
    expect(tabBadge(card("quiet"))).toBe("quiet");
    expect(tabBadge(card("running"))).toBeUndefined();
    expect(tabBadge(card("done"))).toBeUndefined();
    expect(tabBadge(card("idle"))).toBeUndefined();
  });
});
