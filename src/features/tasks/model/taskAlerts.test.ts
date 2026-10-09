import { describe, expect, it } from "vitest";
import type { StatusCard } from "./statusCard";
import { taskAlertsBetween } from "./taskAlerts";

const card = (kind: StatusCard["kind"], patch: Partial<StatusCard> = {}): StatusCard => ({
  kind,
  sessionId: "s1",
  headline: `headline ${kind}`,
  actions: [],
  ...patch,
});

describe("taskAlertsBetween", () => {
  it("alerts once on entering struggling", () => {
    const alerts = taskAlertsBetween(card("running"), card("struggling", { headline: "Task 4 is on fix round 3 of 5" }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "struggling", key: "struggling:s1" });
    expect(alerts[0].body).toContain("Task 4 is on fix round 3 of 5");
  });

  it("alerts when a run goes quiet", () => {
    const alerts = taskAlertsBetween(card("running"), card("quiet"));
    expect(alerts.map((a) => a.kind)).toEqual(["quiet"]);
    expect(alerts[0].key).toBe("quiet:s1");
  });

  it("does not alert twice for the same state", () => {
    expect(taskAlertsBetween(card("struggling"), card("struggling", { headline: "changed text" }))).toEqual([]);
    expect(taskAlertsBetween(card("quiet"), card("quiet", { headline: "No activity for 7m" }))).toEqual([]);
  });

  it("alerts again when the same kind moves to another session", () => {
    const alerts = taskAlertsBetween(card("quiet"), card("quiet", { sessionId: "s2" }));
    expect(alerts.map((a) => a.key)).toEqual(["quiet:s2"]);
  });

  it("plan done alerts once", () => {
    const done = card("done", { sessionId: undefined, headline: "Plan finished in 1h 52m", detail: "9 decisions to look over" });
    const alerts = taskAlertsBetween(card("running"), done);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "plan-done", key: "plan-done:plan" });
    expect(alerts[0].body).toContain("Plan finished in 1h 52m");
    expect(taskAlertsBetween(done, done)).toEqual([]);
  });

  it("needs-you produces no alert here", () => {
    expect(taskAlertsBetween(card("running"), card("needs-you"))).toEqual([]);
    expect(taskAlertsBetween(undefined, card("needs-you"))).toEqual([]);
  });

  it("running to running produces none", () => {
    expect(taskAlertsBetween(card("running"), card("running"))).toEqual([]);
    expect(taskAlertsBetween(card("idle"), card("running"))).toEqual([]);
    expect(taskAlertsBetween(card("struggling"), card("running"))).toEqual([]);
  });

  it("treats a missing previous card as not in the state", () => {
    expect(taskAlertsBetween(undefined, card("struggling")).map((a) => a.kind)).toEqual(["struggling"]);
  });
});
