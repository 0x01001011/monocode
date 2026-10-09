// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import {
  announceSessionFinished,
  notifySession,
  notifyTaskAlert,
  saveNotificationsEnabled,
  setWindowFocused,
} from "./notifications";
import { updateNotificationPreferences } from "./notificationPreferences";
import { newSession } from "../../sessions/model/session";

const { invoke, play } = vi.hoisted(() => ({ invoke: vi.fn(), play: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("cuelume", () => ({ play, setEnabled: vi.fn(), setVolume: vi.fn() }));
beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  play.mockClear();
  invoke.mockResolvedValue(undefined);
  saveNotificationsEnabled(true);
  setWindowFocused(false);
});

it("returns false without a banner or sound for a non-project path", async () => {
  const sent = await notifySession(
    newSession("claude", "/"),
    "finished",
    false,
  );

  expect(sent).toBe(false);
  expect(
    invoke.mock.calls.filter(([command]) => command === "show_notification"),
  ).toEqual([]);
  expect(play).not.toHaveBeenCalled();
});

it("finishes without a banner or sound for a non-project path", async () => {
  await expect(
    announceSessionFinished(
      newSession("claude", "/"),
      false,
    ),
  ).resolves.toBeUndefined();

  expect(
    invoke.mock.calls.filter(([command]) => command === "show_notification"),
  ).toEqual([]);
  expect(play).not.toHaveBeenCalled();
});

it("blocks every project banner, including approvals and questions, while muted", async () => {
  updateNotificationPreferences(["local:/private"], {
    mutedUntil: null,
  });
  const session = newSession("claude", "/private");
  expect(await notifySession(session, "finished", false)).toBe(false);
  expect(
    await notifySession(session, { kind: "approval", requestId: 1 }, false),
  ).toBe(false);
  expect(
    await notifySession(session, { kind: "question", requestId: 2 }, false),
  ).toBe(false);
  expect(
    invoke.mock.calls.filter(([command]) => command === "show_notification"),
  ).toEqual([]);
});

it("does not deliver an input event observed during a mute after expiry", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  try {
    updateNotificationPreferences(["local:/private"], {
      mutedUntil: 2000,
    });
    const sent = notifySession(
      newSession("claude", "/private"),
      { kind: "question", requestId: 1 },
      false,
    );
    vi.setSystemTime(3000);
    expect(await sent).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

const shown = () => invoke.mock.calls.filter(([command]) => command === "show_notification");
const quiet = { kind: "quiet", title: "A run has gone quiet", body: "No activity on Task 6 for 6m" } as const;
const finished = { kind: "plan-done", title: "Plan finished", body: "Plan finished in 1h 52m" } as const;

it("shows a task alert for a known project with the alert text", async () => {
  const session = newSession("claude", "/private");
  expect(await notifyTaskAlert(session, quiet, false)).toBe(true);
  expect(shown()).toHaveLength(1);
  expect(shown()[0][1]).toMatchObject({
    sessionId: session.id,
    title: "MonoCode",
    body: "No activity on Task 6 for 6m",
  });
  expect(shown()[0][1].subtitle).toContain("A run has gone quiet");
});

it("keeps a task alert quiet while the user is looking at that session", async () => {
  setWindowFocused(true);
  expect(await notifyTaskAlert(newSession("claude", "/private"), quiet, true)).toBe(false);
  expect(shown()).toEqual([]);
});

it("applies the same project mute and category rules to task alerts", async () => {
  const session = newSession("claude", "/private");
  updateNotificationPreferences(["local:/private"], { disabled: ["agentFinished"] });
  expect(await notifyTaskAlert(session, finished, false)).toBe(false);
  expect(await notifyTaskAlert(session, quiet, false)).toBe(true);
  updateNotificationPreferences(["local:/private"], { mutedUntil: null });
  expect(await notifyTaskAlert(session, quiet, false)).toBe(false);
  expect(shown()).toHaveLength(1);
});

it("sends no task alert for a non-project path or when notifications are off", async () => {
  expect(await notifyTaskAlert(newSession("claude", "/"), quiet, false)).toBe(false);
  saveNotificationsEnabled(false);
  expect(await notifyTaskAlert(newSession("claude", "/private"), quiet, false)).toBe(false);
  expect(shown()).toEqual([]);
});
