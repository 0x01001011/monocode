import { describe, expect, it } from "vitest";
import { describeRemoteError } from "./remoteErrors";
import type { RemoteErrorKind } from "./protocol";

// Each row: case name, raw error as `remote_request` rejects it, expected kind.
const table: [string, unknown, RemoteErrorKind][] = [
  ["prefixed timeout", "[ssh:timeout] Machine is unreachable. Check the VPN.", "timeout"],
  ["prefixed dns", "[ssh:dns] Could not resolve hostname box", "dns"],
  ["prefixed refused", "[ssh:refused] Connection refused", "refused"],
  ["prefixed permission", "[ssh:permission-denied] Permission denied (publickey).", "permission-denied"],
  ["prefixed host key", "[ssh:host-key-changed] Host key verification failed.", "host-key-changed"],
  ["prefixed interactive auth", "[ssh:needs-interactive-auth] Approve in the browser", "needs-interactive-auth"],
  ["prefixed ssh missing", "[ssh:ssh-missing] Could not start OpenSSH", "ssh-missing"],
  ["prefixed unknown", "[ssh:unknown] something odd", "unknown"],
  ["unrecognized slug", "[ssh:bogus] Machine is unreachable", "timeout"],
  ["Error: prefix", "Error: [ssh:dns] Could not resolve hostname box", "dns"],
  ["Error instance", new Error("[ssh:refused] nope"), "refused"],
  ["legacy unreachable", "Machine is unreachable", "timeout"],
  ["legacy timed out", "ssh: connect to host 10.0.0.2 port 22: Operation timed out", "timeout"],
  ["legacy permission", "user@box: Permission denied (publickey,password).", "permission-denied"],
  ["legacy host key", "Host key verification failed.", "host-key-changed"],
  ["legacy host id changed", "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!", "host-key-changed"],
  ["legacy dns", "ssh: Could not resolve hostname box: nodename nor servname provided", "dns"],
  ["legacy refused", "ssh: connect to host box port 22: Connection refused", "refused"],
  ["legacy openssh", "Could not start OpenSSH: No such file or directory", "ssh-missing"],
  ["legacy specific beats generic", "Machine is unreachable: Connection refused", "refused"],
  ["nothing recognizable", "boom", "unknown"],
  ["empty string", "", "unknown"],
  ["undefined", undefined, "unknown"],
  ["object with message", { message: "[ssh:timeout] slow" }, "timeout"],
];

describe("describeRemoteError", () => {
  it.each(table)("classifies %s", (_name, raw, kind) => {
    expect(describeRemoteError(raw).kind).toBe(kind);
  });

  it("always returns a title and hint", () => {
    for (const [, raw] of table) {
      const info = describeRemoteError(raw);
      expect(info.title.length).toBeGreaterThan(0);
      expect(info.hint.length).toBeGreaterThan(0);
    }
  });

  it("explains browser approval for interactive auth", () => {
    const { hint, retryable } = describeRemoteError("[ssh:needs-interactive-auth] x");
    expect(hint).toMatch(/Tailscale SSH/);
    expect(hint).toMatch(/NetBird/);
    expect(hint).toMatch(/browser/);
    expect(hint).toMatch(/Reconnect/);
    expect(retryable).toBe(true);
  });

  it("tells the user to verify the host and clear the old key", () => {
    const { hint, retryable } = describeRemoteError("[ssh:host-key-changed] x");
    expect(hint).toMatch(/verify/i);
    expect(hint).toContain("ssh-keygen -R <host>");
    expect(retryable).toBe(false);
  });

  it("mentions keys, agent and access policies for permission errors", () => {
    const { hint } = describeRemoteError("[ssh:permission-denied] x");
    expect(hint).toMatch(/key/i);
    expect(hint).toMatch(/agent/i);
    expect(hint).toMatch(/polic/i);
  });

  it("suggests checking the VPN on timeouts", () => {
    const { hint, retryable } = describeRemoteError("[ssh:timeout] x");
    expect(hint).toMatch(/Tailscale/);
    expect(hint).toMatch(/NetBird/);
    expect(retryable).toBe(true);
  });

  it("marks errors that retrying cannot fix", () => {
    const retryable = (raw: string) => describeRemoteError(raw).retryable;
    expect(retryable("[ssh:ssh-missing] x")).toBe(false);
    expect(retryable("[ssh:permission-denied] x")).toBe(false);
    for (const kind of ["timeout", "dns", "refused", "unknown"])
      expect(retryable(`[ssh:${kind}] x`)).toBe(true);
  });
});
