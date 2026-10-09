import { expect, it, vi } from "vitest";

// sysfs is POSIX on every host OS. With the Windows path module, `join` would
// produce backslashes and every lookup below would miss.
vi.mock("node:path", async (original) => {
  const real = await original<typeof import("node:path")>();
  return { ...real, join: real.win32.join, default: { ...real, join: real.win32.join } };
});

it("reads hwmon and thermal temperatures with POSIX paths on any host OS", async () => {
  const { readCpuTemperature } = await import("./metrics");
  const files: Record<string, string> = {
    "/sys/class/hwmon/hwmon1/name": "coretemp\n",
    "/sys/class/hwmon/hwmon1/temp1_input": "61400",
  };
  const dirs: Record<string, string[]> = {
    "/sys/class/hwmon": ["hwmon1"],
    "/sys/class/hwmon/hwmon1": ["name", "temp1_input"],
  };
  const reader = {
    readText: async (path: string) => files[path],
    listDir: async (path: string) => dirs[path] ?? [],
  };
  expect(await readCpuTemperature(reader)).toBe(61);
});
