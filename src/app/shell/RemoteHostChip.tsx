import { memo } from "react";
import {
  OPEN_CONNECTIONS_EVENT,
  reconnectRemoteMachine,
  useRemoteMachineState,
  useRemoteMachines,
} from "../../features/connections/model/connections";
import {
  formatLatency,
  machineDotClass,
  machineStateLabel,
  machineStatusTitle,
} from "../../features/connections/model/machineDisplay";
import { remoteProjectFor } from "../../features/connections/model/remoteProjects";

/** The footer's view of the SSH machine behind a remote project. It only reads
 * the shared poller, so it adds no probes of its own. */
export const RemoteHostChip = memo(function RemoteHostChip({
  project,
}: {
  project: string;
}) {
  const remote = remoteProjectFor(project);
  const { machines } = useRemoteMachines(!!remote);
  const machine = remote
    ? machines.find((entry) => entry.environmentId === remote.environmentId)
    : undefined;
  const state = useRemoteMachineState(machine?.id);
  if (!machine) return null;

  const label = machineStateLabel(state.kind);
  const latency = state.kind === "online" ? formatLatency(state.latencyMs) : undefined;
  const needsAttention =
    state.kind === "offline" || state.kind === "error" || state.kind === "needsAuth";

  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1">
      <button
        type="button"
        className="inline-flex h-5 min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 text-[11px] text-content/55 hover:bg-content/10 hover:text-content"
        aria-label={`Remote machine ${machine.name}: ${label}${latency ? `, ${latency}` : ""}`}
        title={machineStatusTitle(machine.name, state)}
        onClick={() => window.dispatchEvent(new Event(OPEN_CONNECTIONS_EVENT))}
      >
        <span
          data-machine-dot
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${machineDotClass(state.kind)}`}
        />
        <span className="max-w-28 truncate">{machine.name}</span>
        <span>{label}</span>
        {latency ? <span className="tabular-nums text-content/40">{latency}</span> : null}
      </button>
      {needsAttention ? (
        <button
          type="button"
          className="inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded px-1.5 text-[11px] text-accent hover:bg-content/10"
          aria-label={`Reconnect ${machine.name}`}
          title={`Reconnect ${machine.name}`}
          onClick={(event) => {
            event.stopPropagation();
            void reconnectRemoteMachine(machine.id);
          }}
        >
          Reconnect
        </button>
      ) : null}
    </span>
  );
});
