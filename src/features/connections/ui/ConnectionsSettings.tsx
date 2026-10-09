import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { copyText } from "../../../platform/tauri/clipboard";
import { Internet, Loader, Plus, Trash2 } from "../../../shared/ui/icons";
import {
  connectMachine,
  disconnectMachine,
  reconnectRemoteMachine,
  refreshRemoteMachines,
  remoteRequest,
  useRemoteMachineState,
  useRemoteMachines,
} from "../model/connections";
import {
  REMOTE_PROVIDERS,
  type HostDescriptor,
  type RemoteMachine,
  type SshSetup,
} from "../model/protocol";
import { describeRemoteError } from "../model/remoteErrors";
import {
  describeMachineProblem,
  diagnosticsText,
  isWebUrl,
  machineStatusText,
  needsAttention,
  type HostCapabilities,
} from "./machineStatus";
import { checkSshForm, parseSshPort } from "./sshTargetValidation";

const input =
  "w-full rounded-lg border border-content/15 bg-content/3 px-3 py-2 text-[13px] outline-none focus:border-content/35";
const button =
  "rounded-lg bg-selection px-3 py-2 text-[13px] font-medium hover:bg-selection-hover disabled:opacity-40";

/** A failure to show: SSH ones are explained, others are shown as they are. */
type Problem = {
  message: string;
  ssh?: { errorKind?: string; machine?: RemoteMachine };
};

/** Asks the host once what it supports. It runs when a machine becomes
 * reachable, not on a timer; the shared poller already watches reachability. */
function useHostCapabilities(
  machine: RemoteMachine,
  online: boolean,
  paused: boolean,
): HostCapabilities {
  const [host, setHost] = useState<HostCapabilities>({});
  useEffect(() => {
    if (!online || paused) return;
    let disposed = false;
    void remoteRequest<HostDescriptor>(machine.id, "environment.describe", {
      supportedProviders: REMOTE_PROVIDERS,
    })
      .then((descriptor) => {
        if (disposed) return;
        setHost({
          identityChanged: descriptor.environmentId !== machine.environmentId,
          noProvider: !descriptor.providers.length,
          needsUpdate:
            !descriptor.capabilities?.includes("workspace.run") ||
            !descriptor.capabilities?.includes("git.worktreeCreate") ||
            // Listing the machine's skills for the chat's `/` menu.
            !descriptor.capabilities?.includes("skills.list"),
        });
      })
      .catch(() => {
        // The shared poller reports unreachable machines.
      });
    return () => {
      disposed = true;
    };
  }, [machine.id, machine.environmentId, online, paused]);
  return online ? host : {};
}

