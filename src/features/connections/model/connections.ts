import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  applySessionSync,
  type HostCommand,
  type HostSession,
  type HostSessionSummary,
  type RemoteErrorKind,
  type RemoteMachine,
  type SessionSync,
  type SessionSyncChunk,
  type SessionSyncResponse,
} from "./protocol";
import { describeRemoteError } from "./remoteErrors";
import { remoteProjectFor } from "./remoteProjects";
import { withRemoteAttachmentPreviews } from "./remoteAttachmentPreviews";

const CHANGE = "monocode:remote-machines";
export const REMOTE_HISTORY_CHANGE = "monocode:remote-history";
export const REMOTE_HISTORY_UPDATED = "monocode:remote-history-updated";
export const refreshRemoteProjectSessions = () =>
  window.dispatchEvent(new Event(REMOTE_HISTORY_CHANGE));
let cachedMachines: RemoteMachine[] = [];
let machinesLoaded = false;
export const OPEN_CONNECTIONS_EVENT = "monocode:open-connections";
export const OPEN_REMOTE_PROJECT_EVENT = "monocode:open-remote-project";
export const refreshRemoteMachines = () =>
  window.dispatchEvent(new Event(CHANGE));
const TAB_KEY = "monocode.remote-tabs.v2";
const WORKTREE_KEY = "monocode.remote-pending-worktrees.v1";

export function remotePendingWorktree(shellId: string): string | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(WORKTREE_KEY) ?? "{}")[
      shellId
    ];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The host checkout currently used by a remote tab. */
export function remoteTabCwd(project: string, shellId?: string): string | undefined {
  if (!shellId) return undefined;
  const sessionId = remoteSessionFor(shellId);
  return (
    (sessionId ? cachedRemoteSessionSummary(project, sessionId)?.cwd : undefined) ??
    remotePendingWorktree(shellId)
  );
}

export function rememberRemotePendingWorktree(shellId: string, path?: string) {
  try {
    const all = JSON.parse(localStorage.getItem(WORKTREE_KEY) ?? "{}");
    if (path) all[shellId] = path;
    else delete all[shellId];
    localStorage.setItem(WORKTREE_KEY, JSON.stringify(all));
  } catch {
    /* selection is restored from the host once a session exists */
  }
}

/** The host session a tab in a remote project shows; none for a new session. */
export function remoteSessionFor(shellId: string): string | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(TAB_KEY) ?? "{}")[shellId];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}
export function rememberRemoteSession(shellId: string, sessionId?: string) {
  try {
    const all = JSON.parse(localStorage.getItem(TAB_KEY) ?? "{}");
    if (sessionId) all[shellId] = sessionId;
    else delete all[shellId];
    localStorage.setItem(TAB_KEY, JSON.stringify(all));
  } catch {
    /* tab selection is best effort */
  }
  window.dispatchEvent(new Event(REMOTE_HISTORY_CHANGE));
}

const pendingPrefix = (project: string, environment: string) =>
  `monocode.remote-command.v1:${JSON.stringify([project, environment])}:`;

type PendingEntry = { command: HostCommand; shellId?: string; followup?: HostCommand };
const readPendingEntry = (value: string): PendingEntry => {
  const parsed = JSON.parse(value) as PendingEntry | HostCommand;
  return "command" in parsed ? parsed : { command: parsed };
};

export const pendingRemoteFollowup = (project: string, environment: string, id: string) => {
  const value = localStorage.getItem(`${pendingPrefix(project, environment)}${id}`);
  return value ? readPendingEntry(value).followup : undefined;
};

export const pendingRemoteCommand = (
  project: string,
  environment: string,
  sessionId?: string | null,
  shellId?: string,
): HostCommand | undefined => {
  const prefix = pendingPrefix(project, environment);
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) {
      const value = localStorage.getItem(key);
      if (value) {
        const entry = readPendingEntry(value);
        const command = entry.command;
        if (
          sessionId === undefined ||
          (sessionId === null
            ? command.type === "create" && (!entry.shellId || entry.shellId === shellId)
            : command.type !== "create" && command.sessionId === sessionId)
        )
          return command;
      }
    }
  }
};

