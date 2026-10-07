import { memo, useEffect, useRef, useState } from "react";
import { Popover, type PopoverDismissReason } from "../../shared/ui/Popover";
import {
  hostMetricsUpdatedAt,
  useHostMetrics,
} from "../../features/connections/model/hostMetrics";
import {
  OPEN_CONNECTIONS_EVENT,
  reconnectRemoteMachine,
  useRemoteMachineState,
  useRemoteMachines,
} from "../../features/connections/model/connections";
import {
  formatAge,
  formatLatency,
  machineDotClass,
  metricsRows,
  metricsSummary,
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
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const online = state.kind === "online";
  // The store polls only while the machine is online and a view watches it.
  const load = useHostMetrics(machine?.id, { enabled: online, fast: open });
  if (!machine) return null;

  const label = machineStateLabel(state.kind);
  const latency = state.kind === "online" ? formatLatency(state.latencyMs) : undefined;
  const summary = online && load.status === "ready" ? metricsSummary(load.metrics) : [];
  const hasLoad = summary.length > 0;
  const needsAttention =
    state.kind === "offline" || state.kind === "error" || state.kind === "needsAuth";

  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1">
      <button
        type="button"
        className="inline-flex h-5 min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 text-[11px] text-content/55 hover:bg-content/10 hover:text-content"
        ref={trigger}
        aria-label={`Remote machine ${machine.name}: ${label}${latency ? `, ${latency}` : ""}${
          hasLoad ? `, ${summary.map((segment) => segment.text).join(", ")}` : ""
        }`}
        aria-haspopup={hasLoad ? "dialog" : undefined}
        aria-expanded={hasLoad ? open : undefined}
        title={machineStatusTitle(machine.name, state)}
        onClick={() =>
          hasLoad
            ? setOpen((value) => !value)
            : window.dispatchEvent(new Event(OPEN_CONNECTIONS_EVENT))
        }
      >
        <span
          data-machine-dot
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${machineDotClass(state.kind)}`}
        />
        <span className="max-w-28 truncate">{machine.name}</span>
        <span>{label}</span>
        {latency ? <span className="tabular-nums text-content/40">{latency}</span> : null}
        {hasLoad ? (
          <span
            data-host-load
            className={`flex items-center gap-1.5 tabular-nums max-md:hidden ${load.stale ? "opacity-50" : ""}`}
          >
            {summary.map((segment) => (
              <span key={segment.key} className={segment.hot ? "text-amber-400" : "text-content/55"}>
                {segment.text}
              </span>
            ))}
          </span>
        ) : null}
      </button>
      {open && hasLoad ? (
        <HostLoadPopover
          anchor={trigger}
          machineId={machine.id}
          name={machine.name}
          rows={metricsRows(load.metrics)}
          stale={load.stale}
          onDismiss={(reason) => {
            setOpen(false);
            if (reason === "escape") requestAnimationFrame(() => trigger.current?.focus());
          }}
          onOpenConnections={() => {
            setOpen(false);
            window.dispatchEvent(new Event(OPEN_CONNECTIONS_EVENT));
          }}
        />
      ) : null}
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

function HostLoadPopover({
  anchor,
  machineId,
  name,
  rows,
  stale,
  onDismiss,
  onOpenConnections,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  machineId: string;
  name: string;
  rows: ReturnType<typeof metricsRows>;
  stale: boolean;
  onDismiss: (reason: PopoverDismissReason) => void;
  onOpenConnections: () => void;
}) {
  // Readings that do not change the view still refresh the age.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const updatedAt = hostMetricsUpdatedAt(machineId);
  return (
    <Popover
      anchor={anchor}
      side="top"
      align="end"
      gap={7}
      width={320}
      autoFocus
      onDismiss={onDismiss}
      role="dialog"
      aria-label={`${name} load`}
      tabIndex={-1}
      className="p-2.5 text-[11px] text-content"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="truncate font-medium">{name}</span>
        <span className={`shrink-0 text-content/45 ${stale ? "text-amber-400" : ""}`}>
          {stale ? "Out of date" : updatedAt ? `Updated ${formatAge(updatedAt, now)}` : ""}
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <li key={row.key} className="flex flex-col gap-0.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-content/55">{row.label}</span>
              <span className={`shrink-0 tabular-nums ${row.hot ? "text-amber-400" : ""}`}>
                {row.value}
              </span>
            </div>
            {row.percent !== undefined ? (
              <div
                className="h-1 overflow-hidden rounded-full bg-content/10"
                role="progressbar"
                aria-label={row.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={row.percent}
              >
                <div
                  className={`h-full rounded-full ${row.hot ? "bg-amber-400" : "bg-emerald-400"}`}
                  style={{ width: `${row.percent}%` }}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="mt-2 inline-flex h-5 items-center rounded px-1.5 text-accent hover:bg-content/10"
        onClick={onOpenConnections}
      >
        Connection settings
      </button>
    </Popover>
  );
}
