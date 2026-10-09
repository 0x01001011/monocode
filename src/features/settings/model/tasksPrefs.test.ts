// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QUIET_AFTER_MINUTES_DEFAULT,
  QUIET_AFTER_MINUTES_KEY,
  loadQuietAfterMinutes,
  saveQuietAfterMinutes,
  subscribeQuietAfterMinutes,
} from "./tasksPrefs";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("quiet after minutes preference", () => {
  it("defaults to five minutes", () => {
    expect(QUIET_AFTER_MINUTES_DEFAULT).toBe(5);
    expect(loadQuietAfterMinutes()).toBe(5);
  });

  it("stores a rounded value between 1 and 60", () => {
    saveQuietAfterMinutes(12.4);
    expect(loadQuietAfterMinutes()).toBe(12);
    expect(localStorage.getItem(QUIET_AFTER_MINUTES_KEY)).toBe("12");
    saveQuietAfterMinutes(0);
    expect(loadQuietAfterMinutes()).toBe(1);
    saveQuietAfterMinutes(500);
    expect(loadQuietAfterMinutes()).toBe(60);
  });

  it("clamps and repairs a stored value that is out of range or not a number", () => {
    localStorage.setItem(QUIET_AFTER_MINUTES_KEY, "999");
    expect(loadQuietAfterMinutes()).toBe(60);
    localStorage.setItem(QUIET_AFTER_MINUTES_KEY, "-3");
    expect(loadQuietAfterMinutes()).toBe(1);
    localStorage.setItem(QUIET_AFTER_MINUTES_KEY, "soon");
    expect(loadQuietAfterMinutes()).toBe(5);
  });

  it("notifies this window when saved", () => {
    const listener = vi.fn();
    const stop = subscribeQuietAfterMinutes(listener);
    saveQuietAfterMinutes(9);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    saveQuietAfterMinutes(10);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