// Each command owns its storage entry: a late receipt from another pane can
// never erase this pane's uncertain request. Persistence must succeed before
// dispatch; unlike preferences, silently dropping an outbox entry is unsafe.
export const savePendingRemoteCommand = (
  project: string,
  environment: string,
  command: HostCommand,
  shellId?: string,
  followup?: HostCommand,
) => {
  try {
    localStorage.setItem(
      `${pendingPrefix(project, environment)}${command.commandId}`,
      JSON.stringify({ command, shellId,
        followup: followup ?? pendingRemoteFollowup(project, environment, command.commandId),
      } satisfies PendingEntry),
    );
  } catch {
    throw new Error(
      "Cannot save your request locally. Free up app storage before sending.",
    );
  }
};
export const clearPendingRemoteCommand = (
  project: string,
  environment: string,
  commandId: string,
) =>
  localStorage.removeItem(`${pendingPrefix(project, environment)}${commandId}`);

export function remoteRequest<T>(
  machineId: string,
  method: string,
  params: unknown = {},
): Promise<T> {
  return invoke<T>("remote_request", { machineId, method, params });
}

/** Reads one sync, assembling it from bounded pieces when the host chunks it. */
async function syncRemoteSession(
  machineId: string,
  sessionId: string,
  revision?: number,
): Promise<SessionSync> {
  const response = await remoteRequest<SessionSyncResponse>(
    machineId,
    "sessions.sync",
    { sessionId, revision },
  );
  if (response.kind !== "chunked") return response;
  const pieces: string[] = [];
  let offset = 0;
  while (offset < response.length) {
    const { data } = await remoteRequest<SessionSyncChunk>(
      machineId,
      "sessions.syncChunk",
      { sessionId, transfer: response.transfer, offset },
    );
    if (!data) throw new Error("Session transfer ended early");
    pieces.push(data);
    offset += data.length;
  }
  if (offset !== response.length)
    throw new Error("Session transfer has an unexpected length");
  return JSON.parse(pieces.join("")) as SessionSync;
}

/** Fetches only what changed since `known`; falls back to a full snapshot. */
export async function loadRemoteSession(
  machineId: string,
  sessionId: string,
  known?: HostSession,
): Promise<HostSession> {
  const sync = (revision?: number) =>
    syncRemoteSession(machineId, sessionId, revision);
  const update = await sync(known?.revision);
  let snapshot: HostSession;
  try {
    snapshot = applySessionSync(known, update);
  } catch {
    snapshot = applySessionSync(undefined, await sync());
  }
  return withRemoteAttachmentPreviews(machineId, snapshot, known,
    (params) => remoteRequest(machineId, "attachments.read", params));
}

/** The connected machine for an environment, from the last machine list read. */
export function knownRemoteMachine(
  environmentId: string,
): RemoteMachine | undefined {
  return cachedMachines.find((entry) => entry.environmentId === environmentId);
}

/** The connected machine for an environment, reading the list when needed. */
export async function remoteMachineFor(
  environmentId: string,
): Promise<RemoteMachine | undefined> {
  const known = knownRemoteMachine(environmentId);
  if (known || machinesLoaded) return known;
  const value = await invoke<RemoteMachine[]>("remote_machines");
  cachedMachines = Array.isArray(value) ? value : [];
  machinesLoaded = true;
  probeNewMachines(cachedMachines);
  return knownRemoteMachine(environmentId);
}

export async function connectMachine(
  name: string,
  url: string,
  token: string,
): Promise<RemoteMachine> {
  const machine = await invoke<RemoteMachine>("remote_connect", {
    name,
    url,
    token,
  });
  cachedMachines = [
    ...cachedMachines.filter((entry) => entry.id !== machine.id),
    machine,
  ];
  machinesLoaded = true;
  probeNewMachines([machine]);
  window.dispatchEvent(new Event(CHANGE));
  return machine;
}

export async function disconnectMachine(machineId: string): Promise<void> {
  await invoke("remote_disconnect", { machineId });
  cachedMachines = cachedMachines.filter((entry) => entry.id !== machineId);
  forgetMachine(machineId);
  window.dispatchEvent(new Event(CHANGE));
}

