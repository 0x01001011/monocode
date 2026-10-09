// @vitest-environment happy-dom
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskAlertTarget } from "../../notifications/model/notifications";
import type { StatusCard } from "../model/statusCard";
import { useTaskAlerts } from "./useTaskAlerts";

const card = (kind: StatusCard["kind"], patch: Partial<StatusCard> = {}): StatusCard => ({
  kind,
  sessionId: "s1",
  headline: `headline ${kind}`,
  actions: [],
  ...patch,
});
const target = (id: string): TaskAlertTarget => ({ id, cwd: "/proj", title: id, harness: "claude" }) as TaskAlertTarget;

let container: HTMLDivElement;
let root: Root;
const notify = vi.fn(async () => true);

function Probe(props: { card: StatusCard; activeSessionId?: string; known?: string[]; ready?: boolean; projectCwd?: string }) {
  useTaskAlerts(props.card, {
    ready: props.ready ?? true,
    projectCwd: props.projectCwd ?? "/proj",
    findSession: (id) => ((props.known ?? ["s1", "s2"]).includes(id) ? target(id) : undefined),
    activeSessionId: props.activeSessionId,
    notify,
  });
  return null;
}
const render = (props: Parameters<typeof Probe>[0], strict = false) =>
  act(() => {
    const el = createElement(Probe, props);
    root.render(strict ? createElement(StrictMode, null, el) : el);
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notify.mockClear();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("useTaskAlerts", () => {
  it("does not alert for the first ready card, even a finished plan", () => {
    render({ card: card("done", { sessionId: undefined }), activeSessionId: "s1" });
    render({ card: card("done", { sessionId: undefined, headline: "Plan finished in 4m" }), activeSessionId: "s1" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("first load idle -> done alerts nothing, because the baseline waits for the plan", () => {
    render({ card: card("idle", { sessionId: undefined }), ready: false });
    render({ card: card("done", { sessionId: undefined, headline: "Plan finished in 4m" }), ready: true });
    expect(notify).not.toHaveBeenCalled();
    render({ card: card("struggling"), ready: true });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("first load idle -> struggling alerts nothing", () => {
    render({ card: card("idle"), ready: false });
    render({ card: card("struggling"), ready: true });
    expect(notify).not.toHaveBeenCalled();
  });

  it("a real later running -> done alerts once", () => {
    render({ card: card("idle", { sessionId: undefined }), ready: false });
    render({ card: card("running", { sessionId: undefined }), ready: true, activeSessionId: "s1" });
    render({ card: card("done", { sessionId: undefined, headline: "Plan finished in 4m" }), ready: true, activeSessionId: "s1" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), expect.objectContaining({ kind: "plan-done" }), true);
  });

  it("a board that stops being ready starts over without alerting", () => {
    render({ card: card("running"), ready: true });
    render({ card: card("idle"), ready: false });
    render({ card: card("struggling"), ready: true });
    expect(notify).not.toHaveBeenCalled();
  });

  it("changing the project resets the baseline without alerting", () => {
    render({ card: card("running"), projectCwd: "/one" });
    render({ card: card("done", { sessionId: undefined }), projectCwd: "/two" });
    expect(notify).not.toHaveBeenCalled();
    render({ card: card("done", { sessionId: undefined, headline: "again" }), projectCwd: "/two" });
    expect(notify).not.toHaveBeenCalled();
    render({ card: card("running", { sessionId: undefined }), projectCwd: "/two" });
    render({ card: card("done", { sessionId: undefined }), projectCwd: "/two", activeSessionId: "s1" });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("alerts once when a run goes quiet, with the session as target", () => {
    render({ card: card("running"), activeSessionId: "s2" });
    render({ card: card("quiet", { headline: "No activity on Task 6 for 5m" }), activeSessionId: "s2" });
    render({ card: card("quiet", { headline: "No activity on Task 6 for 6m" }), activeSessionId: "s2" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({ kind: "quiet", body: "No activity on Task 6 for 5m" }),
      false,
    );
  });

  it("tells the notifier the session is on screen when it is the active one", () => {
    render({ card: card("running"), activeSessionId: "s1" });
    render({ card: card("struggling"), activeSessionId: "s1" });
    expect(notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "struggling" }), true);
  });

  it("alerts a finished plan on the active session when the card names none", () => {
    render({ card: card("running", { sessionId: undefined }), activeSessionId: "s2" });
    render({ card: card("done", { sessionId: undefined, headline: "Plan finished in 3m" }), activeSessionId: "s2" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" }), expect.objectContaining({ kind: "plan-done" }), true);
  });

  it("never alerts for needs-you, which the input notifications already cover", () => {
    render({ card: card("running") });
    render({ card: card("needs-you") });
    expect(notify).not.toHaveBeenCalled();
  });

  it("skips an alert whose session is not known", () => {
    render({ card: card("running"), known: [] });
    render({ card: card("quiet"), known: [] });
    expect(notify).not.toHaveBeenCalled();
  });

  it("alerts once under StrictMode", () => {
    render({ card: card("running") }, true);
    render({ card: card("quiet") }, true);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
