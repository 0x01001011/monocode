// @vitest-environment happy-dom
vi.mock("../../../integrations/harness/core/registry", () => ({
  getHarness: (id: string) =>
    id === "pi" || id === "omp"
      ? {
          commands: {
            discover: async () => [],
            rawSlashCommands: id === "omp",
          },
        }
      : undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { invalidateSkills, type Skill } from "../../skills/model/skills";
import {
  nextComposerSkillContextToken,
  useComposerSkills,
  visibleComposerSkills,
} from "./useComposerSkills";

const piSkill: Skill = {
  kind: "native",
  name: "architect",
  description: "Design first.",
  invocation: "skill:architect",
  source: "pi",
};

const cachedSkill: Skill = {
  kind: "native",
  name: "cached",
  description: "Cached current context.",
  invocation: "skill:cached",
  source: "pi",
};

describe("composer skill catalog policies", () => {
  it("uses loaded rows only for their owning context", () => {
    expect(
      visibleComposerSkills(
        { key: "pi\0/a", skills: [piSkill] },
        "pi\0/a",
        null,
        [],
      ),
    ).toEqual([piSkill]);
    expect(
      visibleComposerSkills(
        { key: "pi\0/a", skills: [piSkill] },
        "pi\0/b",
        [cachedSkill],
        [],
      ),
    ).toEqual([cachedSkill]);
  });

  it("picker open does not rescan", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    invalidateSkills();
    const listCalls = (): number =>
      vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "list_skills")
        .length;
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "list_skills" ? [] : undefined,
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    const Probe = ({ pickerOpen }: { pickerOpen: boolean }) => {
      useComposerSkills({
        harness: "claude",
        executionCwd: "/work/picker-project",
        pickerOpen,
      });
      return null;
    };
    await act(async () => {
      root.render(createElement(Probe, { pickerOpen: false }));
    });
    expect(listCalls()).toBe(1);
    await act(async () => {
      root.render(createElement(Probe, { pickerOpen: true }));
    });
    await act(async () => {
      root.render(createElement(Probe, { pickerOpen: false }));
    });
    await act(async () => {
      root.render(createElement(Probe, { pickerOpen: true }));
    });
    expect(listCalls()).toBe(1);
    act(() => root.unmount());
  });

  it("does not reuse a context token after A to B to A", () => {
    const firstA = nextComposerSkillContextToken(null, "pi\0/a");
    const sameA = nextComposerSkillContextToken(firstA, "pi\0/a");
    const b = nextComposerSkillContextToken(sameA, "pi\0/b");
    const secondA = nextComposerSkillContextToken(b, "pi\0/a");

    expect(sameA).toBe(firstA);
    expect(secondA.key).toBe(firstA.key);
    expect(secondA).not.toBe(firstA);
    expect(secondA.generation).toBeGreaterThan(firstA.generation);
  });
});
