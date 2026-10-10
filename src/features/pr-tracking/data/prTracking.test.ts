// @vitest-environment happy-dom
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrSetView, PrSummary } from "../model/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type Handler = (event: { payload: { sessionIds: string[] } }) => void;
let handlers: Handler[];
let unlisten: ReturnType<typeof vi.fn>;
let sets: Record<string, PrSetView>;
let summaries: Record<string, PrSummary>;
let version: number;

function setView(sessionId: string, refreshedAt: number): PrSetView {
  return {
    sessionId,
    entries: [],
    stacks: [],
    tracking: "full",
    status: "ok",
    refreshedAt,
  };
}

async function loadModule() {
  vi.resetModules();
  return import("./prTracking");
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function emit(sessionIds: string[]) {
  for (const h of handlers) h({ payload: { sessionIds } });
}

function calls(command: string, sessionId?: string) {
  return vi
    .mocked(invoke)
    .mock.calls.filter(
      (c) =>
        c[0] === command &&
        (sessionId === undefined ||
          (c[1] as { sessionId?: string } | undefined)?.sessionId === sessionId),
    );
}

beforeEach(() => {
  handlers = [];
  unlisten = vi.fn();
  version = 1;
  sets = { s1: setView("s1", 1), s2: setView("s2", 1) };
  summaries = {};
  vi.mocked(listen).mockReset();
  vi.mocked(listen).mockImplementation((async (_name: string, cb: Handler) => {
    handlers.push(cb);
    return () => {
      unlisten();
      handlers = handlers.filter((h) => h !== cb);
    };
  }) as never);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((async (
    command: string,
    args?: { sessionId?: string },
  ) => {
    if (command === "pr_session_set") {
      const base = sets[args!.sessionId!];
      return { ...base, refreshedAt: version };
    }
    if (command === "pr_summaries") return summaries;
    return undefined;
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mount(node: () => unknown) {
  const container = document.createElement("div");
  const root = createRoot(container);
  return { root, container, render: () => act(() => root.render(node() as never)) };
}

describe("fetch wrappers", () => {
  it("send camelCase arguments to the right commands", async () => {
    const m = await loadModule();
    await m.setPrInterest("s1", "hot");
    await m.refreshPrSet("s1");
    await m.dismissPr("s1", "acme/web", 4, true);
    await m.recordPrUrl("s1", "https://github.com/acme/web/pull/4");
    await m.recordPrHints("s1", "/work", [4, 5]);
    const sent = vi.mocked(invoke).mock.calls.map((c) => [c[0], c[1]]);
    expect(sent).toContainEqual(["pr_set_interest", { sessionId: "s1", level: "hot" }]);
    expect(sent).toContainEqual(["pr_refresh", { sessionId: "s1" }]);
    expect(sent).toContainEqual([
      "pr_dismiss",
      { sessionId: "s1", repo: "acme/web", number: 4, dismissed: true },
    ]);
    expect(sent).toContainEqual([
      "pr_record_url",
      { sessionId: "s1", url: "https://github.com/acme/web/pull/4" },
    ]);
    expect(sent).toContainEqual([
      "pr_record_hints",
      { sessionId: "s1", cwd: "/work", numbers: [4, 5] },
    ]);
  });

  it("resolves to null or void when invoke rejects, warning once per command", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(invoke).mockRejectedValue(new Error("boom"));
    const m = await loadModule();
    expect(await m.fetchPrSet("s1")).toBeNull();
    expect(await m.fetchPrSet("s1")).toBeNull();
    expect(await m.fetchPrSummaries()).toBeNull();
    await expect(m.setPrInterest("s1", "off")).resolves.toBeUndefined();
    await expect(m.refreshPrSet("s1")).resolves.toBeUndefined();
    await expect(m.dismissPr("s1", "a/b", 1, false)).resolves.toBeUndefined();
    await expect(m.recordPrUrl("s1", "u")).resolves.toBeUndefined();
    await expect(m.recordPrHints("s1", "c", [])).resolves.toBeUndefined();
    const names = warn.mock.calls.map((c) => String(c[0]));
    expect(names.filter((n) => n.includes("pr_session_set"))).toHaveLength(1);
    expect(names.filter((n) => n.includes("pr_summaries"))).toHaveLength(1);
    expect(names).toHaveLength(7);
  });
});

describe("usePrSet", () => {
  it("returns null first, then serves the cache synchronously without refetching per consumer", async () => {
    const m = await loadModule();
    const seen: (PrSetView | null)[] = [];
    function Probe({ id }: { id: string }) {
      seen.push(m.usePrSet(id));
      return null;
    }
    const a = mount(() => createElement(Probe, { id: "s1" }));
    await a.render();
    await flush();
    expect(seen[0]).toBeNull();
    expect(seen.at(-1)?.sessionId).toBe("s1");
    // The first fetch, then one recheck once the event listener is live.
    expect(calls("pr_session_set", "s1")).toHaveLength(2);
    expect(m.getPrSet("s1")?.sessionId).toBe("s1");

    // A second consumer sees the cached value on its very first render.
    const seen2: (PrSetView | null)[] = [];
    function Probe2() {
      seen2.push(m.usePrSet("s1"));
      return null;
    }
    const b = mount(() => createElement(Probe2));
    await b.render();
    expect(seen2[0]?.sessionId).toBe("s1");
    await flush();
    expect(calls("pr_session_set", "s1")).toHaveLength(2);
    act(() => {
      a.root.unmount();
      b.root.unmount();
    });
  });

  it("refetches on pr-set-changed for its own session only", async () => {
    const m = await loadModule();
    let latest: PrSetView | null = null;
    function Probe() {
      latest = m.usePrSet("s1");
      return null;
    }
    const a = mount(() => createElement(Probe));
    await a.render();
    await flush();
    const base = calls("pr_session_set").length;
    expect(latest!.refreshedAt).toBe(1);

    version = 2;
    emit(["s2"]);
    await flush();
    expect(calls("pr_session_set")).toHaveLength(base);
    expect(latest!.refreshedAt).toBe(1);

    emit(["s1", "s9"]);
    await flush();
    expect(calls("pr_session_set", "s1")).toHaveLength(base + 1);
    expect(latest!.refreshedAt).toBe(2);

    version = 3;
    emit([]);
    await flush();
    expect(calls("pr_session_set", "s1")).toHaveLength(base + 2);
    expect(latest!.refreshedAt).toBe(3);
    act(() => a.root.unmount());
  });

  it("keeps the cached view and never throws when a refetch rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const m = await loadModule();
    let latest: PrSetView | null = null;
    function Probe() {
      latest = m.usePrSet("s1");
      return null;
    }
    const a = mount(() => createElement(Probe));
    await a.render();
    await flush();
    vi.mocked(invoke).mockRejectedValue(new Error("down"));
    emit(["s1"]);
    await flush();
    expect(latest!.refreshedAt).toBe(1);
    act(() => a.root.unmount());
  });

  it("returns null without fetching for a missing session id", async () => {
    const m = await loadModule();
    let latest: PrSetView | null | undefined;
    function Probe() {
      latest = m.usePrSet(undefined);
      return null;
    }
    const a = mount(() => createElement(Probe));
    await a.render();
    await flush();
    expect(latest).toBeNull();
    expect(calls("pr_session_set")).toHaveLength(0);
    act(() => a.root.unmount());
  });

  it("refetches on next use after a gap in which events were missed", async () => {
    const m = await loadModule();
    const first = mount(() =>
      createElement(function P() {
        m.usePrSet("s1");
        return null;
      }),
    );
    await first.render();
    await flush();
    act(() => first.root.unmount());
    await flush();
    const base = calls("pr_session_set", "s1").length;
    version = 2;
    emit(["s1"]);
    await flush();
    // Nobody is watching, so no fetch yet.
    expect(calls("pr_session_set", "s1")).toHaveLength(base);

    let latest: PrSetView | null = null;
    const second = mount(() =>
      createElement(function P() {
        latest = m.usePrSet("s1");
        return null;
      }),
    );
    await second.render();
    await flush();
    expect(calls("pr_session_set", "s1").length).toBeGreaterThan(base);
    expect(latest!.refreshedAt).toBe(2);
    act(() => second.root.unmount());
  });

  it("refetches once the listener attaches, covering events sent before it", async () => {
    let attachListener: (() => void) | null = null;
    vi.mocked(listen).mockImplementation(((_name: string, cb: Handler) =>
      new Promise((resolve) => {
        attachListener = () => {
          handlers.push(cb);
          resolve(() => {
            unlisten();
            handlers = handlers.filter((h) => h !== cb);
          });
        };
      })) as never);
    const m = await loadModule();
    let latest: PrSetView | null = null;
    const a = mount(() =>
      createElement(function P() {
        latest = m.usePrSet("s1");
        return null;
      }),
    );
    await a.render();
    await flush();
    expect(calls("pr_session_set", "s1")).toHaveLength(1);
    expect(latest!.refreshedAt).toBe(1);

    // The backend changes and emits while nobody is listening yet.
    version = 2;
    emit(["s1"]);
    await act(async () => {
      attachListener!();
    });
    await flush();
    expect(calls("pr_session_set", "s1")).toHaveLength(2);
    expect(latest!.refreshedAt).toBe(2);
    act(() => a.root.unmount());
  });

  it("retries on the next subscribe after a failed first fetch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ok = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation((async (
      command: string,
      args?: unknown,
    ) => {
      if (command === "pr_session_set") throw new Error("down");
      return ok(command, args as never);
    }) as never);
    const m = await loadModule();
    const first = mount(() =>
      createElement(function P() {
        m.usePrSet("s1");
        return null;
      }),
    );
    await first.render();
    await flush();
    const failed = calls("pr_session_set", "s1").length;
    expect(failed).toBeGreaterThan(0);

    vi.mocked(invoke).mockImplementation(ok);
    let latest: PrSetView | null = null;
    const second = mount(() =>
      createElement(function P() {
        latest = m.usePrSet("s1");
        return null;
      }),
    );
    await second.render();
    await flush();
    expect(calls("pr_session_set", "s1")).toHaveLength(failed + 1);
    expect(latest!.sessionId).toBe("s1");
    act(() => {
      first.root.unmount();
      second.root.unmount();
    });
  });

  it("stops listening once the last consumer unmounts", async () => {
    const m = await loadModule();
    const a = mount(() =>
      createElement(function P() {
        m.usePrSet("s1");
        return null;
      }),
    );
    await a.render();
    await flush();
    expect(listen).toHaveBeenCalledTimes(1);
    act(() => a.root.unmount());
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("usePrSummaries", () => {
  it("loads, refetches on any pr-set-changed, and keeps a stable empty value", async () => {
    summaries = {
      s1: {
        count: 2,
        primaryNumber: 7,
        primaryState: "open",
        primaryIsDraft: false,
        attention: "block",
        stale: false,
      },
    };
    const m = await loadModule();
    const seen: Record<string, PrSummary>[] = [];
    function Probe() {
      seen.push(m.usePrSummaries());
      return null;
    }
    const a = mount(() => createElement(Probe));
    await a.render();
    expect(Object.keys(seen[0])).toEqual([]);
    await flush();
    expect(seen.at(-1)!.s1.primaryNumber).toBe(7);
    const base = calls("pr_summaries").length;

    summaries = { ...summaries, s2: { ...summaries.s1, primaryNumber: 9 } };
    emit(["s2"]);
    await flush();
    expect(calls("pr_summaries")).toHaveLength(base + 1);
    expect(seen.at(-1)!.s2.primaryNumber).toBe(9);

    // An identical payload does not produce a new reference.
    const before = seen.at(-1);
    emit([]);
    await flush();
    expect(seen.at(-1)).toBe(before);
    act(() => a.root.unmount());
  });
});

describe("dismissPr", () => {
  it("refetches the observed session after a successful dismiss", async () => {
    const m = await loadModule();
    const a = mount(() =>
      createElement(function P() {
        m.usePrSet("s1");
        return null;
      }),
    );
    await a.render();
    await flush();
    const base = calls("pr_session_set", "s1").length;
    await act(async () => {
      await m.dismissPr("s1", "acme/web", 1, true);
    });
    expect(calls("pr_session_set", "s1")).toHaveLength(base + 1);
    act(() => a.root.unmount());
  });
});
