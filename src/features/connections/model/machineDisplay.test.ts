import { describe, expect, it } from "vitest";
import {
  formatLatency,
  machineDotClass,
  machineStateLabel,
  machineStatusTitle,
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
