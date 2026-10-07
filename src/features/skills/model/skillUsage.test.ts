vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSkillUsage,
  pairKey,
  recordSkillUse,
  resetSkillUsageForTests,
  subscribeSkillUsage,
  usageFromSnapshot,
} from "./skillUsage";

const call = vi.mocked(invoke);

type Handler = (args: Record<string, unknown> | undefined) => unknown;

function route(handlers: Record<string, Handler>) {
  call.mockImplementation(async (cmd: string, args?: unknown) => {
    const handler = handlers[cmd];
    if (!handler) throw new Error(`unexpected ${cmd}`);
    return handler(args as Record<string, unknown> | undefined);
  });
}

const names = () => call.mock.calls.map(([cmd]) => cmd);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  call.mockReset();
  resetSkillUsageForTests();
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});

describe("usageFromSnapshot", () => {
  it("keys pairs with the NUL separator and a before b", () => {
    const usage = usageFromSnapshot({
      usage: [{ invocation: "a", count: 2, lastUsedAt: 5 }],
      pairs: [{ a: "a", b: "b", count: 4, lastUsedAt: 5 }],
    });
    expect(usage.counts.get("a")).toEqual({ count: 2, lastUsedAt: 5 });
    expect(usage.pairs.get("a\u0000b")).toBe(4);
    expect(pairKey("b", "a")).toBe("a\u0000b");
    expect(pairKey("a", "b")).toBe("a\u0000b");
  });

  it("tolerates malformed payloads", () => {
    expect(usageFromSnapshot(undefined).counts.size).toBe(0);
    expect(usageFromSnapshot({ usage: null, pairs: 3 }).pairs.size).toBe(0);
  });
});

describe("recordSkillUse", () => {
  it("records distinct, trimmed invocations once per message", async () => {
    route({
      skill_usage_backfill: () => 0,
      skill_usage_record: () => undefined,
    });
    await recordSkillUse("/p/app/", ["a", "b", "a", " b ", ""]);
    const record = call.mock.calls.find(
      ([cmd]) => cmd === "skill_usage_record",
    );
    expect(record?.[1]).toEqual({
      projectKey: "/p/app",
      invocations: ["a", "b"],
    });
  });

  it("keeps the remote prefix in the project key", async () => {
    route({
      skill_usage_backfill: () => 0,
      skill_usage_record: () => undefined,
    });
    await recordSkillUse("remote://box/home/me/app/", ["a"]);
    const record = call.mock.calls.find(
      ([cmd]) => cmd === "skill_usage_record",
    );
    expect(record?.[1]).toMatchObject({
      projectKey: "remote://box/home/me/app",
    });
  });

  it("does not call the backend when there is nothing to record", async () => {
    await recordSkillUse("/p", ["", "  "]);
    await recordSkillUse("", ["a"]);
    expect(call).not.toHaveBeenCalled();
  });

  it("awaits the backfill before the first record and queues early calls", async () => {
    let finishBackfill: (n: number) => void = () => undefined;
    route({
      skill_usage_backfill: () =>
        new Promise<number>((resolve) => {
          finishBackfill = resolve;
        }),
      skill_usage_record: () => undefined,
    });
    const first = recordSkillUse("/p", ["a"]);
    const second = recordSkillUse("/p", ["b"]);
    await flush();
    expect(names()).toEqual(["skill_usage_backfill"]);
    finishBackfill(3);
    await Promise.all([first, second]);
    expect(names().filter((n) => n === "skill_usage_backfill")).toHaveLength(1);
    const records = call.mock.calls
      .filter(([cmd]) => cmd === "skill_usage_record")
      .map(([, args]) => (args as { invocations: string[] }).invocations);
    expect(records).toEqual([["a"], ["b"]]);
    expect(names().indexOf("skill_usage_record")).toBeGreaterThan(
      names().indexOf("skill_usage_backfill"),
    );
  });

  it("swallows backfill, record and snapshot failures", async () => {
    call.mockRejectedValue(new Error("boom"));
    await expect(recordSkillUse("/p", ["a"])).resolves.toBeUndefined();
    expect(console.debug).toHaveBeenCalled();
  });

  it("still records when the backfill fails", async () => {
    route({
      skill_usage_backfill: () => {
        throw new Error("scan failed");
      },
      skill_usage_record: () => undefined,
    });
    await recordSkillUse("/p", ["a"]);
    expect(names()).toContain("skill_usage_record");
  });

  it("refreshes a loaded snapshot after recording", async () => {
    let count = 1;
    route({
      skill_usage_backfill: () => 0,
      skill_usage_record: () => {
        count += 1;
      },
      skill_usage_snapshot: () => ({
        usage: [{ invocation: "a", count, lastUsedAt: 9 }],
        pairs: [],
      }),
    });
    const listener = vi.fn();
    const off = subscribeSkillUsage("/p", listener);
    await flush();
    expect(getSkillUsage("/p")?.counts.get("a")?.count).toBe(1);
    await recordSkillUse("/p", ["a"]);
    expect(getSkillUsage("/p")?.counts.get("a")?.count).toBe(2);
    expect(listener).toHaveBeenCalled();
    off();
  });
});

describe("skill usage store", () => {
  it("loads the snapshot once per project key after the backfill", async () => {
    route({
      skill_usage_backfill: () => 0,
      skill_usage_snapshot: () => ({
        usage: [{ invocation: "a", count: 1, lastUsedAt: 1 }],
        pairs: [],
      }),
    });
    const off1 = subscribeSkillUsage("/p/", vi.fn());
    const off2 = subscribeSkillUsage("/p", vi.fn());
    await flush();
    expect(names()).toEqual(["skill_usage_backfill", "skill_usage_snapshot"]);
    expect(call.mock.calls[1]?.[1]).toEqual({ projectKey: "/p" });
    expect(getSkillUsage("/p/")).toBe(getSkillUsage("/p"));
    expect(getSkillUsage("/p")?.counts.has("a")).toBe(true);
    off1();
    off2();
  });

  it("leaves usage undefined when the snapshot fails", async () => {
    call.mockRejectedValue(new Error("no tauri"));
    const off = subscribeSkillUsage("/p", vi.fn());
    await flush();
    expect(getSkillUsage("/p")).toBeUndefined();
    off();
  });
});
