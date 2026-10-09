import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPreviewLogs,
  getPreviewLogs,
  previewLogKey,
  recordPreviewLog,
  subscribePreviewLogs,
} from "./previewLogs";

beforeEach(() => {
  clearPreviewLogs("artifact:a");
  clearPreviewLogs("artifact:b");
});

describe("preview logs", () => {
  it("keeps entries per preview in order, with level and time", () => {
    recordPreviewLog("artifact:a", "log", "hello");
    recordPreviewLog("artifact:a", "error", "boom");
    recordPreviewLog("artifact:b", "warn", "other");
    const a = getPreviewLogs("artifact:a");
    expect(a.map((e) => [e.level, e.text])).toEqual([
      ["log", "hello"],
      ["error", "boom"],
    ]);
    expect(typeof a[0].at).toBe("number");
    expect(getPreviewLogs("artifact:b")).toHaveLength(1);
    expect(getPreviewLogs("artifact:none")).toEqual([]);
  });

  it("keeps only the newest 500 entries", () => {
    for (let i = 0; i < 520; i += 1) recordPreviewLog("artifact:a", "log", `m${i}`);
    const entries = getPreviewLogs("artifact:a");
    expect(entries).toHaveLength(500);
    expect(entries[0].text).toBe("m20");
    expect(entries[499].text).toBe("m519");
  });

  it("returns a new array on every change so subscribers re-render, and the same one otherwise", () => {
    const before = getPreviewLogs("artifact:a");
    expect(getPreviewLogs("artifact:a")).toBe(before);
    recordPreviewLog("artifact:a", "log", "x");
    expect(getPreviewLogs("artifact:a")).not.toBe(before);
  });

  it("notifies only the subscribers of that preview, until they unsubscribe", () => {
    const a = vi.fn();
    const b = vi.fn();
    const stopA = subscribePreviewLogs("artifact:a", a);
    subscribePreviewLogs("artifact:b", b);
    recordPreviewLog("artifact:a", "log", "x");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    stopA();
    recordPreviewLog("artifact:a", "log", "y");
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("clears a preview's entries and tells its subscribers", () => {
    recordPreviewLog("artifact:a", "log", "x");
    const listener = vi.fn();
    subscribePreviewLogs("artifact:a", listener);
    clearPreviewLogs("artifact:a");
    expect(getPreviewLogs("artifact:a")).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

it("keys a preview by what it shows", () => {
  expect(previewLogKey({ kind: "artifact", id: "artifact-1" })).toBe("artifact:artifact-1");
  expect(previewLogKey({ kind: "file", path: "/repo/site/index.html" })).toBe(
    "file:/repo/site/index.html",
  );
});
