// @vitest-environment happy-dom
// Keep this as .ts because the project test glob intentionally excludes .test.tsx.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REMOTE = "remote://env-1/home/dev/app";
const LOCAL = "/Users/dev/app";

const harness = vi.hoisted(() => ({
  remote: true,
  machines: [] as { id: string; name: string; endpoint: string; environmentId: string }[],
  enabledCalls: [] as boolean[],
  renders: 0,
  describe: undefined as undefined | ((machineId: string) => Promise<unknown>),
  reconnect: undefined as undefined | ((machineId: string) => Promise<unknown>),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { machineId?: string }) => {
    if (command === "remote_request") return harness.describe!(args!.machineId!);
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: async () => () => undefined }),
}));
vi.mock("../../features/connections/model/remoteProjects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../features/connections/model/remoteProjects")>()),
  remoteProjectFor: (path: string) =>
    harness.remote && path === "remote://env-1/home/dev/app"
      ? { key: path, environmentId: "env-1", projectId: "p1", cwd: "/home/dev/app" }
      : undefined,
}));
vi.mock("../../features/connections/model/connections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../features/connections/model/connections")>();
  return {
    ...actual,
    // The real hooks are kept; the wrappers only record how often the chip asks.
    useRemoteMachines: (enabled = true) => {
      harness.enabledCalls.push(enabled);
      return { machines: enabled ? harness.machines : [], loaded: true };
    },
    useRemoteMachineState: (machineId?: string) => {
      harness.renders++;
      return actual.useRemoteMachineState(machineId);
    },
    reconnectRemoteMachine: (machineId: string) => harness.reconnect!(machineId),
  };
});

import {
  machineWatcherCount,
  OPEN_CONNECTIONS_EVENT,
} from "../../features/connections/model/connections";
import { RemoteHostChip } from "./RemoteHostChip";
import { UsageFooter } from "./UsageFooter";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Every test gets a machine of its own, so no poller outlives the test before it.
let sequence = 0;
let machineId = "";
let container: HTMLElement;
let root: Root | undefined;
let rtt = { ms: 42 };

const fail = (reason: string) => async () => {
  throw reason;
};
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const mount = async (
  answer: (id: string) => Promise<unknown>,
  project = REMOTE,
) => {
  harness.describe = answer;
  root = createRoot(container);
  await act(async () => root!.render(createElement(RemoteHostChip, { project })));
  await settle();
};
const chip = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label^="Remote machine"]');
const reconnect = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label^="Reconnect"]');
const dot = () => container.querySelector<HTMLElement>('[data-machine-dot]');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  machineId = `machine-${++sequence}`;
  harness.remote = true;
  harness.machines = [{ id: machineId, name: "devbox", endpoint: "", environmentId: "env-1" }];
  harness.enabledCalls = [];
  harness.renders = 0;
  harness.reconnect = vi.fn(async () => ({ kind: "online" }));
  rtt = { ms: 42 };
  let clock = 5_000;
  // Wall time stands still while each answer takes `rtt.ms` of the other clock.
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  harness.describe = async () => {
    clock += rtt.ms;
  };
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// The default answer succeeds after `rtt.ms`.
const online = () => mount(harness.describe!);

describe("RemoteHostChip visibility", () => {
  it("renders nothing for a local project", async () => {
    harness.remote = false;
    await mount(harness.describe!, LOCAL);
    expect(container.innerHTML).toBe("");
  });

  it("never reads the machine list for a local project", async () => {
    harness.remote = false;
    await mount(harness.describe!, LOCAL);
    expect(harness.enabledCalls.length).toBeGreaterThan(0);
    expect(harness.enabledCalls.every((enabled) => enabled === false)).toBe(true);
    expect(machineWatcherCount(machineId)).toBe(0);
  });

  it("renders nothing when the project's machine is not connected on this computer", async () => {
    harness.machines = [];
    await mount(harness.describe!);
    expect(container.innerHTML).toBe("");
  });
});

describe("RemoteHostChip status", () => {
  it("shows the machine, Connected, the latency and a green dot once online", async () => {
    await online();
    expect(chip()).not.toBeNull();
    expect(container.textContent).toContain("devbox");
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("40 ms");
    expect(dot()!.className).toContain("bg-emerald-400");
  });

  it.each([
    ["offline", "Offline", "bg-content/35", fail("[ssh:timeout] slow")],
    ["needsAuth", "Needs sign-in", "bg-amber-400", fail("[ssh:needs-interactive-auth] approve")],
    ["error", "Error", "bg-red-400", fail("[ssh:host-key-changed] changed")],
  ] as const)("shows %s as %s with its dot", async (_kind, label, dotClass, answer) => {
    await mount(answer);
    expect(container.textContent).toContain(label);
    expect(dot()!.className).toContain(dotClass);
    expect(container.textContent).not.toContain("Connected");
  });

  it("shows Connecting with a grey dot while the first probe is out", async () => {
    await mount(() => new Promise(() => undefined));
    expect(container.textContent).toContain("Connecting");
    expect(dot()!.className).toContain("bg-content/35");
  });

  it("shows the latency only while online", async () => {
    await online();
    expect(container.textContent).toContain("40 ms");
    harness.describe = fail("[ssh:timeout] slow");
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    expect(container.textContent).toContain("Offline");
    expect(container.textContent).not.toMatch(/\d+ ms/);
  });

  it("names the machine and state for assistive technology", async () => {
    await online();
    expect(chip()!.getAttribute("aria-label")).toBe("Remote machine devbox: Connected, 40 ms");
    expect(dot()!.getAttribute("aria-hidden")).toBe("true");
  });

  it("explains the state and last contact in the title", async () => {
    await online();
    expect(chip()!.getAttribute("title")).toContain("devbox: Connected");
    harness.describe = fail("[ssh:timeout] slow");
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    const title = chip()!.getAttribute("title")!;
    expect(title).toContain("devbox: Offline");
    expect(title).toContain("Machine is unreachable");
    expect(title).toContain("Last contact");
  });

  it("says so in the title before the machine has answered", async () => {
    await mount(fail("[ssh:timeout] slow"));
    expect(chip()!.getAttribute("title")).toContain("No contact yet");
  });

  it("keeps a long machine name from pushing the footer wider", async () => {
    harness.machines[0].name = "a-very-long-machine-name.internal.example.com";
    await online();
    const name = [...container.querySelectorAll("span")].find((span) =>
      span.textContent === "a-very-long-machine-name.internal.example.com",
    );
    expect(name!.className).toContain("truncate");
  });
});

