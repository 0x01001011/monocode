import { afterEach, describe, expect, it, vi } from "vitest";
import { applySnoozes, clearSnoozes, snoozeSession, snoozeVersion, subscribeSnoozes } from "./taskSnooze";

const input = (id: string, lastActivityAt?: number) => ({ id, title: id, busy: true, needsInput: false, lastActivityAt });

afterEach(() => clearSnoozes());

describe("taskSnooze", () => {
  it("treats a snoozed session as active right now", () => {
    snoozeSession("a", 600_000, 1_000);
    const out = applySnoozes([input("a", 5), input("b", 5)], 2_000);
    expect(out.map((s) => s.lastActivityAt)).toEqual([2_000, 5]);
  });

  it("leaves a session alone once the snooze has ended", () => {
    snoozeSession("a", 600_000, 1_000);
    const sessions = [input("a", 5)];
    expect(applySnoozes(sessions, 601_000)).toBe(sessions);
    expect(applySnoozes(sessions, 700_000)[0].lastActivityAt).toBe(5);
  });

  it("returns the same array when nothing is snoozed", () => {
    const sessions = [input("a", 5)];
    expect(applySnoozes(sessions, 1)).toBe(sessions);
  });

  it("notifies subscribers and bumps the version when a snooze starts", () => {
    const listener = vi.fn();
    const stop = subscribeSnoozes(listener);
    const before = snoozeVersion();
    snoozeSession("a", 1, 0);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(snoozeVersion()).not.toBe(before);
    stop();
    snoozeSession("a", 1, 0);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
