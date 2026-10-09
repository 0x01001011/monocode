// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { copyText } from "../../../platform/tauri/clipboard";
import { ConnectionsSettings } from "./ConnectionsSettings";
import {
  REMOTE_PROVIDERS,
  type RemoteMachine,
  type SshSetup,
} from "../model/protocol";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../../platform/tauri/clipboard", () => ({
  copyText: vi.fn(async () => undefined),
}));
let container: HTMLDivElement;
let root: Root;
let state: SshSetup;
let machines: RemoteMachine[];
/** Machine id to the error its `environment.describe` request fails with. */
let describeErrors: Record<string, string>;
/** Capabilities every `environment.describe` answer advertises. */
let describeCapabilities: string[] | undefined;
const machine: RemoteMachine = {
  id: "machine",
  name: "Home Mac",
  environmentId: "env",
  endpoint: "ssh://me@home",
  ssh: { target: "me@home", remotePort: 3774 },
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  machines = [];
  describeErrors = {};
  describeCapabilities = undefined;
  state = { id: "setup", message: "Installing host…", done: false };
  vi.mocked(invoke).mockReset();
  vi.mocked(openUrl).mockReset();
  vi.mocked(openUrl).mockResolvedValue(undefined);
  vi.mocked(copyText).mockClear();
  vi.mocked(invoke).mockImplementation(async (command, input) => {
    if (command === "remote_machines") return [...machines];
    if (command === "remote_ssh_begin" || command === "remote_ssh_reconnect")
      return "setup";
    if (command === "remote_ssh_poll") return { ...state };
    if (command === "remote_request") {
      const { machineId, method } = input as {
        machineId: string;
        method: string;
      };
      if (method === "environment.describe" && describeErrors[machineId])
        throw describeErrors[machineId];
      return {
        environmentId: "env",
        providers: ["codex"],
        capabilities: describeCapabilities,
      };
    }
    if (command === "remote_disconnect") {
      machines = [];
      return;
    }
    if (command === "remote_ssh_cancel" || command === "remote_ssh_answer")
      return;
    throw new Error(`Unexpected command ${command}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === name,
  )!;
async function render() {
  await act(async () => root.render(createElement(ConnectionsSettings)));
}
async function fill(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function start() {
  await render();
  await act(async () => button("Add machine").click());
  await fill(
    'input[placeholder="user@my-mac-mini or an SSH alias"]',
    "me@home",
  );
  await act(async () => button("Connect").click());
}
async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
}

it("starts SSH setup from Settings and makes the machine available after native pairing", async () => {
  await start();
  expect(invoke).toHaveBeenCalledWith("remote_ssh_begin", {
    target: "me@home",
    name: "",
    port: null,
  });
  expect(container.textContent).toContain("Installing host…");
  machines = [machine];
  state = { ...state, done: true, machine };
  await poll();
  expect(container.textContent).toContain("Home Mac is connected");
  expect(container.textContent).toContain("SSH · me@home");
  expect(
    container.querySelector(
      'input[placeholder="user@my-mac-mini or an SSH alias"]',
    ),
  ).toBeNull();
});

it("sets the SSH heading one step below the section title", async () => {
  await render();
  await act(async () => button("Add machine").click());
  const sshHeading = [...container.querySelectorAll("h3")].find(
    (heading) => heading.textContent === "Connect through SSH",
  )!;
  expect(sshHeading.className).toContain("text-[13px]");
  expect(sshHeading.className).not.toContain("text-[14px]");
});

it("requires an explicit host trust answer and forwards secrets only to the native prompt", async () => {
  state.prompt = {
    id: "trust",
    message: "Host fingerprint: SHA256:example",
    confirm: true,
  };
  await start();
  expect(invoke).not.toHaveBeenCalledWith(
    "remote_ssh_answer",
    expect.anything(),
  );
  await act(async () => button("Trust host and continue").click());
  expect(invoke).toHaveBeenCalledWith("remote_ssh_answer", {
    jobId: "setup",
    promptId: "trust",
    answer: "yes",
  });
  state = {
    ...state,
    prompt: { id: "password", message: "Password:", confirm: false },
  };
  await poll();
  await fill(
    'input[aria-label="SSH password or passphrase"]',
    "secret-for-this-prompt",
  );
  await act(async () => button("Continue").click());
  expect(invoke).toHaveBeenCalledWith("remote_ssh_answer", {
    jobId: "setup",
    promptId: "password",
    answer: "secret-for-this-prompt",
  });
  expect(
    container.querySelector<HTMLInputElement>(
      'input[aria-label="SSH password or passphrase"]',
    )!.value,
  ).toBe("");
});

it("keeps the SSH address after a failed install and cancels active setup when Settings closes", async () => {
  state = { ...state, done: true, error: "Host package is unavailable" };
  await start();
  expect(container.textContent).toContain("Host package is unavailable");
  expect(
    container.querySelector<HTMLInputElement>(
      'input[placeholder="user@my-mac-mini or an SSH alias"]',
    )!.value,
  ).toBe("me@home");
  state = { id: "setup", message: "Connecting…", done: false };
  await act(async () => button("Connect").click());
  await act(async () => root.unmount());
  root = createRoot(container);
  expect(invoke).toHaveBeenCalledWith("remote_ssh_cancel", { jobId: "setup" });
});

async function openRemove() {
  machines = [machine];
  await render();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Remove Home Mac"]')!
      .click(),
  );
}

it("offers an explicit host update for an SSH machine missing workspace methods", async () => {
  machines = [machine];
  await render();
  expect(container.textContent).toContain(
    "host update needed for Explorer and Changes",
  );
  expect(container.textContent).toContain("interrupts active agent turns");
  await act(async () => button("Update Host").click());
  expect(invoke).toHaveBeenCalledWith("remote_ssh_reconnect", {
    machineId: machine.id,
    upgrade: true,
  });
});

it("asks for a host update when it cannot list the machine's skills", async () => {
  machines = [machine];
  describeCapabilities = ["workspace.run", "git.worktreeCreate"];
  await render();
  expect(button("Update Host")).toBeTruthy();

  await act(async () => root.unmount());
  root = createRoot(container);
  describeCapabilities = ["workspace.run", "git.worktreeCreate", "skills.list"];
  await render();
  expect(container.textContent).not.toContain("host update needed");
  expect(
    [...container.querySelectorAll("button")].some(
      (b) => b.textContent?.trim() === "Update Host",
    ),
  ).toBe(false);
});

it("advertises every supported provider when checking a host", async () => {
  machines = [machine];
  await render();
  expect(invoke).toHaveBeenCalledWith("remote_request", {
    machineId: machine.id,
    method: "environment.describe",
    params: { supportedProviders: REMOTE_PROVIDERS },
  });
});
const requested = (method: string) =>
  vi
    .mocked(invoke)
    .mock.calls.some(
      ([command, params]) =>
        command === "remote_request" &&
        (params as { method: string }).method === method,
    );

it("explains removal and removes the saved connection without stopping or revoking", async () => {
  await openRemove();
  expect(invoke).not.toHaveBeenCalledWith("remote_disconnect", {
    machineId: "machine",
  });
  expect(container.textContent).toContain("It does not stop the host");
  expect(container.textContent).toContain(
    "leaves this desktop’s credential valid",
  );
  expect(container.textContent).toContain(
    "~/.monocode-host/bin/monocode-host service uninstall",
  );
  await act(async () => button("Remove from this desktop only").click());
  expect(invoke).toHaveBeenCalledWith("remote_disconnect", {
    machineId: "machine",
  });
  expect(requested("devices.revokeSelf")).toBe(false);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([, params]) =>
        JSON.stringify(params ?? {}).includes('"stop"'),
      ),
  ).toBe(false);
});

it("revokes this desktop's credential before removing the connection", async () => {
  await openRemove();
  await act(async () => button("Revoke access and remove").click());
  const calls = vi
    .mocked(invoke)
    .mock.calls.map(([command, params]) =>
      command === "remote_request"
        ? (params as { method: string }).method
        : command,
    );
  expect(calls.indexOf("devices.revokeSelf")).toBeGreaterThanOrEqual(0);
  expect(calls.indexOf("remote_disconnect")).toBeGreaterThan(
    calls.indexOf("devices.revokeSelf"),
  );
  expect(container.textContent).toContain("access was revoked");
});

it("keeps the connection when the host cannot revoke its credential", async () => {
  const fallback = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, params) => {
    if (
      command === "remote_request" &&
      (params as { method: string }).method === "devices.revokeSelf"
    )
      throw "Machine is unreachable";
    return fallback(command, params);
  });
  await openRemove();
  await act(async () => button("Revoke access and remove").click());
  expect(invoke).not.toHaveBeenCalledWith("remote_disconnect", {
    machineId: "machine",
  });
  expect(container.textContent).toContain("Could not revoke access");
  expect(button("Remove from this desktop only")).toBeTruthy();
});

it("does not spellcheck or autocorrect the machine name", async () => {
  await render();
  await act(async () => button("Add machine").click());
  const name = container.querySelector<HTMLInputElement>(
    'input[placeholder="Optional, e.g. Home Mac mini"]',
  )!;
  expect(name.getAttribute("spellcheck")).toBe("false");
  expect(name.getAttribute("autocorrect")).toBe("off");
  expect(name.getAttribute("autocapitalize")).toBe("off");
  expect(container.textContent).toContain("loginctl enable-linger");
});

const AUTH_URL = "https://login.tailscale.com/a/abc123";
const ADDRESS = 'input[placeholder="user@my-mac-mini or an SSH alias"]';
const alerts = () =>
  [...container.querySelectorAll('[role="alert"]')]
    .map((node) => node.textContent)
    .join("\n");
/** A machine with its own id, because connection state outlives a test. */
const machineNamed = (id: string): RemoteMachine => ({
  ...machine,
  id,
  name: `Mac ${id}`,
});

it("shows a sign-in notice with the approval link while setup waits", async () => {
  state = { ...state, message: "Waiting for approval", authUrl: AUTH_URL };
  await start();
  expect(container.textContent).toContain("Waiting for sign-in approval");
  expect(button("Open in browser")).toBeTruthy();
  expect(button("Copy link")).toBeTruthy();
  expect(container.textContent).not.toContain(AUTH_URL);
});

it("opens the sign-in link in the browser", async () => {
  state = { ...state, authUrl: AUTH_URL };
  await start();
  await act(async () => button("Open in browser").click());
  expect(openUrl).toHaveBeenCalledTimes(1);
  expect(openUrl).toHaveBeenCalledWith(AUTH_URL);
});

it("copies the sign-in link", async () => {
  state = { ...state, authUrl: AUTH_URL };
  await start();
  await act(async () => button("Copy link").click());
  expect(copyText).toHaveBeenCalledWith(AUTH_URL);
  expect(button("Link copied")).toBeTruthy();
});

it.each([
  "javascript:alert(1)",
  "file:///etc/passwd",
  "ssh://me@home",
  "tailscale.com/a/abc",
  "data:text/html,hi",
])("never opens the non-web sign-in link %s", async (authUrl) => {
  state = { ...state, authUrl };
  await start();
  expect(container.textContent).toContain("Waiting for sign-in approval");
  expect(container.textContent).toContain("not a web address");
  expect(button("Open in browser")).toBeUndefined();
  expect(button("Copy link")).toBeUndefined();
  expect(openUrl).not.toHaveBeenCalled();
});

it("opens plain http sign-in links too", async () => {
  state = { ...state, authUrl: "http://login.example.test/a/1" };
  await start();
  await act(async () => button("Open in browser").click());
  expect(openUrl).toHaveBeenCalledWith("http://login.example.test/a/1");
});

it("keeps polling for approval and finishes by itself", async () => {
  state = { ...state, authUrl: AUTH_URL };
  await start();
  expect(container.textContent).toContain("Waiting for sign-in approval");
  machines = [machine];
  state = { ...state, authUrl: undefined, done: true, machine };
  await poll();
  expect(container.textContent).toContain("Home Mac is connected");
  expect(container.textContent).not.toContain("Waiting for sign-in approval");
});

it("never logs the sign-in link", async () => {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map(
    (method) => vi.spyOn(console, method).mockImplementation(() => {}),
  );
  state = { ...state, authUrl: AUTH_URL };
  await start();
  await act(async () => button("Open in browser").click());
  await act(async () => button("Copy link").click());
  for (const spy of spies)
    expect(JSON.stringify(spy.mock.calls)).not.toContain("abc123");
  spies.forEach((spy) => spy.mockRestore());
});

it("explains a classified setup failure with a title, a hint and the raw message", async () => {
  state = {
    ...state,
    done: true,
    error: "me@home: Permission denied (publickey).",
    errorKind: "permission-denied",
  };
  await start();
  expect(alerts()).toContain("Permission denied");
  expect(alerts()).toContain("Check that your SSH key is authorized");
  expect(alerts()).toContain("me@home: Permission denied (publickey).");
});

it("classifies a setup failure by its text when the host sent no kind", async () => {
  state = { ...state, done: true, error: "ssh: connect: Connection refused" };
  await start();
  expect(alerts()).toContain("Connection refused");
  expect(alerts()).toContain("SSH server is running");
});

it("shows an unclassified setup failure as it is, without a made-up hint", async () => {
  state = {
    ...state,
    done: true,
    error: "Host package is unavailable",
    errorKind: "unknown",
  };
  await start();
  expect(alerts()).toContain("Host package is unavailable");
  expect(alerts()).not.toContain("Connection failed");
});

it("guides sign-in and offers Reconnect when a new machine needs interactive auth", async () => {
  state = {
    ...state,
    done: true,
    error: "Interactive sign-in required",
    errorKind: "needs-interactive-auth",
  };
  await start();
  expect(alerts()).toContain("Approval needed");
  expect(alerts()).toContain("Approve the request there, then press Reconnect");
  state = { id: "setup", message: "Connecting…", done: false };
  vi.mocked(invoke).mockClear();
  const reconnect = [...container.querySelectorAll('[role="alert"] button')].find(
    (node) => node.textContent === "Reconnect",
  ) as HTMLButtonElement;
  await act(async () => reconnect.click());
  expect(invoke).toHaveBeenCalledWith("remote_ssh_begin", {
    target: "me@home",
    name: "",
    port: null,
  });
});

it("reconnects the same machine from a needs-interactive-auth failure", async () => {
  const subject = machineNamed("m-retry");
  machines = [subject];
  state = {
    ...state,
    done: true,
    error: "Interactive sign-in required",
    errorKind: "needs-interactive-auth",
  };
  await render();
  await act(async () => button("Reconnect").click());
  await poll();
  expect(alerts()).toContain("Approval needed");
  state = { id: "setup", message: "Connecting…", done: false };
  vi.mocked(invoke).mockClear();
  const again = [...container.querySelectorAll('[role="alert"] button')].find(
    (node) => node.textContent === "Reconnect",
  ) as HTMLButtonElement;
  await act(async () => again.click());
  expect(invoke).toHaveBeenCalledWith("remote_ssh_reconnect", {
    machineId: "m-retry",
  });
});

it("does not offer Reconnect for a failure that needs a change first", async () => {
  state = {
    ...state,
    done: true,
    error: "Remote host identification has changed",
    errorKind: "host-key-changed",
  };
  await start();
  expect(alerts()).toContain("Host key changed");
  expect(container.querySelector('[role="alert"] button')).toBeNull();
});

it("does not run a second poll next to the shared one", async () => {
  machines = [machineNamed("m-poll")];
  await render();
  const described = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([command, input]) =>
          command === "remote_request" &&
          (input as { method: string }).method === "environment.describe" &&
          "supportedProviders" in
            ((input as { params?: object }).params ?? {}),
      ).length;
  expect(described()).toBe(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(described()).toBe(1);
});

it.each([
  ["needs-interactive-auth", "Needs sign-in · Approval needed"],
  ["permission-denied", "Needs sign-in · Permission denied"],
  ["host-key-changed", "Error · Host key changed"],
  ["ssh-missing", "Error · OpenSSH not found"],
  ["timeout", "Offline · Machine is unreachable"],
  ["dns", "Offline · Host name not found"],
])("shows the %s state and a Reconnect button", async (kind, label) => {
  const subject = machineNamed(`m-${kind}`);
  machines = [subject];
  describeErrors[subject.id] = `[ssh:${kind}] ssh failed`;
  await render();
  expect(container.textContent).toContain(label);
  expect(button("Reconnect")).toBeTruthy();
  expect(button("Reconnect").disabled).toBe(false);
  expect(container.textContent).not.toContain("Connected");
});

it("shows the mapped hint under a machine that needs sign-in", async () => {
  const subject = machineNamed("m-hint");
  machines = [subject];
  describeErrors[subject.id] = "[ssh:needs-interactive-auth] waiting";
  await render();
  expect(container.textContent).toContain(
    "Approve the request there, then press Reconnect",
  );
});

it("lists connection details and copies diagnostics for a failing machine", async () => {
  const subject = machineNamed("m-details");
  machines = [subject];
  describeErrors[subject.id] = "[ssh:timeout] ssh: connect timed out";
  await render();
  const details = container.querySelector("details")!;
  expect(details.querySelector("summary")?.textContent).toBe("Details");
  const text = details.textContent ?? "";
  expect(text).toContain("offline");
  expect(text).toContain("Last successful contact");
  expect(text).toContain("Never");
  expect(text).toContain("Last error kind");
  expect(text).toContain("timeout");
  expect(text).toContain("Machine is unreachable");
  await act(async () => button("Copy diagnostics").click());
  const copied = vi.mocked(copyText).mock.calls[0][0];
  expect(copied).toContain("Machine: Mac m-details");
  expect(copied).toContain("Address: me@home");
  expect(copied).toContain("State: offline");
  expect(copied).toContain("Last error: timeout");
  expect(copied).toContain("Last successful contact: never");
});

it("shows the last successful contact once a machine answered", async () => {
  vi.setSystemTime(new Date("2026-03-04T05:06:07Z"));
  machines = [machineNamed("m-contact")];
  await render();
  const details = container.querySelector("details")!.textContent ?? "";
  expect(details).toContain("online");
  expect(details).not.toContain("Never");
  expect(details).toContain("None");
  await act(async () => button("Copy diagnostics").click());
  expect(vi.mocked(copyText).mock.calls[0][0]).toContain(
    "Last successful contact: 2026-03-04T05:06:07.000Z",
  );
});

it.each([
  ["-oProxyCommand=bad", "cannot start with a hyphen"],
  ["host;touch /tmp/x", "Use only letters, digits"],
  ["a@b@c", "at most one @"],
  ["a".repeat(256), "255 characters"],
])("blocks Connect for the address %j with an inline message", async (address, message) => {
  await render();
  await act(async () => button("Add machine").click());
  await fill(ADDRESS, address);
  expect(button("Connect").disabled).toBe(true);
  expect(alerts()).toContain(message);
});

it("blocks Connect for a port outside 1 to 65535", async () => {
  await render();
  await act(async () => button("Add machine").click());
  await fill(ADDRESS, "me@home");
  expect(button("Connect").disabled).toBe(false);
  await fill('input[type="number"]', "70000");
  expect(button("Connect").disabled).toBe(true);
  expect(alerts()).toContain("1 to 65535");
  await fill('input[type="number"]', "0");
  expect(button("Connect").disabled).toBe(true);
  await fill('input[type="number"]', "2222");
  expect(button("Connect").disabled).toBe(false);
  await act(async () => button("Connect").click());
  expect(invoke).toHaveBeenCalledWith("remote_ssh_begin", {
    target: "me@home",
    name: "",
    port: 2222,
  });
});

it("warns, without blocking, when the address is already connected", async () => {
  machines = [machineNamed("m-dup")];
  await render();
  await act(async () => button("Add machine").click());
  await fill(ADDRESS, "me@home");
  expect(container.textContent).toContain("Mac m-dup already uses this address");
  expect(button("Connect").disabled).toBe(false);
});

it("does not start setup from a submitted invalid address", async () => {
  await render();
  await act(async () => button("Add machine").click());
  await fill(ADDRESS, "-bad");
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(invoke).not.toHaveBeenCalledWith(
    "remote_ssh_begin",
    expect.anything(),
  );
});