describe("RemoteHostChip actions", () => {
  it("opens the connections settings when clicked", async () => {
    await online();
    const opened = vi.fn();
    window.addEventListener(OPEN_CONNECTIONS_EVENT, opened);
    await act(async () => chip()!.click());
    window.removeEventListener(OPEN_CONNECTIONS_EVENT, opened);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["offline", fail("[ssh:timeout] slow")],
    ["needsAuth", fail("[ssh:needs-interactive-auth] approve")],
    ["error", fail("[ssh:host-key-changed] changed")],
  ] as const)("offers Reconnect when %s", async (_kind, answer) => {
    await mount(answer);
    expect(reconnect()).not.toBeNull();
    expect(reconnect()!.textContent).toBe("Reconnect");
  });

  it("offers no Reconnect while connected or connecting", async () => {
    await online();
    expect(reconnect()).toBeNull();
    await act(async () => root!.unmount());
    root = undefined;
    container.innerHTML = "";
    machineId = `machine-${++sequence}`;
    harness.machines[0].id = machineId;
    await mount(() => new Promise(() => undefined));
    expect(container.textContent).toContain("Connecting");
    expect(reconnect()).toBeNull();
  });

  it("reconnects only that machine, without opening the settings or bubbling", async () => {
    await mount(fail("[ssh:timeout] slow"));
    const opened = vi.fn();
    const bubbled = vi.fn();
    window.addEventListener(OPEN_CONNECTIONS_EVENT, opened);
    // React listens on the container itself, so a parent is where bubbling shows.
    document.body.addEventListener("click", bubbled);
    await act(async () => reconnect()!.click());
    document.body.removeEventListener("click", bubbled);
    window.removeEventListener(OPEN_CONNECTIONS_EVENT, opened);
    expect(harness.reconnect).toHaveBeenCalledTimes(1);
    expect(harness.reconnect).toHaveBeenCalledWith(machineId);
    expect(opened).not.toHaveBeenCalled();
    expect(bubbled).not.toHaveBeenCalled();
  });
});

describe("RemoteHostChip cost", () => {
  it("registers one watcher for its machine and releases it on unmount", async () => {
    expect(machineWatcherCount(machineId)).toBe(0);
    await online();
    expect(machineWatcherCount(machineId)).toBe(1);
    await act(async () => root!.unmount());
    root = undefined;
    expect(machineWatcherCount(machineId)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("adds no probe of its own: one request per poll", async () => {
    const seen: string[] = [];
    const answer = harness.describe!;
    await mount(async (id) => {
      seen.push(id);
      return answer(id);
    });
    expect(seen).toEqual([machineId]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    expect(seen).toEqual([machineId, machineId]);
  });

  it("does not re-render for latency jitter inside one 10 ms bucket", async () => {
    await online();
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    harness.renders = 0;
    for (const ms of [44, 41, 38]) {
      rtt.ms = ms;
      await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    }
    expect(harness.renders).toBe(0);
    expect(container.textContent).toContain("40 ms");
  });

  it("re-renders once when the latency moves into another bucket", async () => {
    await online();
    harness.renders = 0;
    rtt.ms = 77;
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    expect(harness.renders).toBe(1);
    expect(container.textContent).toContain("80 ms");
  });

  it("is skipped when its parent re-renders with the same project", async () => {
    await online();
    harness.renders = 0;
    await act(async () => root!.render(createElement(RemoteHostChip, { project: REMOTE })));
    expect(harness.renders).toBe(0);
  });
});

describe("UsageFooter remote host chip", () => {
  const footer = (project?: string) =>
    renderToStaticMarkup(
      createElement(UsageFooter, { providers: [], project, onNewTerminal: vi.fn() }),
    );

  it("leaves a local project's footer as it was", () => {
    harness.remote = false;
    const markup = footer(LOCAL);
    expect(markup).not.toContain("Remote machine");
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toContain(">Terminal</span>");
  });

  it("shows no chip without a project", () => {
    expect(footer(undefined)).not.toContain("Remote machine");
  });

  it("shows the chip before the terminal control for a remote project", () => {
    const markup = footer(REMOTE);
    const chipAt = markup.indexOf("Remote machine devbox");
    const terminalAt = markup.indexOf(">Terminal</span>");
    expect(chipAt).toBeGreaterThan(-1);
    expect(terminalAt).toBeGreaterThan(chipAt);
  });
});
