import type { RemoteMachine } from "../model/protocol";

const MAX_TARGET_LENGTH = 255;
const ALLOWED = /^[A-Za-z0-9._\-@:[\]]+$/;

export type SshFormCheck = {
  /** The trimmed address, which is what is sent to the host app. */
  target: string;
  /** Inline message for the address field; empty while the field is empty. */
  targetError?: string;
  portError?: string;
  /** Non-blocking: the same address is already connected. */
  warning?: string;
  /** Whether Connect may be pressed. */
  valid: boolean;
};

/** Mirrors `validate_target` in `remote_ssh.rs`, so a bad address is explained
 * before the host app rejects it. */
export function validateSshTarget(value: string): string | undefined {
  const target = value.trim();
  if (!target) return undefined;
  if (target.length > MAX_TARGET_LENGTH)
    return `The SSH address must be ${MAX_TARGET_LENGTH} characters or fewer.`;
  if (target.startsWith("-"))
    return "The SSH address cannot start with a hyphen.";
  if (!ALLOWED.test(target))
    return "Use only letters, digits, and . _ - @ : [ ] in the SSH address.";
  if (
    target.split("@").length > 2 ||
    target.startsWith("@") ||
    target.endsWith("@")
  )
    return "Use the form user@host, with at most one @.";
  return undefined;
}

/** The port as a number, or undefined when it is empty or not 1 to 65535. */
export function parseSshPort(value: string): number | undefined {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : undefined;
}

export function checkSshForm(
  targetInput: string,
  portInput: string,
  machines: readonly RemoteMachine[],
): SshFormCheck {
  const target = targetInput.trim();
  const targetError = validateSshTarget(target);
  const portError =
    portInput.trim() && parseSshPort(portInput) === undefined
      ? "The port must be a whole number from 1 to 65535."
      : undefined;
  const existing =
    target && !targetError
      ? machines.find(
          (machine) =>
            machine.ssh?.target.toLowerCase() === target.toLowerCase(),
        )
      : undefined;
  return {
    target,
    targetError,
    portError,
    warning: existing
      ? `${existing.name} already uses this address. You can still continue.`
      : undefined,
    valid: Boolean(target) && !targetError && !portError,
  };
}
