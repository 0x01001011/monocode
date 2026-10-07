# Remote host metrics in the footer

Show CPU, GPU, memory, temperature and disk of the SSH machine behind the active remote project in the footer chip.

## Decisions
- Layout: the chip gains a compact summary (`CPU 34% · GPU 71% · MEM 62%`); a popover shows every metric.
- Transport: a new host method `host.metrics`, polled separately from the 15 s connection probe. `environment.describe` is unchanged.
- Every metric is optional. A missing value means the machine cannot report it.
- Out of scope: history, alerts, AMD/Apple GPUs, per-process data, macOS/Windows temperature.

## Host (`host/metrics.ts`)
- Snapshot: `cpu {percent, cores}`, `memory {usedBytes, totalBytes}`, `disk {path, usedBytes, totalBytes}`, `temperatureC {cpu?, gpu?}`, `gpus[] {name, percent, memoryUsedBytes, memoryTotalBytes, temperatureC}`, `sampledAt`.
- Linux: `/proc/stat` delta, `/proc/meminfo` `MemAvailable`, `fs.statfs`, `hwmon`/`thermal_zone` temperatures, one `nvidia-smi --query-gpu` call (2 s timeout, omitted when absent).
- macOS/Windows: CPU, memory and disk from `os` and `statfs`.
- One shared sampler: one collection in flight, readings reused for 5 s, so any number of callers spawns `nvidia-smi` at most once per 5 s. Read-only; no shell, no caller-supplied arguments.
- Protocol: method `host.metrics`, capability `host.metrics`. Not required by `needsUpdate`; older hosts just show no metrics.

## Desktop
- `hostMetrics.ts`: store keyed by machine id, read with `useSyncExternalStore`. Polls every 10 s (3 s while the popover is open) only while the machine is online and a view watches; pauses while the window is hidden, refreshes on focus; one request in flight.
- Values are rounded (whole percent, 1 °C) and CPU is smoothed over 3 samples; the store does not notify on equal values.
- A failed request keeps the last reading, marked stale after 30 s. Three failures in a row stop polling. "Unsupported host method" marks the machine unsupported for the session.
- `RemoteHostChip` shows the summary (busiest GPU; amber at 90%+; dim when stale) and a popover with per-metric bars, per-GPU rows, disk path, and "updated Ns ago". `formatHostMetrics` in `machineDisplay.ts` is pure and unit tested.

## Verification
Host parser fixtures, cache and single-flight tests, server capability test; desktop store and chip tests (no watcher, no polling; pause/resume; equal values do not notify; stale; failure stop; older host); `host:deploy` to KGPU and compare with `nvidia-smi`/`free`.
