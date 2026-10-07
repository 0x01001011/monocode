// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  calls: 0,
  answer: undefined as undefined | (() => Promise<unknown>),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { method?: string }) => {
    if (command !== "remote_request") return undefined;
    if (args?.method === "host.metrics") {
      harness.calls++;
      return harness.answer!();
    }
    return {};
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: async () => () => undefined }),
}));

import { stabilizeMetrics } from "./hostMetrics";

const MB = 1024 ** 2;
let stops: (() => void)[] = [];
let sequence = 0;
const flush = () => vi.advanceTimersByTimeAsync(0);
const visibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  vi.useFakeTimers();
  harness.calls = 0;
  harness.answer = async () => ({ sampledAt: 1, cpu: { percent: 10, cores: 2 } });
});
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  visibility("visible");
  vi.useRealTimers();
});

describe("stabilizeMetrics", () => {
  it("rounds bytes to 64 MB steps and averages recent CPU readings", () => {
    const metrics = stabilizeMetrics(
      {
        sampledAt: 5,
        cpu: { percent: 40, cores: 4 },
        memory: { usedBytes: 1000 * MB + 10, totalBytes: 4096 * MB },
      },
      [10, 20, 40],
    );
    expect(metrics.cpu).toEqual({ percent: 23, cores: 4 });
    expect(metrics.memory?.usedBytes).toBe(1024 * MB);
    expect(metrics.memory?.totalBytes).toBe(4096 * MB);
  });

  it("makes two readings of a steady machine equal", () => {
    const a = stabilizeMetrics(
      { sampledAt: 1, memory: { usedBytes: 1000 * MB, totalBytes: 4096 * MB } },
      [],
    );
    const b = stabilizeMetrics(
      { sampledAt: 2, memory: { usedBytes: 1010 * MB, totalBytes: 4096 * MB } },
      [],
    );
    expect({ ...a, sampledAt: 0 }).toEqual({ ...b, sampledAt: 0 });
  });
});

describe("watchHostMetrics", () => {
  const load = async () => {
    vi.resetModules();
    const connections = await import("./connections");
    const metrics = await import("./hostMetrics");
    const id = `machine-${++sequence}`;
    // Mark the machine online without waiting for a probe.
    connections.reportRemoteMachineStatus(id, true);
    return { metrics, id };
  };

  it("pauses while the window is hidden and refreshes when it returns", async () => {
    const { metrics, id } = await load();
    stops.push(metrics.watchHostMetrics(id, () => undefined));
    await flush();
    expect(harness.calls).toBe(1);
    visibility("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.calls).toBe(1);
    visibility("visible");
    await flush();
    expect(harness.calls).toBe(2);
  });

  it("does not notify when a new reading shows the same values", async () => {
    const { metrics, id } = await load();
    const listener = vi.fn();
    stops.push(metrics.watchHostMetrics(id, listener));
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.calls).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(metrics.getHostMetrics(id).metrics?.cpu?.percent).toBe(10);
  });

  it("rejects an answer that is not a reading", async () => {
    const { metrics, id } = await load();
    harness.answer = async () => ({});
    stops.push(metrics.watchHostMetrics(id, () => undefined));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(metrics.getHostMetrics(id).status).toBe("idle");
    expect(harness.calls).toBe(3);
  });
});
