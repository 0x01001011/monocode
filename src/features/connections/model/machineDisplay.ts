import type { MachineState } from "./connections";
import type { HostGpuMetrics, HostMetrics } from "./protocol";

type Kind = MachineState["kind"];

/** The status dot colour for a machine; the rail card and the footer chip share it. */
export function machineDotClass(kind: Kind): string {
  switch (kind) {
    case "online":
      return "bg-emerald-400";
    case "needsAuth":
      return "bg-amber-400";
    case "error":
      return "bg-red-400";
    default:
      return "bg-content/35";
  }
}

/** A short name for a machine's state. */
export function machineStateLabel(kind: Kind): string {
  switch (kind) {
    case "online":
      return "Connected";
    case "offline":
      return "Offline";
    case "needsAuth":
      return "Needs sign-in";
    case "error":
      return "Error";
    default:
      return "Connecting";
  }
}

/** A probe's round trip, such as `42 ms`; nothing without a measurement. */
export function formatLatency(latencyMs: number | undefined): string | undefined {
  return latencyMs !== undefined && Number.isFinite(latencyMs) && latencyMs >= 0
    ? `${Math.round(latencyMs)} ms`
    : undefined;
}

/** The longer description a machine's chip shows on hover. */
export function machineStatusTitle(name: string, state: MachineState): string {
  const label = machineStateLabel(state.kind);
  const failing =
    state.kind === "offline" || state.kind === "error" || state.kind === "needsAuth";
  const lines = [`${name}: ${label}`];
  if (failing) lines.push(state.reason ?? label);
  const latency = state.kind === "online" ? formatLatency(state.latencyMs) : undefined;
  if (latency) lines.push(`Round trip ${latency}`);
  lines.push(
    state.lastOkAt === undefined
      ? "No contact yet"
      : `Last contact ${new Date(state.lastOkAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}`,
  );
  return lines.join("\n");
}

/** A reading at or above this percentage is shown as running hot. */
export const HOT_PERCENT = 90;

const GB = 1024 ** 3;

/** Bytes as `512 MB`, `11.2 GB` or `1.5 TB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes >= 1000 * GB) return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Whole percent of `total` that `used` makes up; undefined without a total. */
export function usedPercent(used: number, total: number): number | undefined {
  if (!(total > 0) || !Number.isFinite(used)) return undefined;
  return Math.max(0, Math.min(100, Math.round((used / total) * 100)));
}

const gpuMemoryPercent = (gpu: HostGpuMetrics) =>
  gpu.memoryUsedBytes !== undefined && gpu.memoryTotalBytes !== undefined
    ? usedPercent(gpu.memoryUsedBytes, gpu.memoryTotalBytes)
    : undefined;

export type MetricSegment = { key: "cpu" | "gpu" | "mem"; text: string; hot: boolean };

/** The footer's one-line summary: CPU, the busiest GPU, and memory. A metric
 * the machine does not report is left out. */
export function metricsSummary(metrics: HostMetrics | undefined): MetricSegment[] {
  if (!metrics) return [];
  const segments: MetricSegment[] = [];
  if (metrics.cpu)
    segments.push({
      key: "cpu",
      text: `CPU ${metrics.cpu.percent}%`,
      hot: metrics.cpu.percent >= HOT_PERCENT,
    });
  const busiest = Math.max(
    ...(metrics.gpus ?? []).map((gpu) => gpu.percent ?? -1),
  );
  if (busiest >= 0)
    segments.push({ key: "gpu", text: `GPU ${busiest}%`, hot: busiest >= HOT_PERCENT });
  if (metrics.memory) {
    const percent = usedPercent(metrics.memory.usedBytes, metrics.memory.totalBytes);
    if (percent !== undefined)
      segments.push({ key: "mem", text: `MEM ${percent}%`, hot: percent >= HOT_PERCENT });
  }
  return segments;
}

export type MetricRow = {
  key: string;
  label: string;
  value: string;
  /** Fill of the row's bar; absent for rows without a ratio. */
  percent?: number;
  hot: boolean;
};

/** Every metric the machine reports, one row each, for the popover. */
export function metricsRows(metrics: HostMetrics | undefined): MetricRow[] {
  if (!metrics) return [];
  const rows: MetricRow[] = [];
  const { cpu, memory, disk, temperatureC, gpus } = metrics;
  if (cpu)
    rows.push({
      key: "cpu",
      label: "CPU",
      value: `${cpu.percent}% · ${cpu.cores} cores`,
      percent: cpu.percent,
      hot: cpu.percent >= HOT_PERCENT,
    });
  if (temperatureC?.cpu !== undefined)
    rows.push({
      key: "cpu-temp",
      label: "CPU temp",
      value: `${temperatureC.cpu}°C`,
      hot: false,
    });
  if (memory) {
    const percent = usedPercent(memory.usedBytes, memory.totalBytes);
    rows.push({
      key: "mem",
      label: "Memory",
      value: `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`,
      percent,
      hot: (percent ?? 0) >= HOT_PERCENT,
    });
  }
  (gpus ?? []).forEach((gpu, index) => {
    const parts = [
      gpu.percent !== undefined ? `${gpu.percent}%` : undefined,
      gpu.memoryUsedBytes !== undefined && gpu.memoryTotalBytes !== undefined
        ? `${formatBytes(gpu.memoryUsedBytes)} / ${formatBytes(gpu.memoryTotalBytes)}`
        : undefined,
      gpu.temperatureC !== undefined ? `${gpu.temperatureC}°C` : undefined,
    ].filter(Boolean);
    rows.push({
      key: `gpu-${index}`,
      label: gpu.name,
      value: parts.join(" · ") || "—",
      percent: gpu.percent,
      hot: (gpu.percent ?? 0) >= HOT_PERCENT || (gpuMemoryPercent(gpu) ?? 0) >= HOT_PERCENT,
    });
  });
  if (disk) {
    const percent = usedPercent(disk.usedBytes, disk.totalBytes);
    rows.push({
      key: "disk",
      label: "Disk",
      value: `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)} · ${formatBytes(
        Math.max(0, disk.totalBytes - disk.usedBytes),
      )} free`,
      percent,
      hot: (percent ?? 0) >= HOT_PERCENT,
    });
  }
  return rows;
}

/** `just now`, `12 s ago` or `3 min ago` for a reading taken at `at`. */
export function formatAge(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  return `${Math.round(seconds / 60)} min ago`;
}
