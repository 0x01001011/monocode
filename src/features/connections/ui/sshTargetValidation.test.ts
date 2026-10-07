import { expect, it } from "vitest";
import type { RemoteMachine } from "../model/protocol";
import {
  checkSshForm,
  parseSshPort,
  validateSshTarget,
} from "./sshTargetValidation";

const machine: RemoteMachine = {
  id: "machine",
  name: "Home Mac",
  environmentId: "env",
  endpoint: "ssh://me@home",
  ssh: { target: "me@home", remotePort: 3774 },
};

it.each([
  "me@my-mac-mini",
  "host",
  "my_alias.example",
  "user@192.168.0.2",
  "user@[fe80::1]",
  "a".repeat(255),
])("accepts the address %s", (target) => {
  expect(validateSshTarget(target)).toBeUndefined();
});

it.each([
  ["-oProxyCommand=bad", "hyphen"],
  ["a".repeat(256), "255"],
  ["host;touch /tmp/x", "letters, digits"],
  ["host\nname", "letters, digits"],
  ["$(whoami)", "letters, digits"],
  ["user@host command", "letters, digits"],
  ["host/../x", "letters, digits"],
  ["ssh://user@host", "letters, digits"],
  ["a@b@c", "at most one @"],
  ["@host", "at most one @"],
  ["user@", "at most one @"],
])("rejects the address %j", (target, message) => {
  expect(validateSshTarget(target)).toContain(message);
});

it("stays quiet while the address is empty and trims surrounding spaces", () => {
  expect(validateSshTarget("   ")).toBeUndefined();
  expect(validateSshTarget("  me@home  ")).toBeUndefined();
  expect(checkSshForm("   ", "", []).valid).toBe(false);
  expect(checkSshForm("  me@home ", "", []).target).toBe("me@home");
});

it.each([
  ["1", 1],
  ["22", 22],
  ["65535", 65535],
  ["0", undefined],
  ["65536", undefined],
  ["1.5", undefined],
  ["-1", undefined],
  ["22a", undefined],
  ["", undefined],
])("parses the port %j as %s", (value, expected) => {
  expect(parseSshPort(value)).toBe(expected);
});

it("explains a bad port inline and blocks Connect", () => {
  const check = checkSshForm("me@home", "70000", []);
  expect(check.valid).toBe(false);
  expect(check.portError).toContain("1 to 65535");
  expect(checkSshForm("me@home", "2222", []).valid).toBe(true);
  expect(checkSshForm("me@home", "", []).valid).toBe(true);
});

it("warns without blocking when the address is already connected", () => {
  const check = checkSshForm("ME@home", "", [machine]);
  expect(check.valid).toBe(true);
  expect(check.warning).toContain("Home Mac");
  expect(checkSshForm("me@elsewhere", "", [machine]).warning).toBeUndefined();
});

it("blocks Connect on an invalid address and does not warn about it", () => {
  const check = checkSshForm("-bad", "", [
    { ...machine, ssh: { target: "-bad", remotePort: 1 } },
  ]);
  expect(check.valid).toBe(false);
  expect(check.targetError).toBeTruthy();
  expect(check.warning).toBeUndefined();
});
