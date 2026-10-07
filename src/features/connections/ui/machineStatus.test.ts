import { expect, it } from "vitest";
import type { MachineState } from "../model/connections";
import type { RemoteMachine } from "../model/protocol";
import {
  describeMachineProblem,
  diagnosticsText,
  isWebUrl,
  machineStatusText,
  needsAttention,
} from "./machineStatus";

const machine: RemoteMachine = {
  id: "m",
  name: "Home Mac",
  environmentId: "env",
  endpoint: "ssh://me@home",
  ssh: { target: "me@home", port: 2222, remotePort: 3774 },
};

it.each([
  ["https://login.tailscale.com/a/1", true],
  ["http://localhost:8080/x", true],
  [" HTTPS://example.test", true],
  ["javascript:alert(1)", false],
  ["file:///etc/passwd", false],
  ["ftp://example.test", false],
  ["example.test/a", false],
  ["", false],
  [undefined, false],
])("treats %j as a web link: %s", (value, expected) => {
  expect(isWebUrl(value)).toBe(expected);
});

it.each([
  ["unknown", false],
  ["connecting", false],
  ["online", false],
  ["offline", true],
  ["error", true],
  ["needsAuth", true],
] as const)("flags the %s state as needing attention: %s", (kind, expected) => {
  expect(needsAttention({ kind })).toBe(expected);
});

it("words the status from the shared state", () => {
  expect(machineStatusText({ kind: "unknown" })).toBe("Checking connection…");
  expect(machineStatusText({ kind: "connecting" })).toBe("Connecting…");
  expect(machineStatusText({ kind: "online" })).toBe("Connected");
  expect(machineStatusText({ kind: "offline" })).toBe(
    "Offline · reconnect to check access",
  );
  expect(machineStatusText({ kind: "needsAuth", reason: "Approval needed" })).toBe(
    "Needs sign-in · Approval needed",
  );
  expect(machineStatusText({ kind: "error", reason: "Host key changed" })).toBe(
    "Error · Host key changed",
  );
});

it("adds what the host's own description found to a connected machine", () => {
  const online: MachineState = { kind: "online" };
  expect(machineStatusText(online, { noProvider: true })).toContain(
    "install a supported provider",
  );
  expect(
    machineStatusText(online, { noProvider: true, needsUpdate: true }),
  ).toContain("host update needed for Explorer and Changes");
  expect(machineStatusText(online, { identityChanged: true })).toContain(
    "host identity changed",
  );
});

it("maps the error kind of a state, with fallbacks for unclassified ones", () => {
  expect(
    describeMachineProblem({ kind: "offline", errorKind: "dns" }).title,
  ).toBe("Host name not found");
  expect(describeMachineProblem({ kind: "needsAuth" }).title).toBe(
    "Approval needed",
  );
  const lost = describeMachineProblem({
    kind: "offline",
    reason: "No network connection",
  });
  expect(lost.title).toBe("No network connection");
  expect(lost.hint).toContain("Reconnect");
});

it("writes diagnostics without credentials", () => {
  const text = diagnosticsText(machine, {
    kind: "offline",
    reason: "Machine is unreachable",
    errorKind: "timeout",
    lastOkAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    lastErrorAt: Date.UTC(2026, 0, 2, 3, 5, 5),
  });
  expect(text).toContain("Machine: Home Mac");
  expect(text).toContain("Address: me@home");
  expect(text).toContain("Port: 2222");
  expect(text).toContain("State: offline");
  expect(text).toContain("Last successful contact: 2026-01-02T03:04:05.000Z");
  expect(text).toContain("Last error: timeout at 2026-01-02T03:05:05.000Z");
  expect(text).toContain("Message: Machine is unreachable");
});
