import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendComposerDraft,
  clearComposerPrefill,
  isComposerMounted,
  markComposerMounted,
  peekComposerPrefill,
  requestComposerPrefill,
  subscribeComposerPrefill,
} from "./composerPrefill";
import {
  clearComposerDraft,
  getComposerDraft,
  setComposerDraft,
} from "./draftCache";

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

it("a kept request outlives the one-minute limit", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  requestComposerPrefill("a", "kept", { keep: true });
  vi.setSystemTime(1_000 + 10 * 60_000);
  expect(peekComposerPrefill("a")?.text).toBe("kept");
});

it("counts mounted composers per session", () => {
  expect(isComposerMounted("a")).toBe(false);
  const first = markComposerMounted("a");
  const second = markComposerMounted("a");
  expect(isComposerMounted("a")).toBe(true);
  expect(isComposerMounted("b")).toBe(false);
  first();
  expect(isComposerMounted("a")).toBe(true);
  second();
  second();
  expect(isComposerMounted("a")).toBe(false);
});

describe("appendComposerDraft", () => {
  afterEach(() => {
    clearComposerDraft("a");
  });

  it("appends to the cached draft when no composer is mounted, and never queues a prefill", () => {
    appendComposerDraft("a", "Restack #2");
    expect(getComposerDraft("a")).toBe("Restack #2");
    setComposerDraft("a", "my notes");
    appendComposerDraft("a", "Restack #2");
    expect(getComposerDraft("a")).toBe("my notes\n\nRestack #2");
    expect(peekComposerPrefill("a")).toBeNull();
  });

  it("hands the text to a mounted composer instead, kept until its pane shows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    setComposerDraft("a", "my notes");
    const unmount = markComposerMounted("a");
    appendComposerDraft("a", "Restack #2");
    appendComposerDraft("a", "Restack #3");
    vi.setSystemTime(1_000 + 5 * 60_000);
    expect(peekComposerPrefill("a")?.text).toBe("Restack #2\n\nRestack #3");
    // The live composer owns its text; the cache is left for it to update.
    expect(getComposerDraft("a")).toBe("my notes");
    unmount();
  });
});