function MachineRow({
  machine,
  busy,
  revoking,
  onReconnect,
  onUpdate,
  onRemove,
  children,
}: {
  machine: RemoteMachine;
  busy: boolean;
  revoking: boolean;
  onReconnect: () => void;
  onUpdate: () => void;
  onRemove: () => void;
  children?: ReactNode;
}) {
  const state = useRemoteMachineState(machine.id);
  const host = useHostCapabilities(machine, state.kind === "online", busy);
  const [copied, setCopied] = useState(false);
  const problem = needsAttention(state) ? describeMachineProblem(state) : undefined;
  const update = machine.ssh && state.kind === "online" && host.needsUpdate;
  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-4">
        <Internet className="size-5 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{machine.name}</div>
          <div className="mt-1 truncate text-[12px] text-muted">
            {machine.ssh
              ? `SSH · ${machine.ssh.target}${machine.ssh.port ? ` · port ${machine.ssh.port}` : ""}`
              : machine.endpoint}
          </div>
          <div className="mt-1 text-[12px] text-muted">
            {machineStatusText(state, host)}
          </div>
          {problem ? (
            <div className="mt-1 text-[11px] leading-relaxed text-muted">
              {problem.hint}
            </div>
          ) : null}
          {update ? (
            <div className="mt-1 text-[11px] text-muted">
              Updating restarts the host and interrupts active agent turns.
            </div>
          ) : null}
          <details className="mt-2 text-[11px] text-muted">
            <summary className="cursor-pointer">Details</summary>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt>State</dt>
              <dd>{state.kind}</dd>
              <dt>Last successful contact</dt>
              <dd>
                {state.lastOkAt === undefined
                  ? "Never"
                  : new Date(state.lastOkAt).toLocaleString()}
              </dd>
              <dt>Last error kind</dt>
              <dd>{state.errorKind ?? "None"}</dd>
              <dt>Message</dt>
              <dd className="whitespace-pre-wrap break-words">
                {state.reason ?? "None"}
              </dd>
            </dl>
            <button
              type="button"
              className="mt-2 rounded px-2 py-1 text-content/60 hover:bg-selection hover:text-content"
              onClick={() => {
                void copyText(diagnosticsText(machine, state)).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              Copy diagnostics
            </button>
            {copied ? <span className="ml-2">Copied</span> : null}
          </details>
        </div>
        {machine.ssh && (
          <div className="flex shrink-0 items-center gap-2">
            {update ? (
              <button
                className={button}
                disabled={busy}
                title="Downloads the matching host package and restarts the host; active agent turns will be interrupted"
                onClick={onUpdate}
              >
                Update Host
              </button>
            ) : null}
            <button className={button} disabled={busy} onClick={onReconnect}>
              Reconnect
            </button>
          </div>
        )}
        <button
          disabled={busy || revoking}
          className="rounded p-2 text-muted hover:bg-selection hover:text-content disabled:opacity-40"
          aria-label={`Remove ${machine.name}`}
          title="Remove connection…"
          onClick={onRemove}
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      {children}
    </div>
  );
}

function SignInNotice({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const web = isWebUrl(url);
  return (
    <div
      role="group"
      aria-label="Sign-in approval"
      className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3"
    >
      <p className="text-[13px] font-medium text-content">
        Waiting for sign-in approval
      </p>
      <p className="text-[12px] leading-relaxed text-content/65">
        {web
          ? "This machine needs you to approve the sign-in in your browser. This screen continues by itself once you approve."
          : "This machine asked for a sign-in, but its link is not a web address, so MonoCode will not open it."}
      </p>
      {web ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={button}
            onClick={() => void openUrl(url.trim()).catch(() => undefined)}
          >
            Open in browser
          </button>
          <button
            type="button"
            className={button}
            onClick={() => {
              void copyText(url.trim()).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? "Link copied" : "Copy link"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ConnectionsSettings() {
  const { machines, loaded } = useRemoteMachines();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [port, setPort] = useState("");
  const [jobId, setJobId] = useState<string>();
  const [job, setJob] = useState<SshSetup>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>();
  const [notice, setNotice] = useState("");
  const [answer, setAnswer] = useState("");
  const [answering, setAnswering] = useState(false);
  const [updatingMachine, setUpdatingMachine] = useState<string>();
  const [removing, setRemoving] = useState<string>();
  const [revoking, setRevoking] = useState(false);
  const [url, setUrl] = useState("http://127.0.0.1:3774");
  const [token, setToken] = useState("");
  const alive = useRef(true);
  const currentJob = useRef<string | undefined>(undefined);
  const submitting = useRef(false);
  const progress = useRef<HTMLDivElement>(null);
  /** The machine the running job reconnects; undefined when adding one. */
  const attempt = useRef<RemoteMachine | undefined>(undefined);
  const setError = (message: string, ssh?: Problem["ssh"]) =>
    setProblem(message ? { message, ssh } : undefined);
  const form = checkSshForm(target, port, machines);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (currentJob.current)
        void invoke("remote_ssh_cancel", { jobId: currentJob.current }).catch(
          () => {},
        );
    };
  }, []);
  useEffect(() => {
    if (!jobId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await invoke<SshSetup>("remote_ssh_poll", { jobId });
        if (disposed) return;
        setJob(next);
        if (next.done) {
          currentJob.current = undefined;
          submitting.current = false;
          setBusy(false);
          setJobId(undefined);
          setAnswer("");
          if (next.error)
            setError(next.error, {
              errorKind: next.errorKind,
              machine: attempt.current,
            });
          else if (next.machine) {
            setAdding(false);
            setTarget("");
            setName("");
            setPort("");
            setNotice(
              updatingMachine
                ? `${next.machine.name} was updated and reconnected.`
                : `${next.machine.name} is connected. To work on it, click + next to Projects in the project rail and choose Open folder on a machine.`,
            );
            setUpdatingMachine(undefined);
            refreshRemoteMachines();
            // Show the new state now instead of waiting for the next poll.
            void reconnectRemoteMachine(next.machine.id);
          }
          return;
        }
      } catch (reason) {
        if (disposed) return;
        setError(String(reason));
        void invoke("remote_ssh_cancel", { jobId }).catch(() => {});
        currentJob.current = undefined;
        submitting.current = false;
        setBusy(false);
        setJobId(undefined);
        return;
      }
      timer = setTimeout(() => void poll(), 350);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [jobId, updatingMachine]);
  useEffect(() => {
    setAnswer("");
    setAnswering(false);
    if (job?.prompt)
      progress.current?.scrollIntoView?.({
        block: "nearest",
        behavior: "smooth",
      });
  }, [job?.prompt?.id]);
  const begin = async (machine?: RemoteMachine, upgrade = false) => {
    if (submitting.current) return;
    if (!machine && !form.valid) return;
    submitting.current = true;
    attempt.current = machine;
    setBusy(true);
    setError("");
    setNotice("");
    setJob(undefined);
    setUpdatingMachine(upgrade ? machine?.id : undefined);
    try {
      const id = machine
        ? await invoke<string>("remote_ssh_reconnect", {
            machineId: machine.id,
            ...(upgrade ? { upgrade: true } : {}),
          })
        : await invoke<string>("remote_ssh_begin", {
            target: form.target,
            name: name.trim(),
            port: parseSshPort(port) ?? null,
          });
      if (!alive.current) {
        await invoke("remote_ssh_cancel", { jobId: id });
        return;
      }
      currentJob.current = id;
      setJobId(id);
    } catch (reason) {
      submitting.current = false;
      if (alive.current) {
        setError(String(reason), { machine });
        setBusy(false);
      }
    }
  };
  const respond = async (value: string) => {
    if (!jobId || !job?.prompt || answering) return;
    setAnswering(true);
    setError("");
    try {
      await invoke("remote_ssh_answer", {
        jobId,
        promptId: job.prompt.id,
        answer: value,
      });
      setAnswer("");
    } catch (reason) {
      setError(String(reason));
      setAnswering(false);
    }
  };
  const remove = async (machine: RemoteMachine, revoke: boolean) => {
    setError("");
    setNotice("");
    setRevoking(true);
    try {
      if (revoke) {
        try {
          await remoteRequest(machine.id, "devices.revokeSelf");
        } catch (reason) {
          throw new Error(
            `Could not revoke access, so ${machine.name} was not removed: ${String(reason)}. Reconnect and try again, or remove it from this desktop only and revoke it on the host with monocode-host devices and monocode-host revoke <device-id>.`,
          );
        }
      }
      await disconnectMachine(machine.id);
      setRemoving(undefined);
      setNotice(
        revoke
          ? `${machine.name} was removed and this desktop's access was revoked. The host and its sessions keep running.`
          : `${machine.name} was removed from this desktop. The host and its sessions keep running, and it still accepts this desktop's credential.`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (alive.current) setRevoking(false);
    }
  };
  const explainedError = problem?.ssh
    ? describeRemoteError(
        problem.ssh.errorKind
          ? `[ssh:${problem.ssh.errorKind}] ${problem.message}`
          : problem.message,
      )
    : undefined;
  // An unclassified failure keeps its own text; "keeps retrying" would mislead.
  const explained = explainedError?.kind === "unknown" ? undefined : explainedError;
  const rawMessage = problem?.message.replace(/^\[ssh:[a-z-]+\]\s*/, "");
  return (
    <div data-setting-id="remote-machines" className="flex flex-col gap-5">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-content">
            Your machines
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            Run agents on another computer and return to them from your laptop.
            The host keeps working when you close MonoCode here.
          </p>
        </div>
        {!adding && (
          <button
            className={`${button} flex shrink-0 items-center gap-2`}
            disabled={busy}
            onClick={() => {
              setAdding(true);
              setError("");
              setNotice("");
            }}
          >
            <Plus className="size-4" /> Add machine
          </button>
        )}
      </div>
      {machines.length > 0 ? (
        <div className="divide-y divide-stroke overflow-hidden rounded-xl border border-stroke">
          {machines.map((machine) => (
            <MachineRow
              key={machine.id}
              machine={machine}
              busy={busy}
              revoking={revoking}
              onReconnect={() => void begin(machine)}
              onUpdate={() => void begin(machine, true)}
              onRemove={() => {
                setError("");
                setRemoving(machine.id);
              }}
            >
              {removing === machine.id && (
                <div
                  role="group"
                  aria-label={`Confirm removing ${machine.name}`}
                  className="flex flex-col gap-3 border-t border-stroke bg-content/3 px-4 py-4 text-[12px] leading-relaxed text-content/60"
                >
                  <p className="text-[13px] font-medium text-content">
                    Remove {machine.name} from this desktop?
                  </p>
                  <p>
                    This closes this desktop’s connection to the machine. It
                    does not stop the host, and its sessions keep running and
                    stay on that machine. You can add it again later.
                  </p>
                  <p>
                    Removing alone leaves this desktop’s credential valid on the
                    host. Revoke access to invalidate it first; the machine must
                    be reachable.
                  </p>
                  <p>
                    To stop the host and turn off its background service, run{" "}
                    <code className="rounded bg-content/10 px-1">
                      ~/.monocode-host/bin/monocode-host service uninstall
                    </code>{" "}
                    on that machine (
                    <code className="rounded bg-content/10 px-1">
                      %USERPROFILE%\.monocode-host\bin\monocode-host.cmd service
                      uninstall
                    </code>{" "}
                    on Windows). Its sessions and history are kept.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className={button}
                      disabled={revoking}
                      onClick={() => void remove(machine, true)}
                    >
                      Revoke access and remove
                    </button>
                    <button
                      className={button}
                      disabled={revoking}
                      onClick={() => void remove(machine, false)}
                    >
                      Remove from this desktop only
                    </button>
                    <button
                      className="px-3 py-2 text-[13px] text-muted"
                      disabled={revoking}
                      onClick={() => setRemoving(undefined)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </MachineRow>
          ))}
        </div>
      ) : loaded && !adding ? (
        <div className="rounded-xl border border-dashed border-content/15 px-5 py-8 text-center text-[13px] text-muted">
          Add your always-on Windows, Mac, or Linux machine to get started.
        </div>
      ) : null}
      {adding && (
        <form
          className="flex flex-col gap-4 rounded-xl border border-stroke p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void begin();
          }}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-medium">Connect through SSH</h3>
            <span className="rounded bg-selection px-2 py-1 text-[11px] text-content/60">
              SSH
            </span>
          </div>
          <label className="flex flex-col gap-1.5 text-[12px] text-content/65">
            SSH address
            <input
              autoFocus
              required
              disabled={busy}
              className={input}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="user@my-mac-mini or an SSH alias"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={form.targetError ? true : undefined}
            />
            {form.targetError ? (
              <span role="alert" className="text-[12px] text-danger">
                {form.targetError}
              </span>
            ) : form.warning ? (
              <span role="status" className="text-[12px] text-warning">
                {form.warning}
              </span>
            ) : null}
          </label>
          <label className="flex flex-col gap-1.5 text-[12px] text-content/65">
            Name <span className="sr-only">(optional)</span>
            <input
              disabled={busy}
              className={input}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Optional, e.g. Home Mac mini"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>
          <details
            className="text-[12px] text-muted"
            open={form.portError ? true : undefined}
          >
            <summary className="cursor-pointer">Advanced</summary>
            <label className="mt-3 flex max-w-72 flex-col gap-1.5">
              SSH port
              <input
                disabled={busy}
                type="number"
                min={1}
                max={65535}
                className={`${input} max-w-40`}
                value={port}
                onChange={(event) => setPort(event.target.value)}
                placeholder="From SSH config"
                aria-invalid={form.portError ? true : undefined}
              />
              {form.portError ? (
                <span role="alert" className="text-danger">
                  {form.portError}
                </span>
              ) : null}
            </label>
          </details>
          <p className="text-[12px] leading-relaxed text-muted">
            MonoCode installs and starts its background host, then connects
            securely. Your SSH keys and config are used automatically. Enable
            SSH on the host and sign in to Codex or Claude Code there. On
            Windows and Mac, keep the host’s desktop account signed in and the
            machine awake. Locking the desktop is fine.
          </p>
          <p className="text-[12px] leading-relaxed text-muted">
            On Linux, setup installs a systemd user service and turns on
            lingering for your account (
            <code className="rounded bg-content/10 px-1">
              loginctl enable-linger
            </code>
            ), so the host and your other user services keep running after you
            log out. The host keeps running until you stop it on that machine;
            removing it here only disconnects this desktop.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              className="px-3 py-2 text-[13px] text-muted"
              onClick={() => setAdding(false)}
            >
              Cancel
            </button>
            <button className={button} disabled={busy || !form.valid}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </form>
      )}
      {busy && jobId && (
        <div
          className="flex flex-col gap-3 rounded-xl border border-stroke p-5"
          role="status"
          ref={progress}
        >
          <div className="flex items-center gap-2 text-[13px]">
            <Loader className="size-4 animate-spin" />
            {job?.message ?? "Starting connection…"}
          </div>
          {job?.authUrl ? <SignInNotice url={job.authUrl} /> : null}
          {job?.prompt && (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void respond(job.prompt!.confirm ? "yes" : answer);
              }}
            >
              <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-content/70">
                {job.prompt.message}
              </p>
              {!job.prompt.confirm && (
                <input
                  key={job.prompt.id}
                  autoFocus
                  type="password"
                  aria-label="SSH password or passphrase"
                  autoComplete="off"
                  disabled={answering}
                  className={input}
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                />
              )}
              <div className="flex gap-2">
                <button className={button} disabled={answering}>
                  {job.prompt.confirm ? "Trust host and continue" : "Continue"}
                </button>
                {job.prompt.confirm && (
                  <button
                    type="button"
                    className={button}
                    disabled={answering}
                    onClick={() => void respond("no")}
                  >
                    Reject
                  </button>
                )}
              </div>
            </form>
          )}
          <button
            type="button"
            className="self-start text-[12px] text-muted hover:text-content"
            onClick={() => {
              if (jobId)
                void invoke("remote_ssh_cancel", { jobId }).catch((reason) =>
                  setError(String(reason)),
                );
            }}
          >
            Cancel connection
          </button>
        </div>
      )}
      {problem && (
        <div
          role="alert"
          className="flex flex-col gap-2 whitespace-pre-wrap break-words rounded-lg bg-danger/5 p-3 text-[12px] leading-relaxed text-danger"
        >
          {explained ? (
            <>
              <p className="text-[13px] font-medium">{explained.title}</p>
              <p>{explained.hint}</p>
              <p className="text-danger">{rawMessage}</p>
              {explained.kind === "needs-interactive-auth" &&
              (problem.ssh?.machine || (adding && form.valid)) ? (
                <button
                  type="button"
                  className={`${button} self-start`}
                  disabled={busy}
                  onClick={() => void begin(problem.ssh?.machine)}
                >
                  Reconnect
                </button>
              ) : null}
            </>
          ) : (
            <p>{rawMessage}</p>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="text-[13px] text-success">
          {notice}
        </p>
      )}
      <details className="text-[12px] text-muted">
        <summary className="cursor-pointer">
          Connect to an existing host by URL
        </summary>
        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setError("");
            void connectMachine("", url, token)
              .then((machine) => {
                setToken("");
                setNotice(`${machine.name} is connected.`);
              })
              .catch((reason) => setError(String(reason)))
              .finally(() => setBusy(false));
          }}
        >
          <label>
            Host URL
            <input
              required
              disabled={busy}
              className={`${input} mt-1`}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label>
            Device token
            <input
              required
              disabled={busy}
              type="password"
              autoComplete="off"
              className={`${input} mt-1`}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <button className={`${button} self-start`} disabled={busy}>
            Connect by URL
          </button>
        </form>
      </details>
    </div>
  );
}
