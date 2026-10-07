// @vitest-environment happy-dom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineState } from "./connections";

const harness = vi.hoisted(() => ({
  describe: undefined as undefined | ((machineId: string) => Promise<unknown>),
  machines: [] as { id: string; name: string; endpoint: string; environmentId: string }[],
  networkChanged: undefined as undefined | (() => Promise<unknown>),
  calls: [] as string[],
  unlisten: undefined as unknown,
  focusHandler: undefined as undefined | ((event: { payload: boolean }) => void),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { machineId?: string }) => {
    harness.calls.push(command);
    if (command === "remote_request") return harness.describe!(args!.machineId!);
    if (command === "remote_machines") return harness.machines;
    if (command === "remote_network_changed")
      return harness.networkChanged ? harness.networkChanged() : undefined;
    throw new Error(`unexpected command ${command}`);
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async (handler: (event: { payload: boolean }) => void) => {
      harness.focusHandler = handler;
      return harness.unlisten;
    },
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Every watcher is released after each test, so no listener of an earlier
// module instance survives on the shared window.
let stops: (() => void)[] = [];
const loadModule = async () => {
  vi.resetModules();
  const mod = await import("./connections");
  const track = <A extends unknown[]>(watch: (...args: A) => () => void) =>
    (...args: A) => {
      const stop = watch(...args);
      stops.push(stop);
      return stop;
    };
  return {
    ...mod,
    watchMachineState: track(mod.watchMachineState),
    watchMachineStatus: track(mod.watchMachineStatus),
  };
};
// Counts of the Tauri commands the poller invoked since `harness.calls` was reset.
const networkChanges = () =>
  harness.calls.filter((call) => call === "remote_network_changed").length;
const probes = () => harness.calls.filter((call) => call === "remote_request").length;
const flush = () => vi.advanceTimersByTimeAsync(0);
const fire = (target: EventTarget, type: string) => target.dispatchEvent(new Event(type));
const deferred = () => {
  let resolve!: (value?: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const machine = (id: string) => ({ id, name: id, endpoint: "", environmentId: `env-${id}` });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  harness.calls = [];
  harness.describe = async () => ({});
  harness.machines = [];
  harness.networkChanged = undefined;
  harness.unlisten = vi.fn();
  harness.focusHandler = undefined;
});
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("polling and backoff", () => {
  it("probes immediately and reports online with a timestamp", async () => {
    const { watchMachineState, getMachineState } = await loadModule();
    const seen: MachineState[] = [];
    const stop = watchMachineState("m", (state) => seen.push(state));
    expect(probes()).toBe(1);
    expect(getMachineState("m").kind).toBe("connecting");
    await flush();
    expect(getMachineState("m")).toEqual({ kind: "online", lastOkAt: 1_000_000, lastErrorAt: undefined });
    expect(seen.map((state) => state.kind)).toEqual(["connecting", "online"]);
    stop();
  });

  it("is unknown for a machine nobody has probed", async () => {
    const { getMachineState } = await loadModule();
    expect(getMachineState("nobody")).toEqual({ kind: "unknown" });
  });

  it("polls again every 15 seconds while online", async () => {
    const { watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(probes()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(probes()).toBe(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probes()).toBe(3);
    stop();
  });

  it("backs off min(30s, 3s * 2^n) while offline", async () => {
    harness.describe = async () => {
      throw "[ssh:timeout] Machine is unreachable";
    };
    const { watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    let expected = 1;
    for (const delay of [6_000, 12_000, 24_000, 30_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(probes()).toBe(expected);
      await vi.advanceTimersByTimeAsync(1);
      expect(probes()).toBe(++expected);
    }
    stop();
  });

  it("resets the backoff when the network comes back", async () => {
    harness.describe = async () => {
      throw "[ssh:timeout] Machine is unreachable";
    };
    const { watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    await vi.advanceTimersByTimeAsync(6_000 + 12_000); // three probes, next wait is 24 s
    expect(probes()).toBe(3);
    fire(window, "online");
    await flush();
    expect(probes()).toBe(4);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(probes()).toBe(4);
    await vi.advanceTimersByTimeAsync(1); // first failure after the reset waits 6 s again
    expect(probes()).toBe(5);
    stop();
  });

  it("recovers on its own once the machine answers again", async () => {
    let up = false;
    harness.describe = async () => {
      if (!up) throw "[ssh:refused] Connection refused";
    };
    const { watchMachineState, getMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    expect(getMachineState("m").kind).toBe("offline");
    up = true;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(getMachineState("m").kind).toBe("online");
    expect(getMachineState("m").lastErrorAt).toBe(1_000_000);
    stop();
  });

  it("shares one poller between watchers", async () => {
    const { watchMachineState } = await loadModule();
    const stopA = watchMachineState("m", () => undefined);
    const stopB = watchMachineState("m", () => undefined);
    await flush();
    expect(probes()).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probes()).toBe(2);
    stopA();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probes()).toBe(3);
    stopB();
  });

  it("never overlaps probes for one machine", async () => {
    let running = 0;
    let peak = 0;
    const gates: ReturnType<typeof deferred>[] = [];
    harness.describe = async () => {
      running++;
      peak = Math.max(peak, running);
      const gate = deferred();
      gates.push(gate);
      try {
        await gate.promise;
      } finally {
        running--;
      }
    };
    const { watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    watchMachineState("m", () => undefined);
    fire(window, "focus");
    await vi.advanceTimersByTimeAsync(600);
    fire(window, "focus");
    await vi.advanceTimersByTimeAsync(600);
    fire(document, "visibilitychange");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(probes()).toBe(1);
    gates[0].resolve();
    await flush();
    expect(peak).toBe(1);
    stop();
  });

  it("probes again after a network change that arrives mid-probe", async () => {
    const gates: ReturnType<typeof deferred>[] = [];
    harness.describe = async () => {
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
    };
    const { watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    fire(window, "online");
    await flush();
    expect(probes()).toBe(1);
    gates[0].resolve();
    await flush();
    expect(probes()).toBe(2);
    gates[1].resolve();
    await flush();
    stop();
  });
});

describe("triggers", () => {
  it("focus probes once immediately even when fired three times", async () => {
    const { watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    harness.calls = [];
    fire(window, "focus");
    fire(window, "focus");
    fire(window, "focus");
    await flush();
    expect(probes()).toBe(1);
    stop();
  });

  it("three rapid focus events after a long absence invalidate once", async () => {
    const { watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    vi.setSystemTime(1_000_000 + 300_000);
    harness.calls = [];
    for (let i = 0; i < 3; i++) fire(window, "focus");
    await flush();
    expect(probes()).toBe(1);
    expect(networkChanges()).toBe(1);
    stop();
  });

  it("focus shortly after a success probes without dropping tunnels", async () => {
    const { watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    vi.setSystemTime(1_000_000 + 10_000);
    harness.calls = [];
    fire(window, "focus");
    await flush();
    expect(probes()).toBe(1);
    expect(networkChanges()).toBe(0);
    stop();
  });

  it("focus exactly at the stale threshold still keeps tunnels", async () => {
    const { watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    vi.setSystemTime(1_000_000 + 120_000);
    harness.calls = [];
    fire(window, "focus");
    await flush();
    expect(networkChanges()).toBe(0);
    stop();
  });

  it("focus after five minutes without contact drops tunnels once, then probes", async () => {
    const { watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    harness.describe = async () => {
      throw "[ssh:timeout] x"; // keep the poller from refreshing lastOkAt
    };
    vi.setSystemTime(1_000_000 + 300_000);
    harness.calls = [];
    fire(window, "focus");
    await flush();
    expect(harness.calls).toEqual(["remote_network_changed", "remote_request"]);
    stop();
  });

  it("visibility after a long absence drops tunnels; a short one does not", async () => {
    const { watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.setSystemTime(1_000_000 + 5_000);
    harness.calls = [];
    fire(document, "visibilitychange");
    await flush();
    expect(networkChanges()).toBe(0);
    expect(probes()).toBe(1);
    await vi.advanceTimersByTimeAsync(600);
    vi.setSystemTime(1_000_000 + 400_000);
    harness.describe = async () => {
      throw "[ssh:timeout] x";
    };
    harness.calls = [];
    fire(document, "visibilitychange");
    await flush();
    expect(networkChanges()).toBe(1);
    expect(probes()).toBe(1);
    stop();
  });

  it("focus on a machine that never succeeded drops tunnels", async () => {
    harness.describe = async () => {
      throw "[ssh:timeout] x";
    };
    const { watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    harness.calls = [];
    fire(window, "focus");
    await flush();
    expect(networkChanges()).toBe(1);
    expect(probes()).toBe(1);
    stop();
  });

  describe("with several machines", () => {
    // "up" answers; everything else times out.
    const watchTwo = async (up: string[]) => {
      harness.describe = async (id) => {
        if (!up.includes(id)) throw "[ssh:timeout] x";
      };
      const mod = await loadModule();
      mod.watchMachineState("a", () => undefined);
      mod.watchMachineState("b", () => undefined);
      await flush();
      return mod;
    };

    it("a fresh machine keeps tunnels even when another never came online", async () => {
      await watchTwo(["a"]);
      vi.setSystemTime(1_000_000 + 10_000);
      harness.calls = [];
      fire(window, "focus");
      await flush();
      expect(networkChanges()).toBe(0);
      expect(probes()).toBe(2);
    });

    it("a fresh machine keeps tunnels even when another was down for two days", async () => {
      await watchTwo(["a", "b"]);
      // The clock jumps two days; then only a keeps answering its poll.
      vi.setSystemTime(1_000_000 + 2 * 86_400_000);
      harness.describe = async (id) => {
        if (id === "b") throw "[ssh:timeout] x";
      };
      await vi.advanceTimersByTimeAsync(15_000);
      harness.calls = [];
      fire(window, "focus");
      await flush();
      expect(networkChanges()).toBe(0);
      expect(probes()).toBe(2);
    });

    it("drops tunnels once when every machine is stale", async () => {
      await watchTwo(["a", "b"]);
      vi.setSystemTime(1_000_000 + 300_000);
      harness.describe = async () => {
        throw "[ssh:timeout] x";
      };
      harness.calls = [];
      fire(window, "focus");
      fire(window, "focus");
      await flush();
      expect(networkChanges()).toBe(1);
      expect(probes()).toBe(2);
    });

    it("invokes at most once per burst, and never loops, when nothing was ever online", async () => {
      await watchTwo([]);
      harness.calls = [];
      for (let i = 0; i < 3; i++) fire(window, "focus");
      await flush();
      expect(networkChanges()).toBe(1);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(networkChanges()).toBe(1);
      fire(window, "focus");
      await flush();
      expect(networkChanges()).toBe(2);
    });

    it("the online event still drops tunnels while a machine is fresh", async () => {
      await watchTwo(["a"]);
      harness.calls = [];
      fire(window, "online");
      await flush();
      expect(networkChanges()).toBe(1);
      expect(probes()).toBe(2);
    });
  });

  it("the online event always drops tunnels once, even right after a success", async () => {
    const { watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    harness.calls = [];
    fire(window, "online");
    fire(window, "online");
    await flush();
    expect(networkChanges()).toBe(1);
    expect(probes()).toBe(1);
    stop();
  });

  it("probes again for a trigger after the 500 ms burst window", async () => {
    const { watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    fire(window, "focus");
    await vi.advanceTimersByTimeAsync(499);
    fire(window, "focus");
    await flush();
    expect(probes()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    fire(window, "focus");
    await flush();
    expect(probes()).toBe(3);
    stop();
  });

  it("invalidates tunnels before it probes", async () => {
    const { watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    harness.calls = [];
    fire(window, "online");
    await flush();
    expect(harness.calls).toEqual(["remote_network_changed", "remote_request"]);
    stop();
  });

  it("shows connecting while a triggered probe is in flight", async () => {
    const { watchMachineState, getMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    const gate = deferred();
    harness.describe = () => gate.promise;
    fire(window, "focus");
    await flush();
    expect(getMachineState("m").kind).toBe("connecting");
    expect(getMachineState("m").lastOkAt).toBe(1_000_000);
    gate.resolve();
    await flush();
    expect(getMachineState("m").kind).toBe("online");
    stop();
  });

  it("probes when the page becomes visible but not when it is hidden", async () => {
    const { watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    harness.calls = [];
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    fire(document, "visibilitychange");
    await flush();
    expect(probes()).toBe(0);
    visibility.mockReturnValue("visible");
    fire(document, "visibilitychange");
    await flush();
    expect(probes()).toBe(1);
    stop();
  });

  it("probes when the Tauri window gains focus, not when it loses it", async () => {
    const { watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    harness.calls = [];
    harness.focusHandler!({ payload: false });
    await flush();
    expect(probes()).toBe(0);
    harness.focusHandler!({ payload: true });
    await flush();
    expect(probes()).toBe(1);
    stop();
  });

  it("keeps probing when remote_network_changed fails", async () => {
    harness.networkChanged = async () => {
      throw new Error("Command remote_network_changed not found");
    };
    const { watchMachineState, getMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    harness.describe = async () => {
      throw "[ssh:timeout] x";
    };
    fire(window, "online");
    await flush();
    expect(getMachineState("m").kind).toBe("offline");
    stop();
  });

  it("marks machines offline on the offline event without probing", async () => {
    const { watchMachineState, getMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    harness.calls = [];
    fire(window, "offline");
    expect(getMachineState("m")).toMatchObject({
      kind: "offline",
      reason: "No network connection",
      lastOkAt: 1_000_000,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.calls).toEqual([]);
    stop();
  });

  it("ignores a probe result that was in flight when the network dropped", async () => {
    const gate = deferred();
    harness.describe = () => gate.promise;
    const { watchMachineState, getMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    fire(window, "offline");
    gate.resolve();
    await flush();
    expect(getMachineState("m").reason).toBe("No network connection");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probes()).toBe(1);
    stop();
  });

  it("resumes polling after offline then online, even inside a burst", async () => {
    const { watchMachineState, getMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    fire(window, "focus");
    fire(window, "offline");
    fire(window, "online");
    await flush();
    expect(getMachineState("m").kind).toBe("online");
    harness.calls = [];
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probes()).toBe(1);
    stop();
  });

  it("refreshes every watched machine on a trigger", async () => {
    const { watchMachineState } = await loadModule();
    const stopA = watchMachineState("a", () => undefined);
    const stopB = watchMachineState("b", () => undefined);
    await flush();
    harness.calls = [];
    fire(window, "online");
    await flush();
    expect(probes()).toBe(2);
    expect(harness.calls.filter((call) => call === "remote_network_changed")).toHaveLength(1);
    stopA();
    stopB();
  });
});

describe("error kinds", () => {
  const cases: [string, string, MachineState["kind"], boolean][] = [
    ["[ssh:needs-interactive-auth] approve", "needs-interactive-auth", "needsAuth", false],
    ["[ssh:permission-denied] no", "permission-denied", "needsAuth", false],
    ["[ssh:host-key-changed] changed", "host-key-changed", "error", false],
    ["[ssh:ssh-missing] no ssh", "ssh-missing", "error", false],
    ["[ssh:timeout] slow", "timeout", "offline", true],
    ["[ssh:dns] no host", "dns", "offline", true],
    ["[ssh:refused] closed", "refused", "offline", true],
    ["[ssh:unknown] odd", "unknown", "offline", true],
    ["Error: something strange", "unknown", "offline", true],
    ["Machine is unreachable", "timeout", "offline", true],
    ["Permission denied (publickey)", "permission-denied", "needsAuth", false],
  ];
  it.each(cases)("maps %s", async (raw, errorKind, kind, retried) => {
    harness.describe = async () => {
      throw raw;
    };
    const { watchMachineState, getMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    expect(getMachineState("m")).toMatchObject({ kind, errorKind, lastErrorAt: 1_000_000 });
    expect(getMachineState("m").reason).toBeTruthy();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(probes() > 1).toBe(retried);
    stop();
  });

  it("retries a stuck machine on the next trigger", async () => {
    harness.describe = async () => {
      throw "[ssh:host-key-changed] changed";
    };
    const { watchMachineState, getMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    harness.describe = async () => ({});
    fire(window, "focus");
    await flush();
    expect(getMachineState("m").kind).toBe("online");
    stop();
  });

  it("reconnects one machine on demand and resumes polling", async () => {
    harness.describe = async () => {
      throw "[ssh:needs-interactive-auth] approve";
    };
    const { watchMachineState, reconnectRemoteMachine } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    harness.describe = async () => ({});
    harness.calls = [];
    const state = await reconnectRemoteMachine("m");
    expect(state.kind).toBe("online");
    expect(harness.calls).toEqual(["remote_network_changed", "remote_request"]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probes()).toBe(2);
    stop();
  });

  it("reconnecting drops tunnels even right after a success", async () => {
    const { watchMachineState, reconnectRemoteMachine } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    harness.calls = [];
    await reconnectRemoteMachine("m");
    expect(networkChanges()).toBe(1);
    expect(probes()).toBe(1);
    stop();
  });

  it("keeps the last success time across failures", async () => {
    const { watchMachineState, getMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    vi.setSystemTime(1_020_000);
    harness.describe = async () => {
      throw "[ssh:timeout] x";
    };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getMachineState("m")).toMatchObject({
      kind: "offline",
      lastOkAt: 1_000_000,
      lastErrorAt: 1_035_000,
    });
    stop();
  });
});

describe("auto-connect", () => {
  it("probes every known machine as soon as the list loads, without a watcher", async () => {
    harness.machines = [machine("a"), machine("b")];
    const { remoteMachineFor, getMachineState } = await loadModule();
    await remoteMachineFor("env-a");
    await flush();
    expect(probes()).toBe(2);
    expect(getMachineState("a").kind).toBe("online");
    expect(getMachineState("b").kind).toBe("online");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reprobe machines that already have a state", async () => {
    harness.machines = [machine("a")];
    const { remoteMachineFor, watchMachineState } = await loadModule();
    watchMachineState("a", () => undefined);
    await flush();
    harness.calls = [];
    await remoteMachineFor("env-a");
    await flush();
    expect(probes()).toBe(0);
  });

  it("includes known machines when a trigger fires", async () => {
    harness.machines = [machine("a"), machine("b")];
    const { remoteMachineFor, watchMachineState } = await loadModule();
    await remoteMachineFor("env-a");
    const stop = watchMachineState("a", () => undefined);
    await flush();
    harness.calls = [];
    fire(window, "focus");
    await flush();
    expect(probes()).toBe(2);
    stop();
  });
});

describe("cleanup", () => {
  it("removes every listener and timer when the last watcher leaves", async () => {
    const addWindow = vi.spyOn(window, "addEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const addDocument = vi.spyOn(document, "addEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const { watchMachineState } = await loadModule();
    const stopA = watchMachineState("a", () => undefined);
    const stopB = watchMachineState("b", () => undefined);
    await flush();
    fire(window, "focus"); // leaves a debounce timer running
    await flush();
    const added = (spy: typeof addWindow) => spy.mock.calls.map(([type, handler]) => [type, handler]);
    expect(addWindow.mock.calls.map(([type]) => type).sort()).toEqual(["focus", "offline", "online"]);
    expect(addDocument.mock.calls.map(([type]) => type)).toEqual(["visibilitychange"]);
    stopA();
    expect(removeWindow).not.toHaveBeenCalled();
    stopB();
    stopB(); // a second call is harmless
    expect(removeWindow.mock.calls.map(([type, handler]) => [type, handler])).toEqual(
      expect.arrayContaining(added(addWindow)),
    );
    expect(removeWindow).toHaveBeenCalledTimes(3);
    expect(removeDocument.mock.calls.map(([type, handler]) => [type, handler])).toEqual(added(addDocument));
    expect(harness.unlisten).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    harness.calls = [];
    fire(window, "focus");
    fire(window, "online");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.calls).toEqual([]);
  });

  it("releases the Tauri focus listener even when unsubscribed before it registers", async () => {
    const { watchMachineState } = await loadModule();
    watchMachineState("m", () => undefined)();
    await flush();
    expect(harness.unlisten).toHaveBeenCalledTimes(1);
  });

  it("installs listeners again for a later watcher", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const { watchMachineState } = await loadModule();
    watchMachineState("m", () => undefined)();
    watchMachineState("m", () => undefined)();
    expect(add.mock.calls.filter(([type]) => type === "focus")).toHaveLength(2);
  });

  it("stops polling a machine nobody watches while another is still watched", async () => {
    const { watchMachineState } = await loadModule();
    const stopA = watchMachineState("a", () => undefined);
    const stopB = watchMachineState("b", () => undefined);
    await flush();
    stopA();
    harness.calls = [];
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probes()).toBe(1);
    stopB();
  });
});

describe("probe latency", () => {
  // Wall time and the high resolution clock are pinned apart: a probe takes
  // `rtt.ms` of the second, while every answer carries the same timestamp, so
  // a repeated state differs from the last only by what the test changes.
  const timedProbes = (rtt: { ms: number }) => {
    let clock = 5_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    harness.describe = async () => {
      clock += rtt.ms;
    };
  };

  it.each([
    [42, 40],
    [46, 50],
    [5, 10],
    [104, 100],
    [1_234, 1_230],
  ])("stores a %i ms round trip as %i ms", async (ms, bucket) => {
    timedProbes({ ms });
    const { watchMachineState, getMachineState } = await loadModule();
    watchMachineState("m", () => undefined);
    await flush();
    expect(getMachineState("m")).toMatchObject({ kind: "online", latencyMs: bucket });
  });

  it("reports no latency for an answer inside 5 ms, which rounds to nothing", async () => {
    timedProbes({ ms: 4 });
    const { watchMachineState, getMachineState } = await loadModule();
    watchMachineState("m", () => undefined);
    await flush();
    expect(getMachineState("m").kind).toBe("online");
    expect(getMachineState("m").latencyMs).toBeUndefined();
  });

  it("measures the existing probe and sends no request of its own", async () => {
    timedProbes({ ms: 42 });
    const { watchMachineState } = await loadModule();
    watchMachineState("m", () => undefined);
    await flush();
    expect(harness.calls).toEqual(["remote_request"]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(harness.calls).toEqual(["remote_request", "remote_request"]);
  });

  it("does not notify subscribers for jitter inside one 10 ms bucket", async () => {
    const rtt = { ms: 42 };
    timedProbes(rtt);
    const { watchMachineState, getMachineState } = await loadModule();
    const seen: MachineState[] = [];
    watchMachineState("m", (state) => seen.push(state));
    await flush();
    seen.length = 0;
    const settled = getMachineState("m");
    for (const ms of [44, 41, 38]) {
      rtt.ms = ms;
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(probes()).toBe(4);
    expect(seen).toEqual([]);
    expect(getMachineState("m")).toBe(settled);
  });

  it("notifies once when the round trip moves into another bucket", async () => {
    const rtt = { ms: 42 };
    timedProbes(rtt);
    const { watchMachineState, getMachineState } = await loadModule();
    const seen: MachineState[] = [];
    watchMachineState("m", (state) => seen.push(state));
    await flush();
    seen.length = 0;
    rtt.ms = 47;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(seen).toHaveLength(1);
    expect(getMachineState("m").latencyMs).toBe(50);
  });

  it.each([
    ["offline", "[ssh:timeout] slow"],
    ["needsAuth", "[ssh:needs-interactive-auth] approve"],
    ["error", "[ssh:host-key-changed] changed"],
  ])("clears the latency once the machine goes %s", async (kind, failure) => {
    timedProbes({ ms: 42 });
    const { watchMachineState, getMachineState } = await loadModule();
    watchMachineState("m", () => undefined);
    await flush();
    expect(getMachineState("m").latencyMs).toBe(40);
    harness.describe = async () => {
      throw failure;
    };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getMachineState("m").kind).toBe(kind);
    expect(getMachineState("m").latencyMs).toBeUndefined();
    expect(getMachineState("m").lastOkAt).toBe(1_000_000);
  });

  it("does not time a slow failure", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    harness.describe = async () => {
      clock += 900;
      throw "[ssh:timeout] slow";
    };
    const { watchMachineState, getMachineState } = await loadModule();
    watchMachineState("m", () => undefined);
    await flush();
    expect(getMachineState("m").kind).toBe("offline");
    expect(getMachineState("m").latencyMs).toBeUndefined();
  });

  it("clears the latency while a retry is connecting and when the network drops", async () => {
    timedProbes({ ms: 42 });
    const { watchMachineState, getMachineState } = await loadModule();
    watchMachineState("m", () => undefined);
    await flush();
    const gate = deferred();
    harness.describe = () => gate.promise;
    fire(window, "focus");
    await flush();
    expect(getMachineState("m").kind).toBe("connecting");
    expect(getMachineState("m").latencyMs).toBeUndefined();
    gate.resolve();
    await flush();
    fire(window, "offline");
    expect(getMachineState("m").kind).toBe("offline");
    expect(getMachineState("m").latencyMs).toBeUndefined();
  });

  it("has no latency when a request outside the probe reports the machine online", async () => {
    harness.describe = async () => {
      throw "[ssh:timeout] slow";
    };
    const { watchMachineState, reportRemoteMachineStatus, getMachineState } = await loadModule();
    watchMachineState("m", () => undefined);
    await flush();
    reportRemoteMachineStatus("m", true);
    expect(getMachineState("m").kind).toBe("online");
    expect(getMachineState("m").latencyMs).toBeUndefined();
  });
});

describe("watcher accounting", () => {
  it("counts the views watching a machine and releases each one once", async () => {
    const { watchMachineState, machineWatcherCount } = await loadModule();
    expect(machineWatcherCount("m")).toBe(0);
    const stopA = watchMachineState("m", () => undefined);
    const stopB = watchMachineState("m", () => undefined);
    watchMachineState("other", () => undefined);
    expect(machineWatcherCount("m")).toBe(2);
    expect(machineWatcherCount("other")).toBe(1);
    stopA();
    stopA(); // a repeated release is harmless
    expect(machineWatcherCount("m")).toBe(1);
    stopB();
    expect(machineWatcherCount("m")).toBe(0);
  });

  it("renders the state on the server, where nothing is subscribed", async () => {
    const { useRemoteMachineState } = await loadModule();
    const Probe = () => createElement("span", null, useRemoteMachineState("m").kind);
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>unknown</span>");
  });
});

describe("boolean wrappers", () => {
  it("derives the old semantics from each state", async () => {
    const { machineOnlineFromState: derive } = await loadModule();
    expect(derive({ kind: "unknown" })).toBeUndefined();
    expect(derive({ kind: "connecting" })).toBeUndefined();
    expect(derive({ kind: "online" })).toBe(true);
    for (const kind of ["offline", "error", "needsAuth"] as const)
      expect(derive({ kind })).toBe(false);
    expect(derive({ kind: "connecting", lastOkAt: 5, lastErrorAt: 3 })).toBe(true);
    expect(derive({ kind: "connecting", lastOkAt: 3, lastErrorAt: 5 })).toBe(false);
  });

  it("watchMachineStatus reports undefined, true, false in order", async () => {
    const { watchMachineStatus } = await loadModule();
    const seen: (boolean | undefined)[] = [];
    harness.describe = async () => {
      throw "[ssh:timeout] x";
    };
    const stop = watchMachineStatus("m", (online) => seen.push(online));
    await flush();
    harness.describe = async () => ({});
    await vi.advanceTimersByTimeAsync(6_000);
    expect(seen).toEqual([false, true]);
    stop();
  });

  it("reportRemoteMachineStatus drives the boolean and ignores repeats", async () => {
    const { reportRemoteMachineStatus, getMachineState, watchMachineState } = await loadModule();
    const seen: MachineState[] = [];
    const stop = watchMachineState("m", (state) => seen.push(state));
    await flush();
    seen.length = 0;
    reportRemoteMachineStatus("m", true);
    expect(seen).toEqual([]);
    reportRemoteMachineStatus("m", false);
    expect(getMachineState("m").kind).toBe("offline");
    reportRemoteMachineStatus("m", false);
    expect(seen).toHaveLength(1);
    reportRemoteMachineStatus("m", true);
    expect(getMachineState("m").kind).toBe("online");
    stop();
  });

  it("a failed report does not hide a more specific error", async () => {
    harness.describe = async () => {
      throw "[ssh:host-key-changed] x";
    };
    const { reportRemoteMachineStatus, getMachineState, watchMachineState } = await loadModule();
    const stop = watchMachineState("m", () => undefined);
    await flush();
    reportRemoteMachineStatus("m", false);
    expect(getMachineState("m")).toMatchObject({ kind: "error", errorKind: "host-key-changed" });
    stop();
  });

  it("useRemoteMachineOnline and useRemoteMachineState follow the poller", async () => {
    const { useRemoteMachineOnline, useRemoteMachineState } = await loadModule();
    const seen: { online: boolean | undefined; kind: string }[] = [];
    const Probe = ({ id }: { id?: string }) => {
      seen.push({ online: useRemoteMachineOnline(id), kind: useRemoteMachineState(id).kind });
      return null;
    };
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(createElement(Probe, { id: "m" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(seen[0]).toEqual({ online: undefined, kind: "unknown" });
    expect(seen.at(-1)).toEqual({ online: true, kind: "online" });
    await act(async () => {
      root.render(createElement(Probe, {}));
    });
    expect(seen.at(-1)).toEqual({ online: undefined, kind: "unknown" });
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
