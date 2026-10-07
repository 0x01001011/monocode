import { describe, expect, it, vi } from "vitest";
import {
  MetricsSampler,
  cpuPercent,
  parseMeminfo,
  parseNvidiaSmi,
  parseVmStat,
  readCpuTemperature,
  type MetricsSources,
} from "./metrics";

const MIB = 1024 * 1024;

function sources(overrides: Partial<MetricsSources> = {}): MetricsSources & {
  clock: { now: number };
} {
  const clock = { now: 1_000_000 };
  let tick = 0;
  return {
    clock,
    platform: "linux",
    cores: () => 8,
    // Each read advances 100 jiffies of which 25 are idle: 75% busy.
    cpuTimes: () => ({ idle: 25 * ++tick, total: 100 * tick }),
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    readText: async () => undefined,
    listDir: async () => [],
    memory: async () => ({ usedBytes: 4, totalBytes: 8 }),
    disk: async () => ({ path: "/home/k", usedBytes: 1, totalBytes: 4 }),
    nvidiaSmi: async () => undefined,
    ...overrides,
  };
}

describe("parsers", () => {
  it("reads used memory from MemAvailable", () => {
    const text = "MemTotal:       16000000 kB\nMemFree:  1000000 kB\nMemAvailable:    6000000 kB\n";
    expect(parseMeminfo(text)).toEqual({
      usedBytes: 10_000_000 * 1024,
      totalBytes: 16_000_000 * 1024,
    });
    expect(parseMeminfo("nonsense")).toBeUndefined();
  });

  it("treats reclaimable macOS pages as available", () => {
    const text = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               100.",
      "Pages inactive:                           50.",
      "Pages speculative:                        25.",
      "Pages purgeable:                          25.",
    ].join("\n");
    expect(parseVmStat(text, 16384 * 1000)).toEqual({
      usedBytes: 16384 * 800,
      totalBytes: 16384 * 1000,
    });
    expect(parseVmStat("", 1)).toBeUndefined();
  });

  it("computes CPU percent from two samples and rejects a non-advancing clock", () => {
    expect(cpuPercent({ idle: 10, total: 100 }, { idle: 35, total: 200 })).toBe(75);
    expect(cpuPercent({ idle: 10, total: 100 }, { idle: 10, total: 100 })).toBeUndefined();
  });

  it("parses nvidia-smi rows, including N/A and commas in names", () => {
    const csv = [
      "NVIDIA GeForce RTX 4090, 71, 12000, 24564, 64",
      "NVIDIA A100, SXM4 80GB, 5, 100, 81920, [N/A]",
      "garbage",
      "",
    ].join("\n");
    expect(parseNvidiaSmi(csv)).toEqual([
      {
        name: "NVIDIA GeForce RTX 4090",
        percent: 71,
        memoryUsedBytes: 12000 * MIB,
        memoryTotalBytes: 24564 * MIB,
        temperatureC: 64,
      },
      {
        name: "NVIDIA A100, SXM4 80GB",
        percent: 5,
        memoryUsedBytes: 100 * MIB,
        memoryTotalBytes: 81920 * MIB,
        temperatureC: undefined,
      },
    ]);
  });
});

