import { useCallback, useSyncExternalStore } from "react";
import {
  getMachineState,
  remoteRequest,
  watchMachineState,
  type MachineState,
} from "./connections";
import type { HostMetrics } from "./protocol";

/** How often a watched, online machine is asked for its load. */
const POLL_MS = 10_000;
/** The popover is being read, so it refreshes faster. */
const FAST_POLL_MS = 3_000;
/** A reading older than this is shown as stale. */
const STALE_MS = 30_000;
/** Consecutive failures after which polling stops until the machine reconnects. */
const MAX_FAILURES = 3;
const CPU_SAMPLES = 3;
/** Byte counts are rounded to this, so they do not change on every reading. */
const BYTE_STEP = 64 * 1024 * 1024;

export type HostMetricsView = {
  /** `unsupported`: the host predates `host.metrics`, so nothing is shown. */
  status: "idle" | "ready" | "unsupported";
  metrics?: HostMetrics;
  stale: boolean;
};

const IDLE: HostMetricsView = { status: "idle", stale: false };
const UNSUPPORTED: HostMetricsView = { status: "unsupported", stale: false };

type Entry = {
  view: HostMetricsView;
  updatedAt?: number;
  watchers: number;
  fast: number;
  failures: number;
  unsupported: boolean;
  cpu: number[];
  timer?: ReturnType<typeof setTimeout>;
  staleTimer?: ReturnType<typeof setTimeout>;
  inflight: boolean;
  online: boolean;
  stopState?: () => void;
  listeners: Set<() => void>;
};

const entries = new Map<string, Entry>();
let activeWatchers = 0;

const quantize = (bytes: number) => Math.round(bytes / BYTE_STEP) * BYTE_STEP;
const quantizeBytes = (bytes: number | undefined) =>
  bytes === undefined ? undefined : quantize(bytes);

/** Rounds a reading and smooths CPU, so a steady machine yields equal values. */
export function stabilizeMetrics(raw: HostMetrics, cpuHistory: number[]): HostMetrics {
  const metrics: HostMetrics = { sampledAt: raw.sampledAt };
  if (raw.cpu) {
    const average =
      cpuHistory.reduce((sum, value) => sum + value, 0) / (cpuHistory.length || 1);
    metrics.cpu = {
      percent: Math.round(cpuHistory.length ? average : raw.cpu.percent),
      cores: raw.cpu.cores,
    };
  }
  if (raw.memory)
    metrics.memory = {
      usedBytes: quantize(raw.memory.usedBytes),
      totalBytes: quantize(raw.memory.totalBytes),
    };
  if (raw.disk)
    metrics.disk = {
      path: raw.disk.path,
      usedBytes: quantize(raw.disk.usedBytes),
      totalBytes: quantize(raw.disk.totalBytes),
    };
  if (raw.temperatureC)
    metrics.temperatureC = {
      ...(raw.temperatureC.cpu !== undefined
        ? { cpu: Math.round(raw.temperatureC.cpu) }
        : {}),
      ...(raw.temperatureC.gpu !== undefined
        ? { gpu: Math.round(raw.temperatureC.gpu) }
        : {}),
    };
  if (raw.gpus?.length)
    metrics.gpus = raw.gpus.map((gpu) => ({
      name: gpu.name,
      percent: gpu.percent,
      memoryUsedBytes: quantizeBytes(gpu.memoryUsedBytes),
      memoryTotalBytes: quantizeBytes(gpu.memoryTotalBytes),
      temperatureC: gpu.temperatureC,
    }));
  return metrics;
}

/** Whether two readings show the same thing; the timestamp is not shown. */
const sameReading = (a: HostMetrics | undefined, b: HostMetrics | undefined) =>
  JSON.stringify({ ...a, sampledAt: 0 }) === JSON.stringify({ ...b, sampledAt: 0 });

function entryFor(machineId: string): Entry {
  let entry = entries.get(machineId);
  if (!entry) {
    entry = {
      view: IDLE,
      watchers: 0,
      fast: 0,
      failures: 0,
      unsupported: false,
      cpu: [],
      inflight: false,
      online: false,
      listeners: new Set(),
    };
    entries.set(machineId, entry);
  }
  return entry;
}

export function getHostMetrics(machineId: string): HostMetricsView {
  return entries.get(machineId)?.view ?? IDLE;
}

/** When the latest reading arrived; the view itself only changes with its values. */
export function hostMetricsUpdatedAt(machineId: string): number | undefined {
  return entries.get(machineId)?.updatedAt;
}

/** How many views are watching a machine's metrics right now. */
export function hostMetricsWatcherCount(machineId: string): number {
  return entries.get(machineId)?.watchers ?? 0;
}

function publish(entry: Entry, view: HostMetricsView) {
  const prev = entry.view;
  if (
    prev.status === view.status &&
    prev.stale === view.stale &&
    sameReading(prev.metrics, view.metrics)
  )
    return;
  entry.view = view;
  for (const listener of [...entry.listeners]) {
    try {
      listener();
    } catch {
      /* one broken view must not stop the others */
    }
  }
}

