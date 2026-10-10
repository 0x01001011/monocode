// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

const { invoke, chipProps } = vi.hoisted(() => ({
  invoke: vi.fn(),
  chipProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../source-control/ui/BranchPicker", () => ({
  BranchPicker: () =>
    createElement("div", { "data-branch-trigger": "" }, "branch"),
}));
vi.mock("../../pr-tracking/ui/PrChip", () => ({
  PrChip: (props: Record<string, unknown>) => {
    chipProps.push(props);
    return createElement("span", { "data-testid": "pr-chip" });
  },
}));

let container: HTMLDivElement;
let root: Root;

async function render(props: Record<string, unknown>) {
  await act(async () => {
    root.render(
      createElement(Composer, {
        focused: true,
        harness: "claude",
        model: "claude-sonnet",
        runtimeMode: "supervised",
        hideProjectPicker: true,
        cwd: "/repo",
        executionCwd: "/repo",
        onFocus: vi.fn(),
        onCwdChange: vi.fn(),
        onModelChange: vi.fn(),
        onRuntimeModeChange: vi.fn(),
        onSubmit: vi.fn(),
        ...props,
      }),
    );
  });
}

const chip = () => container.querySelector('[data-testid="pr-chip"]');

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  chipProps.length = 0;
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("composer PR chip", () => {
  it("sits right after the branch button in a container-queried header row", async () => {
    const onOpenPrInInbox = vi.fn();
    await render({
      sessionId: "s1",
      sessionTitle: "Tasks panel audit",
      enabled: true,
      onOpenPrInInbox,
    });
    const branch = container.querySelector("[data-branch-trigger]")!;
    expect(branch.nextElementSibling).toBe(chip());
    expect(branch.parentElement!.classList).toContain("composer-head");
    expect(chipProps.at(-1)).toMatchObject({
      sessionId: "s1",
      sessionTitle: "Tasks panel audit",
      active: true,
      onOpenInbox: onOpenPrInInbox,
    });
  });

  it("renders nothing for a remote session or without a session id", async () => {
    await render({ sessionId: "s1", remoteSession: true });
    expect(chip()).toBeNull();
    await render({ sessionId: undefined });
    expect(chip()).toBeNull();
    expect(chipProps).toHaveLength(0);
  });
});