export function useRemoteMachines(enabled = true): {
  machines: RemoteMachine[];
  loaded: boolean;
} {
  const [state, setState] = useState<{
    machines: RemoteMachine[];
    loaded: boolean;
  }>({ machines: cachedMachines, loaded: machinesLoaded });
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const refresh = () => {
      void invoke<RemoteMachine[]>("remote_machines")
        .then((value) => {
          if (!disposed) {
            cachedMachines = Array.isArray(value) ? value : [];
            machinesLoaded = true;
            probeNewMachines(cachedMachines);
            setState({
              machines: cachedMachines,
              loaded: true,
            });
          }
        })
        .catch(() => {
          // A temporary connection failure should not blank every remote
          // panel while a fresh machine list is requested.
          if (!disposed) setState({ machines: cachedMachines, loaded: true });
        });
    };
    refresh();
    window.addEventListener(CHANGE, refresh);
    return () => {
      disposed = true;
      window.removeEventListener(CHANGE, refresh);
    };
  }, [enabled]);
  return state;
}

/** Connection state of one remote machine, shared by every view that shows it. */
export type MachineState = {
  kind: "unknown" | "connecting" | "online" | "offline" | "error" | "needsAuth";
  reason?: string;
  errorKind?: RemoteErrorKind;
  lastOkAt?: number;
  lastErrorAt?: number;
  /** Round trip of the latest successful probe, to the nearest 10 ms; only
   * set while online, and absent when the answer came back in under 5 ms. */
  latencyMs?: number;
};

const UNKNOWN_STATE: MachineState = { kind: "unknown" };
const LATENCY_BUCKET_MS = 10;

/** Buckets a round trip so jitter inside one bucket is not a state change. */
function bucketLatency(elapsedMs: number): number | undefined {
  const bucketed =
    Math.round(elapsedMs / LATENCY_BUCKET_MS) * LATENCY_BUCKET_MS;
  return Number.isFinite(bucketed) && bucketed > 0 ? bucketed : undefined;
}
const POLL_MS = 15_000;
const TRIGGER_DEBOUNCE_MS = 500;
/** When no machine has answered for longer than this, the app was asleep or
 * away, so a focus must also drop the cached tunnels. */
const WAKE_STALE_MS = 120_000;
const NO_NETWORK = "No network connection";
const backoffMs = (failures: number) => Math.min(30_000, 3_000 * 2 ** failures);

type Poller = {
  state: MachineState;
  /** Views and sidebars currently showing this machine; polling needs one. */
  watchers: number;
  failures: number;
  timer?: ReturnType<typeof setTimeout>;
  /** The one probe allowed in flight for this machine. */
  inflight?: Promise<void>;
  /** A network change arrived mid-probe, so its answer may be stale. */
  rerun: boolean;
  listeners: Set<(state: MachineState) => void>;
};

const pollers = new Map<string, Poller>();
let networkDown = false;
let burstTimer: ReturnType<typeof setTimeout> | undefined;
let activeWatchers = 0;
let removeTriggers: (() => void) | undefined;

function pollerFor(machineId: string): Poller {
  let poller = pollers.get(machineId);
  if (!poller) {
    poller = {
      state: UNKNOWN_STATE,
      watchers: 0,
      failures: 0,
      rerun: false,
      listeners: new Set(),
    };
    pollers.set(machineId, poller);
  }
  return poller;
}

/** The latest known connection state; `unknown` before the first probe. */
export function getMachineState(machineId: string): MachineState {
  return pollers.get(machineId)?.state ?? UNKNOWN_STATE;
}

/** How many views are watching a machine right now. */
export function machineWatcherCount(machineId: string): number {
  return pollers.get(machineId)?.watchers ?? 0;
}

function setMachineState(poller: Poller, next: MachineState) {
  const prev = poller.state;
  if (
    prev.kind === next.kind &&
    prev.reason === next.reason &&
    prev.errorKind === next.errorKind &&
    prev.lastOkAt === next.lastOkAt &&
    prev.lastErrorAt === next.lastErrorAt &&
    prev.latencyMs === next.latencyMs
  )
    return;
  poller.state = next;
  for (const listener of [...poller.listeners]) {
    try {
      listener(next);
    } catch {
      /* one broken view must not stop the others from updating */
    }
  }
}

const markConnecting = (poller: Poller) =>
  setMachineState(poller, {
    kind: "connecting",
    lastOkAt: poller.state.lastOkAt,
    lastErrorAt: poller.state.lastErrorAt,
  });

function schedulePoll(machineId: string, poller: Poller, delay: number) {
  clearTimeout(poller.timer);
  poller.timer = setTimeout(() => {
    poller.timer = undefined;
    void probeMachine(machineId, false);
  }, delay);
}