function armStale(entry: Entry) {
  clearTimeout(entry.staleTimer);
  entry.staleTimer = setTimeout(() => {
    entry.staleTimer = undefined;
    if (entry.view.status === "ready") publish(entry, { ...entry.view, stale: true });
  }, STALE_MS);
}

const documentVisible = () =>
  typeof document === "undefined" || document.visibilityState !== "hidden";

const shouldPoll = (entry: Entry) =>
  entry.watchers > 0 &&
  entry.online &&
  !entry.unsupported &&
  entry.failures < MAX_FAILURES &&
  documentVisible();

function schedule(machineId: string, entry: Entry, delay: number) {
  clearTimeout(entry.timer);
  entry.timer = undefined;
  if (!shouldPoll(entry)) return;
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    void poll(machineId, entry);
  }, delay);
}

const intervalFor = (entry: Entry) => (entry.fast > 0 ? FAST_POLL_MS : POLL_MS);

async function poll(machineId: string, entry: Entry) {
  if (entry.inflight || !shouldPoll(entry)) return;
  entry.inflight = true;
  try {
    const raw = await remoteRequest<HostMetrics>(machineId, "host.metrics");
    if (entries.get(machineId) !== entry) return;
    if (typeof raw?.sampledAt !== "number") throw new Error("Invalid host metrics");
    entry.failures = 0;
    entry.updatedAt = Date.now();
    if (raw.cpu) entry.cpu = [...entry.cpu, raw.cpu.percent].slice(-CPU_SAMPLES);
    else entry.cpu = [];
    publish(entry, {
      status: "ready",
      metrics: stabilizeMetrics(raw, entry.cpu),
      stale: false,
    });
    armStale(entry);
  } catch (reason) {
    if (entries.get(machineId) !== entry) return;
    const message = reason instanceof Error ? reason.message : String(reason);
    if (/Unsupported host method/i.test(message)) {
      entry.unsupported = true;
      clearTimeout(entry.staleTimer);
      publish(entry, UNSUPPORTED);
    } else entry.failures++;
  } finally {
    entry.inflight = false;
    if (entries.get(machineId) === entry) schedule(machineId, entry, intervalFor(entry));
  }
}

function onMachineState(machineId: string, entry: Entry, state: MachineState) {
  const online = state.kind === "online";
  if (online === entry.online) return;
  entry.online = online;
  if (online) {
    // A reconnect may follow a host update or a fixed fault.
    entry.failures = 0;
    entry.unsupported = false;
    if (entry.view.status === "unsupported") publish(entry, IDLE);
    void poll(machineId, entry);
  } else {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
}

/** Keeps a machine's metrics polled while anyone watches. `fast` is for a view
 * the user is reading right now. Polls only while the machine is online and the
 * window is visible. Returns the unsubscribe. */
export function watchHostMetrics(
  machineId: string,
  listener: () => void,
  { fast = false }: { fast?: boolean } = {},
): () => void {
  const entry = entryFor(machineId);
  entry.listeners.add(listener);
  entry.watchers++;
  if (fast) entry.fast++;
  if (entry.watchers === 1) {
    entry.online = getMachineState(machineId).kind === "online";
    entry.stopState = watchMachineState(machineId, (state) =>
      onMachineState(machineId, entry, state),
    );
    document.addEventListener?.("visibilitychange", visibilityHandler);
    activeWatchers++;
    if (entry.online) void poll(machineId, entry);
  } else if (fast) schedule(machineId, entry, 0);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    entry.listeners.delete(listener);
    if (fast) entry.fast--;
    if (--entry.watchers > 0) return;
    clearTimeout(entry.timer);
    clearTimeout(entry.staleTimer);
    entry.timer = entry.staleTimer = undefined;
    entry.stopState?.();
    entry.stopState = undefined;
    if (--activeWatchers === 0)
      document.removeEventListener?.("visibilitychange", visibilityHandler);
  };
}

/** Pauses polling while the window is hidden and refreshes when it returns. */
function visibilityHandler() {
  for (const [machineId, entry] of entries) {
    if (entry.watchers === 0) continue;
    if (documentVisible()) void poll(machineId, entry);
    else {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }
}

/** A machine's load, polled while this view is mounted. */
export function useHostMetrics(
  machineId: string | undefined,
  options: { enabled?: boolean; fast?: boolean } = {},
): HostMetricsView {
  const { enabled = true, fast = false } = options;
  const active = enabled && !!machineId;
  const subscribe = useCallback(
    (notify: () => void) =>
      active ? watchHostMetrics(machineId!, notify, { fast }) : () => undefined,
    [active, machineId, fast],
  );
  const snapshot = () => (active ? getHostMetrics(machineId!) : IDLE);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
