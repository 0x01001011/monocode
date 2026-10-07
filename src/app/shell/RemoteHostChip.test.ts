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
  /** Answers `host.metrics`; by default the host predates it. */
  metrics: undefined as undefined | ((machineId: string) => Promise<unknown>),
  metricsCalls: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { machineId?: string; method?: string }) => {
    if (command === "remote_request" && args?.method === "host.metrics") {
      harness.metricsCalls++;
      return harness.metrics!(args.machineId!);
    }
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
  harness.metricsCalls = 0;
  harness.metrics = async () => {
    throw new Error("Unsupported host method");
  };
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
  it("registers its watchers for its machine and releases them on unmount", async () => {
    expect(machineWatcherCount(machineId)).toBe(0);
    await online();
    // The chip and its load readings; both share the machine's one poller.
    expect(machineWatcherCount(machineId)).toBe(2);
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

const reading = (overrides: Record<string, unknown> = {}) => ({
  sampledAt: 1,
  cpu: { percent: 34, cores: 8 },
  memory: { usedBytes: 10 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
  disk: { path: "/home/k", usedBytes: 100 * 1024 ** 3, totalBytes: 400 * 1024 ** 3 },
  temperatureC: { cpu: 52, gpu: 64 },
  gpus: [
    {
      name: "RTX 4090",
      percent: 71,
      memoryUsedBytes: 12 * 1024 ** 3,
      memoryTotalBytes: 24 * 1024 ** 3,
      temperatureC: 64,
    },
  ],
  ...overrides,
});
const loadText = () =>
  container.querySelector("[data-host-load]")?.textContent ?? "";

describe("RemoteHostChip load", () => {
  it("shows the summary of what the machine reports", async () => {
    harness.metrics = async () => reading();
    await online();
    expect(loadText()).toBe("CPU 34%GPU 71%MEM 63%");
    expect(chip()!.getAttribute("aria-label")).toContain("CPU 34%, GPU 71%, MEM 63%");
  });

  it("leaves out metrics the machine cannot report", async () => {
    harness.metrics = async () => reading({ gpus: undefined, cpu: undefined });
    await online();
    expect(loadText()).toBe("MEM 63%");
  });

  it("shows no load and still opens Connections on an older host", async () => {
    await online();
    expect(container.querySelector("[data-host-load]")).toBeNull();
    const opened = vi.fn();
    window.addEventListener(OPEN_CONNECTIONS_EVENT, opened);
    await act(async () => chip()!.click());
    window.removeEventListener(OPEN_CONNECTIONS_EVENT, opened);
    expect(opened).toHaveBeenCalledTimes(1);
    // One refusal is enough; the older host is not asked again.
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(harness.metricsCalls).toBe(1);
  });

  it("asks only while a remote project is open, and not while offline", async () => {
    harness.remote = false;
    await mount(harness.describe!, LOCAL);
    expect(harness.metricsCalls).toBe(0);
    await act(async () => root!.unmount());
    root = undefined;
    harness.metrics = async () => reading();
    await mount(fail("[ssh:timeout] slow"));
    expect(harness.metricsCalls).toBe(0);
  });

  it("polls every 10 s and stays quiet when the values are unchanged", async () => {
    harness.metrics = async () => reading();
    await online();
    harness.renders = 0;
    const before = harness.metricsCalls;
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(harness.metricsCalls - before).toBe(3);
    expect(loadText()).toBe("CPU 34%GPU 71%MEM 63%");
  });

  it("opens a popover with every metric and refreshes faster while it is open", async () => {
    harness.metrics = async () => reading();
    await online();
    await act(async () => chip()!.click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const text = dialog!.textContent ?? "";
    for (const part of [
      "CPU",
      "34% · 8 cores",
      "CPU temp",
      "52°C",
      "Memory",
      "10.0 GB / 16.0 GB",
      "RTX 4090",
      "71% · 12.0 GB / 24.0 GB · 64°C",
      "Disk",
      "300.0 GB free",
      "Connection settings",
    ])
      expect(text).toContain(part);
    const before = harness.metricsCalls;
    await act(async () => void (await vi.advanceTimersByTimeAsync(9_000)));
    expect(harness.metricsCalls - before).toBeGreaterThanOrEqual(3);
    await act(async () => chip()!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("marks the reading out of date when readings stop arriving", async () => {
    let fails = false;
    harness.metrics = async () => {
      if (fails) throw new Error("slow");
      return reading();
    };
    await online();
    fails = true;
    await act(async () => void (await vi.advanceTimersByTimeAsync(31_000)));
    expect(container.querySelector("[data-host-load]")!.className).toContain("opacity-50");
    // After three failures it stops asking.
    const stopped = harness.metricsCalls;
    await act(async () => void (await vi.advanceTimersByTimeAsync(120_000)));
    expect(harness.metricsCalls).toBe(stopped);
  });

  it("releases every timer on unmount", async () => {
    harness.metrics = async () => reading();
    await online();
    await act(async () => root!.unmount());
    root = undefined;
    expect(vi.getTimerCount()).toBe(0);
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
