import type { RemoteErrorKind } from "./protocol";

/** A classified `remote_request` failure, ready to show to a person. */
export type RemoteErrorInfo = {
  kind: RemoteErrorKind;
  title: string;
  hint: string;
  /** Whether trying again as-is can succeed, possibly after the user finishes
   * an approval step. False when the user has to change something first. */
  retryable: boolean;
};

const KINDS: readonly RemoteErrorKind[] = [
  "host-key-changed",
  "permission-denied",
  "timeout",
  "dns",
  "refused",
  "needs-interactive-auth",
  "ssh-missing",
  "unknown",
];

const DESCRIPTIONS: Record<RemoteErrorKind, Omit<RemoteErrorInfo, "kind">> = {
  "host-key-changed": {
    title: "Host key changed",
    hint: "The machine's SSH host key does not match the one on record. Verify that you are connecting to the right host, then run ssh-keygen -R <host> to forget the old key and reconnect.",
    retryable: false,
  },
  "permission-denied": {
    title: "Permission denied",
    hint: "The machine rejected your login. Check that your SSH key is authorized on it and loaded in your SSH agent, and that your SSH access policies (such as Tailscale or NetBird rules) allow this user.",
    retryable: false,
  },
  timeout: {
    title: "Machine is unreachable",
    hint: "The connection timed out. Check that your VPN (Tailscale or NetBird) is connected and that the machine is powered on.",
    retryable: true,
  },
  dns: {
    title: "Host name not found",
    hint: "The machine's name could not be resolved. Check the spelling, and that your VPN or network DNS is working.",
    retryable: true,
  },
  refused: {
    title: "Connection refused",
    hint: "The machine is reachable but nothing accepted the connection. Check that the SSH server is running and that the port is correct.",
    retryable: true,
  },
  "needs-interactive-auth": {
    title: "Approval needed",
    hint: "This machine needs you to sign in. Tailscale SSH or NetBird SSO needs approval in the browser. Approve the request there, then press Reconnect.",
    retryable: true,
  },
  "ssh-missing": {
    title: "OpenSSH not found",
    hint: "MonoCode could not start the ssh command. Install OpenSSH, make sure ssh is on your PATH, and restart MonoCode.",
    retryable: false,
  },
  unknown: {
    title: "Connection failed",
    hint: "Something went wrong while reaching the machine. MonoCode will keep retrying. Check your network and VPN.",
    retryable: true,
  },
};

// Most specific first: a generic "Machine is unreachable" often wraps one of
// the more precise messages.
const LEGACY: [string, RemoteErrorKind][] = [
  ["remote host identification has changed", "host-key-changed"],
  ["host key", "host-key-changed"],
  ["permission denied", "permission-denied"],
  ["could not resolve", "dns"],
  ["connection refused", "refused"],
  ["could not start openssh", "ssh-missing"],
  ["timed out", "timeout"],
  ["machine is unreachable", "timeout"],
];

const PREFIX = /^\[ssh:([a-z-]+)\]\s*/;

function messageOf(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Error) return raw.message;
  if (typeof raw === "object" && raw !== null && "message" in raw) {
    const { message } = raw as { message: unknown };
    if (typeof message === "string") return message;
  }
  return raw == null ? "" : String(raw);
}

/** Turns a `remote_request` failure into something a person can act on. */
export function describeRemoteError(raw: unknown): RemoteErrorInfo {
  let message = messageOf(raw).trim();
  while (message.startsWith("Error: ")) message = message.slice(7).trimStart();
  const prefixed = PREFIX.exec(message);
  let kind: RemoteErrorKind | undefined;
  if (prefixed) {
    message = message.slice(prefixed[0].length);
    kind = KINDS.find((entry) => entry === prefixed[1]);
  }
  if (!kind || kind === "unknown") {
    const lower = message.toLowerCase();
    const legacy = LEGACY.find(([needle]) => lower.includes(needle));
    // An explicit "unknown" from the host stays unknown unless the text says more.
    kind = legacy?.[1] ?? kind ?? "unknown";
  }
  return { kind, ...DESCRIPTIONS[kind] };
}