function settleProbe(
  machineId: string,
  poller: Poller,
  startedAt: number,
  failure?: { reason: unknown },
) {
  poller.inflight = undefined;
  // A forgotten machine, or an answer that predates an offline event.
  if (pollers.get(machineId) !== poller || networkDown) {
    poller.rerun = false;
    return;
  }
  const now = Date.now();
  let delay: number | undefined;
  if (failure === undefined) {
    poller.failures = 0;
    setMachineState(poller, {
      kind: "online",
      lastOkAt: now,
      lastErrorAt: poller.state.lastErrorAt,
      latencyMs: bucketLatency(performance.now() - startedAt),
    });
    delay = POLL_MS;
  } else {
    const { kind, title } = describeRemoteError(failure.reason);
    const next = {
      reason: title,
      errorKind: kind,
      lastOkAt: poller.state.lastOkAt,
      lastErrorAt: now,
    };
    if (kind === "needs-interactive-auth" || kind === "permission-denied") {
      // Waiting for the user; retrying would only repeat the prompt.
      setMachineState(poller, { kind: "needsAuth", ...next });
    } else if (kind === "host-key-changed" || kind === "ssh-missing") {
      // Retrying cannot fix these.
      setMachineState(poller, { kind: "error", ...next });
    } else {
      poller.failures = Math.min(4, poller.failures + 1);
      setMachineState(poller, { kind: "offline", ...next });
      delay = backoffMs(poller.failures);
    }
  }
  if (poller.rerun) {
    poller.rerun = false;
    void probeMachine(machineId, true);
  } else if (delay !== undefined && poller.watchers > 0) {
    schedulePoll(machineId, poller, delay);
  }
}

/** Asks the machine to describe itself; never runs two probes at once. */
function probeMachine(machineId: string, show: boolean): Promise<void> {
  const poller = pollerFor(machineId);
  if (poller.inflight) return poller.inflight;
  clearTimeout(poller.timer);
  poller.timer = undefined;
  if (show || poller.state.kind === "unknown") markConnecting(poller);
  let request: Promise<unknown>;
  const startedAt = performance.now();
  try {
    request = Promise.resolve(remoteRequest(machineId, "environment.describe"));
  } catch (reason) {
    request = Promise.reject(reason);
  }
  // A rejection may carry any value, so it travels wrapped.
  poller.inflight = request.then(
    () => settleProbe(machineId, poller, startedAt),
    (reason) => settleProbe(machineId, poller, startedAt, { reason }),
  );
  return poller.inflight;
}

async function notifyNetworkChanged() {
  try {
    await invoke("remote_network_changed");
  } catch {
    /* older builds lack the command; probing still works */
  }
}

const probeTargets = () =>
  new Set([
    ...cachedMachines.map((machine) => machine.id),
    ...[...pollers].filter(([, p]) => p.watchers > 0).map(([id]) => id),
  ]);

/** Resets backoff and probes at once. `invalidate` also drops cached SSH
 * tunnels, which tears down healthy ones, so only pass it when the network
 * really changed or the machine may have been asleep. */
async function refreshMachines(ids: Iterable<string>, invalidate: boolean) {
  const probing: string[] = [];
  for (const id of ids) {
    const poller = pollerFor(id);
    poller.failures = 0;
    clearTimeout(poller.timer);
    poller.timer = undefined;
    if (poller.inflight) poller.rerun ||= invalidate;
    else {
      markConnecting(poller);
      probing.push(id);
    }
  }
  // Cached tunnels must be dropped before the probe, or it reuses a dead one.
  if (invalidate) await notifyNetworkChanged();
  for (const id of probing) void probeMachine(id, true);
}

/** Retries one machine now, for the Reconnect button. */
export async function reconnectRemoteMachine(
  machineId: string,
): Promise<MachineState> {
  networkDown = false;
  const poller = pollerFor(machineId);
  poller.failures = 0;
  await refreshMachines([machineId], true);
  await poller.inflight;
  return getMachineState(machineId);
}

