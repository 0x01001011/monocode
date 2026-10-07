// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../../skills/model/skills";
import { resetSkillUsageForTests } from "../../skills/model/skillUsage";
import { Composer } from "./Composer";

const { invoke, skillInputs } = vi.hoisted(() => ({
  invoke: vi.fn(),
  skillInputs: [] as Array<{
    harness: string;
    executionCwd: string;
    pickerOpen: boolean;
  }>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("./useComposerSkills", () => ({
  useComposerSkills: (input: (typeof skillInputs)[number]) => {
    skillInputs.push(input);
    const skills: Skill[] = [
      {
        kind: "file",
        name: "ship-it",
        description: "Ship the change",
        invocation: "ship-it",
        path: "remote://env/home/me/.claude/skills/ship-it/SKILL.md",
        scope: "user",
        source: "claude",
      },
      {
        kind: "builtin",
        name: "create-skill",
        description: "Create a skill",
        invocation: "create-skill",
        scope: "builtin",
        source: "monocode",
      },
    ];
    return {
      contextKey: "claude:x",
      contextToken: { key: "claude:x", generation: 0 },
      isCurrent: () => true,
      refresh: async () => skills,
      skills,
    };
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
        hideBranchPicker: true,
        hideTopBar: true,
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

async function openPicker() {
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    textarea.value = "/";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  skillInputs.length = 0;
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

describe("composer skills for remote sessions", () => {
  it("gives a remote session's skill picker the remote cwd", async () => {
    await render({
      remoteSession: true,
      remoteFeatures: { attachments: false, plan: true, draft: false },
      executionCwd: "remote://env/home/me/app",
    });
    await openPicker();
    expect(skillInputs.length).toBeGreaterThan(0);
    expect(
      skillInputs.every((input) => input.executionCwd === "remote://env/home/me/app"),
    ).toBe(true);
    const text = container.textContent ?? "";
    expect(text).toContain("ship-it");
    // Only the machine's own file skills join /plan and /compact.
    expect(text).not.toContain("create-skill");
  });

  const snapshotKeys = () =>
    invoke.mock.calls
      .filter(([command]) => command === "skill_usage_snapshot")
      .map(([, args]) => (args as { projectKey: string }).projectKey);
  const flush = () =>
    act(async () => {
      for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    });

  it("ranks a worktree session's picker with its project's usage", async () => {
    resetSkillUsageForTests();
    await render({ cwd: "/repo", executionCwd: "/repo-worktrees/feature" });
    await openPicker();
    await flush();
    // Backfilled history and live records are both keyed by the project root.
    expect(snapshotKeys()).toEqual(["/repo"]);
    // The catalog still comes from the worktree.
    expect(
      skillInputs.every((input) => input.executionCwd === "/repo-worktrees/feature"),
    ).toBe(true);
  });

  it("ranks a remote worktree session's picker with its remote project's usage", async () => {
    resetSkillUsageForTests();
    await render({
      remoteSession: true,
      remoteFeatures: { attachments: false, plan: true, draft: false },
      cwd: "remote://env/home/me/app",
      executionCwd: "remote://env/home/me/app-worktrees/feature",
    });
    await openPicker();
    await flush();
    expect(snapshotKeys()).toEqual(["remote://env/home/me/app"]);
  });

  it("keeps a local session on its own cwd", async () => {
    await render({ executionCwd: "/repo" });
    await openPicker();
    expect(skillInputs.every((input) => input.executionCwd === "/repo")).toBe(true);
    expect(container.textContent).toContain("create-skill");
  });
});
