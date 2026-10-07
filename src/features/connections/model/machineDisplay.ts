import type { MachineState } from "./connections";

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
