import { execFile } from "node:child_process";
import { readFile, readdir, statfs } from "node:fs/promises";
import { cpus, freemem, homedir, totalmem } from "node:os";
import { posix } from "node:path";
import { promisify } from "node:util";
import type {
  HostGpuMetrics,
  HostMetrics,
} from "../src/features/connections/model/protocol";

/** Linux sysfs paths are POSIX; do not let Windows separators leak into them. */
const join = posix.join;

const run = promisify(execFile);

/** Readings are reused for this long, so any number of desktops costs one
 * collection (and at most one `nvidia-smi`) per window. */
const CACHE_MS = 5_000;
/** A CPU delta older than this is a long average, so it is re-measured. */
const CPU_WINDOW_MAX_MS = 30_000;
const CPU_WINDOW_MS = 250;
const NVIDIA_TIMEOUT_MS = 2_000;
/** After `nvidia-smi` is found missing, it is not tried again for this long. */
const NVIDIA_RETRY_MS = 5 * 60_000;
const MIB = 1024 * 1024;

export type CpuTimes = { idle: number; total: number };

export type MetricsSources = {
  cpuTimes(): CpuTimes;
  cores(): number;
  now(): number;
  sleep(ms: number): Promise<void>;
  readText(path: string): Promise<string | undefined>;
  listDir(path: string): Promise<string[]>;
  memory(): Promise<{ usedBytes: number; totalBytes: number } | undefined>;
  disk(): Promise<{ path: string; usedBytes: number; totalBytes: number } | undefined>;
  nvidiaSmi(): Promise<string | undefined>;
  platform: NodeJS.Platform;
};

export function parseMeminfo(text: string) {
  const kib = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return match ? Number(match[1]) * 1024 : undefined;
  };
  const totalBytes = kib("MemTotal");
  const available = kib("MemAvailable") ?? kib("MemFree");
  if (!totalBytes || available === undefined) return undefined;
  return { usedBytes: Math.max(0, totalBytes - available), totalBytes };
}

/** Parses `vm_stat`; reclaimable pages count as available. */
export function parseVmStat(text: string, totalBytes: number) {
  const size = /page size of (\d+) bytes/.exec(text)?.[1];
  if (!size) return undefined;
  const pages = (label: string) => {
    const match = new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(text);
    return match ? Number(match[1]) : 0;
  };
  const available =
    (pages("Pages free") +
      pages("Pages inactive") +
      pages("Pages speculative") +
      pages("Pages purgeable")) *
    Number(size);
  return { usedBytes: Math.max(0, totalBytes - available), totalBytes };
}

const percent = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export function cpuPercent(prev: CpuTimes, next: CpuTimes): number | undefined {
  const total = next.total - prev.total;
  const idle = next.idle - prev.idle;
  if (total <= 0 || idle < 0) return undefined;
  return percent(((total - idle) / total) * 100);
}

/** `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,
 * temperature.gpu --format=csv,noheader,nounits`, one GPU per line. */
export function parseNvidiaSmi(csv: string): HostGpuMetrics[] {
  const number = (value: string | undefined) => {
    const parsed = Number(value);
    return value === undefined || value.trim() === "" || !Number.isFinite(parsed)
      ? undefined
      : parsed;
  };
  const gpus: HostGpuMetrics[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const cells = line.split(",").map((cell) => cell.trim());
    if (cells.length < 5) continue;
    // A name may itself contain commas; the four numbers are always last.
    const [util, used, total, temp] = cells.slice(-4).map(number);
    const name = cells.slice(0, -4).join(", ");
    if (!name) continue;
    gpus.push({
      name,
      percent: util === undefined ? undefined : percent(util),
      memoryUsedBytes: used === undefined ? undefined : Math.round(used * MIB),
      memoryTotalBytes: total === undefined ? undefined : Math.round(total * MIB),
      temperatureC: temp === undefined ? undefined : Math.round(temp),
    });
  }
  return gpus;
}

const CPU_SENSORS = new Set([
  "coretemp",
  "k10temp",
  "zenpower",
  "cpu_thermal",
  "cpu-thermal",
  "x86_pkg_temp",
]);

const celsius = (raw: string | undefined) => {
  const value = Number(raw);
  // Linux reports millidegrees; anything outside a sane range is a bad sensor.
  const degrees = value / 1000;
  return Number.isFinite(value) && degrees > 0 && degrees < 150
    ? Math.round(degrees)
    : undefined;
};

/** The hottest CPU sensor, from hwmon and then thermal zones. */
export async function readCpuTemperature(
  sources: Pick<MetricsSources, "readText" | "listDir">,
): Promise<number | undefined> {
  const readings: number[] = [];
  for (const dir of await sources.listDir("/sys/class/hwmon")) {
    const base = join("/sys/class/hwmon", dir);
    const name = (await sources.readText(join(base, "name")))?.trim();
    if (!name || !CPU_SENSORS.has(name)) continue;
    for (const file of await sources.listDir(base)) {
      if (!/^temp\d+_input$/.test(file)) continue;
      const value = celsius(await sources.readText(join(base, file)));
      if (value !== undefined) readings.push(value);
    }
  }
  if (readings.length === 0) {
    for (const dir of await sources.listDir("/sys/class/thermal")) {
      if (!dir.startsWith("thermal_zone")) continue;
      const base = join("/sys/class/thermal", dir);
      const type = (await sources.readText(join(base, "type")))?.trim();
      if (!type || !CPU_SENSORS.has(type)) continue;
      const value = celsius(await sources.readText(join(base, "temp")));
      if (value !== undefined) readings.push(value);
    }
  }
  return readings.length ? Math.max(...readings) : undefined;
}

function osCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus()) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

const readText = (path: string) =>
  readFile(path, "utf8").catch(() => undefined);
const listDir = (path: string) => readdir(path).catch(() => [] as string[]);

export function systemSources(): MetricsSources {
  let nvidiaMissingUntil = 0;
  return {
    platform: process.platform,
    cpuTimes: osCpuTimes,
    cores: () => cpus().length,
    now: Date.now,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    readText,
    listDir,
    async memory() {
      if (process.platform === "linux") {
        const text = await readText("/proc/meminfo");
        const parsed = text ? parseMeminfo(text) : undefined;
        if (parsed) return parsed;
      } else if (process.platform === "darwin") {
        const out = await run("vm_stat", [], { timeout: 2_000 }).catch(() => undefined);
        const parsed = out ? parseVmStat(out.stdout, totalmem()) : undefined;
        if (parsed) return parsed;
      }
      const totalBytes = totalmem();
      return totalBytes > 0
        ? { usedBytes: Math.max(0, totalBytes - freemem()), totalBytes }
        : undefined;
    },
    async disk() {
      const path = homedir();
      const stats = await statfs(path).catch(() => undefined);
      if (!stats || stats.blocks <= 0) return undefined;
      const totalBytes = stats.blocks * stats.bsize;
      const usedBytes = (stats.blocks - stats.bfree) * stats.bsize;
      return { path, usedBytes, totalBytes };
    },
    async nvidiaSmi() {
      if (Date.now() < nvidiaMissingUntil) return undefined;
      try {
        const { stdout } = await run(
          "nvidia-smi",
          [
            "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
            "--format=csv,noheader,nounits",
          ],
          { timeout: NVIDIA_TIMEOUT_MS, maxBuffer: 64 * 1024 },
        );
        return stdout;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          nvidiaMissingUntil = Date.now() + NVIDIA_RETRY_MS;
        return undefined;
      }
    },
  };
}

/** Reads host load. Every field is optional: absent means this machine cannot
 * report it. Reads are shared and cached, and never throw. */
export class MetricsSampler {
  private cached: HostMetrics | undefined;
  private inflight: Promise<HostMetrics> | undefined;
  private lastCpu: { times: CpuTimes; at: number } | undefined;

  constructor(private readonly sources: MetricsSources = systemSources()) {}

  read(): Promise<HostMetrics> {
    const { sources } = this;
    if (this.cached && sources.now() - this.cached.sampledAt < CACHE_MS)
      return Promise.resolve(this.cached);
    this.inflight ??= this.collect().then(
      (metrics) => {
        this.cached = metrics;
        this.inflight = undefined;
        return metrics;
      },
      (error) => {
        this.inflight = undefined;
        throw error;
      },
    );
    return this.inflight;
  }

  private async cpu(): Promise<HostMetrics["cpu"]> {
    const { sources } = this;
    const cores = sources.cores();
    const now = sources.now();
    let prev = this.lastCpu;
    if (!prev || now - prev.at > CPU_WINDOW_MAX_MS) {
      prev = { times: sources.cpuTimes(), at: now };
      await sources.sleep(CPU_WINDOW_MS);
    }
    const times = sources.cpuTimes();
    this.lastCpu = { times, at: sources.now() };
    const value = cpuPercent(prev.times, times);
    return value === undefined ? undefined : { percent: value, cores };
  }

  private async collect(): Promise<HostMetrics> {
    const { sources } = this;
    const guard = <T>(work: Promise<T>) => work.catch(() => undefined);
    const [cpu, memory, disk, cpuTemperature, smi] = await Promise.all([
      guard(this.cpu()),
      guard(sources.memory()),
      guard(sources.disk()),
      sources.platform === "linux"
        ? guard(readCpuTemperature(sources))
        : Promise.resolve(undefined),
      guard(sources.nvidiaSmi()),
    ]);
    const gpus = smi ? parseNvidiaSmi(smi) : [];
    const gpuTemperature = Math.max(
      ...gpus.map((gpu) => gpu.temperatureC ?? -Infinity),
    );
    const metrics: HostMetrics = { sampledAt: sources.now() };
    if (cpu) metrics.cpu = cpu;
    if (memory) metrics.memory = memory;
    if (disk) metrics.disk = disk;
    if (gpus.length) metrics.gpus = gpus;
    if (cpuTemperature !== undefined || Number.isFinite(gpuTemperature))
      metrics.temperatureC = {
        ...(cpuTemperature !== undefined ? { cpu: cpuTemperature } : {}),
        ...(Number.isFinite(gpuTemperature) ? { gpu: gpuTemperature } : {}),
      };
    return metrics;
  }
}
