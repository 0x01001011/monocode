import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

const { remoteConnectionLabel } = await import("./ProjectRail");

it.each([
  ["unknown", "Connecting"],
  ["connecting", "Connecting"],
  ["online", "Connected"],
  ["offline", "Offline"],
  ["needsAuth", "Needs sign-in"],
  ["error", "Error"],
] as const)("labels the %s machine state %s", (kind, label) => {
  expect(remoteConnectionLabel({ kind })).toBe(label);
});

it("says so when the project's machine is not connected on this computer", () => {
  expect(remoteConnectionLabel({ kind: "online" }, false)).toBe(
    "Machine not connected on this computer",
  );
});
