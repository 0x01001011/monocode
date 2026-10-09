import { afterEach, expect, it, vi } from "vitest";
import {
  clearComposerPrefill,
  peekComposerPrefill,
  requestComposerPrefill,
  subscribeComposerPrefill,
} from "./composerPrefill";

afterEach(() => {
  vi.useRealTimers();
  const pending = peekComposerPrefill("a");
  if (pending) clearComposerPrefill("a", pending.token);
});

it("keeps a request for its own session until it is cleared", () => {
  const listener = vi.fn();
  const stop = subscribeComposerPrefill(listener);
  requestComposerPrefill("a", "first");
  expect(peekComposerPrefill("a")?.text).toBe("first");
  expect(peekComposerPrefill("b")).toBeNull();
  const taken = peekComposerPrefill("a")!;
  clearComposerPrefill("a", taken.token);
  expect(peekComposerPrefill("a")).toBeNull();
  expect(listener).toHaveBeenCalledTimes(2);
  stop();
});

it("a newer request replaces the older one and an old token cannot clear it", () => {
  requestComposerPrefill("a", "old");
  const old = peekComposerPrefill("a")!;
  requestComposerPrefill("a", "new");
  clearComposerPrefill("a", old.token);
  expect(peekComposerPrefill("a")?.text).toBe("new");
});

it("drops a request nobody consumed after a minute", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  requestComposerPrefill("a", "stale");
  vi.setSystemTime(1_000 + 61_000);
  expect(peekComposerPrefill("a")).toBeNull();
});