function onTrigger(networkChanged: boolean) {
  if (networkChanged) networkDown = false;
  else if (typeof navigator === "undefined" || navigator.onLine !== false)
    networkDown = false;
  // Leading edge: the first of a burst probes at once, the rest are dropped.
  if (burstTimer !== undefined) return;
  burstTimer = setTimeout(() => {
    burstTimer = undefined;
  }, TRIGGER_DEBOUNCE_MS);
  const ids = [...probeTargets()];
  const now = Date.now();
  // The command drops every cached tunnel, so one machine that is down for
  // days must not cost the healthy ones theirs: only when no machine has
  // answered recently is the whole app presumed asleep or away.
  const lastContact = Math.max(
    ...ids.map((id) => pollers.get(id)?.state.lastOkAt ?? -Infinity),
  );
  const stale = now - lastContact > WAKE_STALE_MS;
  void refreshMachines(ids, networkChanged || stale);
}

function onOffline() {
  networkDown = true;
  // The network coming back must not be swallowed by an earlier burst.
  clearTimeout(burstTimer);
  burstTimer = undefined;
  for (const id of probeTargets()) {
    const poller = pollerFor(id);
    clearTimeout(poller.timer);
    poller.timer = undefined;
    poller.rerun = false;
    setMachineState(poller, {
      kind: "offline",
      reason: NO_NETWORK,
      lastOkAt: poller.state.lastOkAt,
      lastErrorAt: Date.now(),
    });
  }
}

function installTriggers(): () => void {
  const online = () => onTrigger(true);
  const focus = () => onTrigger(false);
  const visible = () => {
    if (document.visibilityState === "visible") onTrigger(false);
  };
  window.addEventListener("online", online);
  window.addEventListener("offline", onOffline);
  window.addEventListener("focus", focus);
  document.addEventListener("visibilitychange", visible);
  let removed = false;
  let unlisten: (() => void) | undefined;
  try {
    void getCurrentWindow()
      .onFocusChanged(({ payload }) => {
        if (payload) onTrigger(false);
      })
      .then((fn) => (removed ? fn() : (unlisten = fn)))
      .catch(() => undefined);
  } catch {
    /* not running inside the desktop shell */
  }
  return () => {
    removed = true;
    window.removeEventListener("online", online);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("focus", focus);
    document.removeEventListener("visibilitychange", visible);
    unlisten?.();
    clearTimeout(burstTimer);
    burstTimer = undefined;
  };
}

/** Subscribes to a machine's state and keeps it polled while anyone listens.
 * All watchers of a machine share one poller. Returns the unsubscribe. */
export function watchMachineState(
  machineId: string,
  listener: (state: MachineState) => void,
): () => void {
  const poller = pollerFor(machineId);
  poller.listeners.add(listener);
  poller.watchers++;
  if (activeWatchers++ === 0) removeTriggers = installTriggers();
  if (poller.watchers === 1) {
    if (networkDown) onOffline();
    else
      void probeMachine(
        machineId,
        poller.state.kind !== "online" && poller.state.kind !== "offline",
      );
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    poller.listeners.delete(listener);
    if (--poller.watchers === 0) {
      clearTimeout(poller.timer);
      poller.timer = undefined;
    }
    if (--activeWatchers === 0) {
      removeTriggers?.();
      removeTriggers = undefined;
    }
  };
}

/** Probes machines that have not been checked yet, so status is ready
 * before any view asks for it. */
function probeNewMachines(machines: RemoteMachine[]) {
  if (networkDown) return;
  for (const { id } of machines) {
    const poller = pollers.get(id);
    if (!poller || (poller.state.kind === "unknown" && !poller.inflight))
      void probeMachine(id, false);
  }
}

function forgetMachine(machineId: string) {
  const poller = pollers.get(machineId);
  if (!poller || poller.watchers > 0) return;
  clearTimeout(poller.timer);
  pollers.delete(machineId);
}

/** Records whether a machine answered its latest request, for every view
 * that shows its connection state. */
export function reportRemoteMachineStatus(machineId: string, online: boolean) {
  const poller = pollerFor(machineId);
  const { kind } = poller.state;
  if (online) {
    if (kind === "online") return;
    poller.failures = 0;
    setMachineState(poller, {
      kind: "online",
      lastOkAt: Date.now(),
      lastErrorAt: poller.state.lastErrorAt,
    });
    // States that were not retried have no timer; resume polling.
    if (poller.watchers > 0 && !poller.timer && !poller.inflight && !networkDown)
      schedulePoll(machineId, poller, POLL_MS);
  } else if (kind === "online" || kind === "unknown" || kind === "connecting") {
    setMachineState(poller, {
      kind: "offline",
      lastOkAt: poller.state.lastOkAt,
      lastErrorAt: Date.now(),
    });
  }
}

