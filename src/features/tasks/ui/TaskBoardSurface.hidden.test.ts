// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../sessions/model/session";
import { TaskBoardSurface } from "./TaskBoardSurface";

const fs = vi.hoisted(() => ({ listDir: vi.fn(async () => [] as never[]) }));
vi.mock("../model/tauriSddFs", () => ({
  tauriSddFs: { listDir: fs.listDir, readText: async () => "", statMtimes: async () => [] },
}));

const session = (id: string, busy: boolean) =>
  ({ id, cwd: "/proj", title: id, blocks: [], busy }) as unknown as Session;

let container: HTMLDivElement;
let root: Root;
let intervals: ReturnType<typeof vi.spyOn>;

async function mount(visible: boolean, busy: boolean) {
  await act(async () => {
    root.render(
      createElement(TaskBoardSurface, {
        projectCwd: "/proj",
        sessionId: "a",
        sessions: [session("a", busy)],
        visible,
      }),
    );
  });
}
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const tickTimers = () => intervals.mock.calls.filter((call) => call[1] === 1000);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  fs.listDir.mockClear();
  intervals = vi.spyOn(window, "setInterval");
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TaskBoardSurface when hidden", () => {
  it("does not poll or tick while hidden and idle", async () => {
    await mount(false, false);
    await advance(60_000);
    expect(fs.listDir).not.toHaveBeenCalled();
    expect(tickTimers()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("while hidden and busy it only keeps the slow cadence and never ticks", async () => {
    await mount(false, true);
    await advance(10_000);
    // The first load, then nothing until the 15 s hidden cadence.
    expect(fs.listDir.mock.calls.length).toBeLessThanOrEqual(1);
    await advance(30_000);
    expect(fs.listDir.mock.calls.length).toBeLessThanOrEqual(4);
    expect(tickTimers()).toHaveLength(0);
  });

  it("polls fast and ticks while visible and busy", async () => {
    await mount(true, true);
    await advance(10_000);
    expect(fs.listDir.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(tickTimers().length).toBeGreaterThan(0);
  });
});