describe("readCpuTemperature", () => {
  const tree = (files: Record<string, string>, dirs: Record<string, string[]>) => ({
    readText: async (path: string) => files[path],
    listDir: async (path: string) => dirs[path] ?? [],
  });

  it("takes the hottest CPU hwmon sensor and ignores other devices", async () => {
    const reader = tree(
      {
        "/sys/class/hwmon/hwmon0/name": "nvme\n",
        "/sys/class/hwmon/hwmon0/temp1_input": "70000",
        "/sys/class/hwmon/hwmon1/name": "coretemp\n",
        "/sys/class/hwmon/hwmon1/temp1_input": "55000",
        "/sys/class/hwmon/hwmon1/temp2_input": "61400",
      },
      {
        "/sys/class/hwmon": ["hwmon0", "hwmon1"],
        "/sys/class/hwmon/hwmon0": ["name", "temp1_input"],
        "/sys/class/hwmon/hwmon1": ["name", "temp1_input", "temp2_input"],
      },
    );
    expect(await readCpuTemperature(reader)).toBe(61);
  });

  it("falls back to thermal zones and drops absurd readings", async () => {
    const reader = tree(
      {
        "/sys/class/thermal/thermal_zone0/type": "x86_pkg_temp\n",
        "/sys/class/thermal/thermal_zone0/temp": "48000",
        "/sys/class/thermal/thermal_zone1/type": "x86_pkg_temp\n",
        "/sys/class/thermal/thermal_zone1/temp": "999999999",
      },
      { "/sys/class/thermal": ["thermal_zone0", "thermal_zone1", "cooling_device0"] },
    );
    expect(await readCpuTemperature(reader)).toBe(48);
    expect(await readCpuTemperature(tree({}, {}))).toBeUndefined();
  });
});

describe("MetricsSampler", () => {
  it("measures CPU over a short window on the first read", async () => {
    const s = sources();
    const metrics = await new MetricsSampler(s).read();
    expect(metrics.cpu).toEqual({ percent: 75, cores: 8 });
    expect(metrics.memory).toEqual({ usedBytes: 4, totalBytes: 8 });
    expect(metrics.disk?.path).toBe("/home/k");
    expect(metrics.gpus).toBeUndefined();
    expect(metrics.temperatureC).toBeUndefined();
  });

  it("combines CPU and GPU temperatures and lists every GPU", async () => {
    const s = sources({
      readText: async (path) =>
        ({
          "/sys/class/hwmon/hwmon0/name": "k10temp",
          "/sys/class/hwmon/hwmon0/temp1_input": "52000",
        })[path],
      listDir: async (path) =>
        path === "/sys/class/hwmon"
          ? ["hwmon0"]
          : path === "/sys/class/hwmon/hwmon0"
            ? ["name", "temp1_input"]
            : [],
      nvidiaSmi: async () => "A, 10, 1, 2, 60\nB, 90, 1, 2, 71\n",
    });
    const metrics = await new MetricsSampler(s).read();
    expect(metrics.temperatureC).toEqual({ cpu: 52, gpu: 71 });
    expect(metrics.gpus?.map((gpu) => gpu.name)).toEqual(["A", "B"]);
  });

  it("reuses a reading for 5 s and shares one collection between callers", async () => {
    const nvidiaSmi = vi.fn(async () => "A, 1, 1, 2, 50\n");
    const s = sources({ nvidiaSmi });
    const sampler = new MetricsSampler(s);
    const [a, b] = await Promise.all([sampler.read(), sampler.read()]);
    expect(b).toBe(a);
    s.clock.now += 4_000;
    expect(await sampler.read()).toBe(a);
    expect(nvidiaSmi).toHaveBeenCalledTimes(1);
    s.clock.now += 1_500;
    const fresh = await sampler.read();
    expect(fresh).not.toBe(a);
    expect(nvidiaSmi).toHaveBeenCalledTimes(2);
  });

  it("keeps the other metrics when one source fails", async () => {
    const s = sources({
      memory: async () => {
        throw new Error("no /proc");
      },
      nvidiaSmi: async () => {
        throw new Error("driver");
      },
    });
    const metrics = await new MetricsSampler(s).read();
    expect(metrics.memory).toBeUndefined();
    expect(metrics.gpus).toBeUndefined();
    expect(metrics.cpu?.percent).toBe(75);
  });

  it("skips Linux sensors on other platforms", async () => {
    const readText = vi.fn(async () => "coretemp");
    const s = sources({ platform: "darwin", readText });
    expect((await new MetricsSampler(s).read()).temperatureC).toBeUndefined();
    expect(readText).not.toHaveBeenCalled();
  });
});