/** The boolean view of a state: undefined while nothing is known yet. */
export function machineOnlineFromState(state: MachineState): boolean | undefined {
  switch (state.kind) {
    case "online":
      return true;
    case "offline":
    case "error":
    case "needsAuth":
      return false;
    case "connecting":
      // Keep the last answer while a retry runs, so views do not flicker.
      if (state.lastOkAt === undefined && state.lastErrorAt === undefined)
        return undefined;
      return (state.lastOkAt ?? -Infinity) >= (state.lastErrorAt ?? -Infinity);
    default:
      return undefined;
  }
}

/** Boolean-flavoured `watchMachineState`; the listener sees changes only. */
export function watchMachineStatus(
  machineId: string,
  listener?: (online: boolean | undefined) => void,
): () => void {
  let last = machineOnlineFromState(getMachineState(machineId));
  return watchMachineState(machineId, (state) => {
    const online = machineOnlineFromState(state);
    if (online === last) return;
    last = online;
    listener?.(online);
  });
}

/** A machine's connection state, polled while any view uses it. */
export function useRemoteMachineState(machineId?: string): MachineState {
  const subscribe = useCallback(
    (notify: () => void) =>
      machineId ? watchMachineState(machineId, notify) : () => undefined,
    [machineId],
  );
  const snapshot = () => (machineId ? getMachineState(machineId) : UNKNOWN_STATE);
  // Server rendering never subscribes, so it reads the same snapshot.
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Whether a machine is reachable; undefined until the first check returns. */
export function useRemoteMachineOnline(machineId?: string): boolean | undefined {
  return machineOnlineFromState(useRemoteMachineState(machineId));
}

const historyKey = (project: string) => `monocode.remote-history.v2:${project}`;

function cachedSessions(project: string): HostSessionSummary[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(historyKey(project)) ?? "[]",
    );
    return Array.isArray(value) ? (value as HostSessionSummary[]) : [];
  } catch {
    return [];
  }
}
export function cachedRemoteSessionSummary(project: string, sessionId: string) {
  return cachedSessions(project).find((session) => session.id === sessionId);
}

export type RemoteProjectSessions = {
  /** Undefined when this machine is not connected on this computer. */
  machine?: RemoteMachine;
  sessions: HostSessionSummary[];
  loaded: boolean;
};

/** Lists a remote project's host sessions, keeping the last list visible
 * while the machine is unreachable. */
export function useRemoteProjectSessions(
  project: string,
  enabled = true,
): RemoteProjectSessions {
  const remote = enabled ? remoteProjectFor(project) : undefined;
  const { machines } = useRemoteMachines(!!remote);
  const machine = remote
    ? machines.find((entry) => entry.environmentId === remote.environmentId)
    : undefined;
  const [sessions, setSessions] = useState<HostSessionSummary[]>(() =>
    remote ? cachedSessions(project) : [],
  );
  const [loaded, setLoaded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!remote) return;
    const changed = () => setRefresh((value) => value + 1);
    window.addEventListener(REMOTE_HISTORY_CHANGE, changed);
    return () => window.removeEventListener(REMOTE_HISTORY_CHANGE, changed);
  }, [!!remote]);
  useEffect(() => {
    setSessions(remote ? cachedSessions(project) : []);
    setLoaded(false);
    if (!remote || !machine) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      try {
        const next = await remoteRequest<HostSessionSummary[]>(
          machine.id,
          "sessions.list",
          { projectId: remote.projectId },
        );
        if (disposed) return;
        failures = 0;
        setSessions(next);
        setLoaded(true);
        try {
          localStorage.setItem(historyKey(project), JSON.stringify(next));
          window.dispatchEvent(new Event(REMOTE_HISTORY_UPDATED));
        } catch {
          /* the list is refetched next time */
        }
      } catch {
        // Keep the cached list and back off while SSH is unavailable.
        failures = Math.min(4, failures + 1);
      }
      if (!disposed)
        timer = setTimeout(
          () => void poll(),
          failures ? Math.min(30_000, 3_000 * 2 ** failures) : 3_000,
        );
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [project, remote?.projectId, machine?.id, refresh]);
  return { machine, sessions, loaded };
}
