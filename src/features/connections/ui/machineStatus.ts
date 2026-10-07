import type { MachineState } from "../model/connections";
import type { RemoteMachine } from "../model/protocol";
import { describeRemoteError, type RemoteErrorInfo } from "../model/remoteErrors";

/** What the capability check learned from the host's own description. */
export type HostCapabilities = {
  identityChanged?: boolean;
  needsUpdate?: boolean;
  noProvider?: boolean;
};

/** Only web addresses are ever opened, whatever a host or VPN prints. */
export function isWebUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

/** Whether the machine is in a state the user has to act on or wait out. */
export function needsAttention(state: MachineState): boolean {
  return (
    state.kind === "offline" ||
    state.kind === "error" ||
    state.kind === "needsAuth"
  );
}

/** The mapped title and hint for a failing machine's state. */
export function describeMachineProblem(state: MachineState): RemoteErrorInfo {
  if (state.errorKind) return describeRemoteError(`[ssh:${state.errorKind}]`);
  const fallback = describeRemoteError(
    state.kind === "needsAuth" ? "[ssh:needs-interactive-auth]" : "",
  );
  // A state with no classified cause, such as a lost network or a failed poll.
  return state.kind === "offline"
    ? {
        ...fallback,
        title: state.reason ?? "Machine is offline",
        hint: "MonoCode keeps retrying. Check your network and VPN, or press Reconnect to try now.",
      }
    : fallback;
}

/** One line of status for a machine, from the shared connection state. */
export function machineStatusText(
  state: MachineState,
  host: HostCapabilities = {},
): string {
  switch (state.kind) {
    case "unknown":
      return "Checking connection…";
    case "connecting":
      return "Connecting…";
    case "online":
      if (host.identityChanged)
        return "Error · host identity changed, reconnect to verify";
      if (host.needsUpdate)
        return "Connected · host update needed for Explorer and Changes";
      if (host.noProvider)
        return "Connected · install a supported provider on the host";
      return "Connected";
    case "offline":
      return `Offline · ${state.reason ?? "reconnect to check access"}`;
    case "needsAuth":
      return `Needs sign-in${state.reason ? ` · ${state.reason}` : ""}`;
    case "error":
      return `Error${state.reason ? ` · ${state.reason}` : ""}`;
  }
}

const when = (time?: number) =>
  time === undefined ? "never" : new Date(time).toISOString();

/** Plain text for a bug report. It holds no credentials or sign-in links. */
export function diagnosticsText(
  machine: RemoteMachine,
  state: MachineState,
): string {
  return [
    `Machine: ${machine.name}`,
    `Address: ${machine.ssh ? machine.ssh.target : machine.endpoint}`,
    ...(machine.ssh?.port ? [`Port: ${machine.ssh.port}`] : []),
    `State: ${state.kind}`,
    `Last successful contact: ${when(state.lastOkAt)}`,
    `Last error: ${state.errorKind ?? "none"}${
      state.lastErrorAt === undefined ? "" : ` at ${when(state.lastErrorAt)}`
    }`,
    `Message: ${state.reason ?? "none"}`,
  ].join("\n");
}
