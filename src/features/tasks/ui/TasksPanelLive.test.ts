// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoard } from "../hooks/useTaskBoard";
import { TasksPanelLive } from "./TasksPanelLive";

const seen: number[] = [];
vi.mock("./TasksPanel", () => ({
  TasksPanel: ({ now }: { now: number }) => {
    seen.push(now);
    return null;
  },
}));

const T0 = 1_700_000_000_000;
const board: TaskBoard = {
  sections: [],
  statusCard: { kind: "idle", headline: "", actions: [] },
  workspaces: [],
  selectWorkspace: () => {},
  loading: false,
  loaded: true,
};

let container: HTMLDivElement;
let root: Root;

function render(running: boolean) {
  act(() => root.render(createElement(TasksPanelLive, { board, running })));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  seen.length = 0;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TasksPanelLive", () => {
  it("ticks the panel clock every second while running", () => {
    render(true);
    expect(seen.at(-1)).toBe(T0);
    act(() => void vi.advanceTimersByTime(3_000));
    expect(seen.at(-1)).toBe(T0 + 3_000);
  });

  it("sets no timer when nothing is running", () => {
    render(false);
    expect(vi.getTimerCount()).toBe(0);
    const renders = seen.length;
    act(() => void vi.advanceTimersByTime(5_000));
    expect(seen.length).toBe(renders);
  });

  it("stops the timer when the work finishes and on unmount", () => {
    render(true);
    expect(vi.getTimerCount()).toBe(1);
    render(false);
    expect(vi.getTimerCount()).toBe(0);
    render(true);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});
