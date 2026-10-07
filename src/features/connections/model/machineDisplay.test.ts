import { describe, expect, it } from "vitest";
import {
  formatAge,
  formatBytes,
  formatLatency,
  machineDotClass,
  machineStateLabel,
  machineStatusTitle,
  metricsRows,
  metricsSummary,
} from "./machineDisplay";
import type { MachineState } from "./connections";

const kinds: MachineState["kind"][] = [
  "unknown",
  "connecting",
  "online",
  "offline",
  "error",
  "needsAuth",
];

describe("machineDotClass", () => {
  it.each([
    ["online", "bg-emerald-400"],
    ["needsAuth", "bg-amber-400"],
    ["error", "bg-red-400"],
    ["offline", "bg-content/35"],
    ["connecting", "bg-content/35"],
    ["unknown", "bg-content/35"],
  ] as const)("colours %s as %s", (kind, expected) => {
    expect(machineDotClass(kind)).toBe(expected);
  });
});

describe("machineStateLabel", () => {
  it.each([
    ["unknown", "Connecting"],
    ["connecting", "Connecting"],
    ["online", "Connected"],
    ["offline", "Offline"],
    ["needsAuth", "Needs sign-in"],
    ["error", "Error"],
  ] as const)("names %s %s", (kind, label) => {
    expect(machineStateLabel(kind)).toBe(label);
  });

  it("gives every state a short label", () => {
    for (const kind of kinds) expect(machineStateLabel(kind).length).toBeLessThan(16);
  });
});

describe("formatLatency", () => {
  it("renders whole milliseconds", () => {
    expect(formatLatency(42)).toBe("42 ms");
    expect(formatLatency(1_230)).toBe("1230 ms");
  });

  it("renders nothing without a measurement", () => {
    expect(formatLatency(undefined)).toBeUndefined();
    expect(formatLatency(Number.NaN)).toBeUndefined();
    expect(formatLatency(-10)).toBeUndefined();
  });
});

describe("machineStatusTitle", () => {
  const time = (at: number) =>
    new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  it("says when the machine last answered", () => {
    const title = machineStatusTitle("devbox", { kind: "online", lastOkAt: 1_700_000_000_000 });
    expect(title).toContain("devbox: Connected");
    expect(title).toContain(`Last contact ${time(1_700_000_000_000)}`);
  });

  it("explains a failure with its reason", () => {
    const title = machineStatusTitle("devbox", {
      kind: "offline",
      reason: "Machine is unreachable",
      lastOkAt: 1_700_000_000_000,
    });
    expect(title).toContain("devbox: Offline");
    expect(title).toContain("Machine is unreachable");
    expect(title).toContain("Last contact");
  });

  it("falls back to the label when a failing state has no reason", () => {
    expect(machineStatusTitle("devbox", { kind: "needsAuth" })).toContain("devbox: Needs sign-in");
  });

  it("admits the machine has not answered yet", () => {
    expect(machineStatusTitle("devbox", { kind: "connecting" })).toContain("No contact yet");
  });

  it("includes the latency only while online", () => {
    expect(machineStatusTitle("devbox", { kind: "online", latencyMs: 40 })).toContain("40 ms");
    expect(machineStatusTitle("devbox", { kind: "offline", latencyMs: 40 })).not.toContain("40 ms");
  });
});

describe("host metrics display", () => {
  const GB = 1024 ** 3;
  it("formats bytes in MB, GB and TB", () => {
    expect(formatBytes(512 * 1024 ** 2)).toBe("512 MB");
    expect(formatBytes(11.24 * GB)).toBe("11.2 GB");
    expect(formatBytes(2 * 1024 ** 4)).toBe("2.0 TB");
    expect(formatBytes(Number.NaN)).toBe("—");
  });

  it("summarises CPU, the busiest GPU and memory, flagging 90% and above", () => {
    const segments = metricsSummary({
      sampledAt: 0,
      cpu: { percent: 91, cores: 4 },
      memory: { usedBytes: 5 * GB, totalBytes: 10 * GB },
      gpus: [{ name: "a", percent: 10 }, { name: "b", percent: 40 }],
    });
    expect(segments).toEqual([
      { key: "cpu", text: "CPU 91%", hot: true },
      { key: "gpu", text: "GPU 40%", hot: false },
      { key: "mem", text: "MEM 50%", hot: false },
    ]);
    expect(metricsSummary(undefined)).toEqual([]);
    expect(metricsSummary({ sampledAt: 0 })).toEqual([]);
  });

  it("lists one row per reported metric, with a bar where there is a ratio", () => {
    const rows = metricsRows({
      sampledAt: 0,
      cpu: { percent: 5, cores: 2 },
      temperatureC: { cpu: 40 },
      disk: { path: "/", usedBytes: 95 * GB, totalBytes: 100 * GB },
    });
    expect(rows.map((row) => row.key)).toEqual(["cpu", "cpu-temp", "disk"]);
    expect(rows[1].percent).toBeUndefined();
    expect(rows[2]).toMatchObject({ percent: 95, hot: true });
    expect(rows[2].value).toContain("5.0 GB free");
  });

  it("words the age of a reading", () => {
    expect(formatAge(1000, 2000)).toBe("just now");
    expect(formatAge(0, 12_000)).toBe("12 s ago");
    expect(formatAge(0, 180_000)).toBe("3 min ago");
  });
});
