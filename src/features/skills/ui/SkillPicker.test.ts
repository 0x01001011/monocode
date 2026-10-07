import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SkillPicker } from "./SkillPicker";
import { ompCommandsFromRpcData } from "../../../integrations/harness/providers/pi/piSkills";
import { PLAN_COMMAND } from "../../sessions/model/plan";
import { COMPACT_COMMAND } from "../../sessions/model/compact";
import { SESSION_FOLDER_COMMAND } from "../../sessions/model/sessionFolderCommand";
import type { Skill } from "../model/skills";

describe("native command picker", () => {
  it("renders native commands and argument hints alongside MonoCode shortcuts", () => {
    const native: Skill[] = ompCommandsFromRpcData({
      commands: [
        { name: "plan", source: "builtin", description: "OMP planning" },
        {
          name: "compact",
          source: "builtin",
          input: { hint: "[instructions]" },
        },
        {
          name: "workflow",
          source: "custom",
          description: "Choose planners and reviewers",
          input: { hint: "<reviewer> [path]" },
        },
        {
          name: "mcp",
          source: "builtin",
          subcommands: [{ name: "list", usage: "list --all" }],
        },
      ],
    }).map((command) => ({ ...command, kind: "native" }));
    const html = renderToStaticMarkup(
      createElement(SkillPicker, {
        skills: [
          SESSION_FOLDER_COMMAND,
          PLAN_COMMAND,
          COMPACT_COMMAND,
          ...native,
        ],
        query: "",
        active: 0,
        creating: false,
        cwd: "/repo",
        onActive: vi.fn(),
        onPick: vi.fn(),
        onStartCreate: vi.fn(),
        onCancelCreate: vi.fn(),
        onCreate: vi.fn(),
      }),
    );
    expect(html).toContain("/omp:plan");
    expect(html).toContain("/omp:compact");
    expect(html).toContain("/plan");
    expect(html).toContain("/compact");
    expect(html).toContain("/add-to-folder");
    expect(html).toContain("/workflow");
    expect(html).toContain("Choose planners and reviewers");
    expect(html).toContain("&lt;reviewer&gt; [path]");
    expect(html).toContain("omp · custom");
    expect(html).toContain("list --all");
  });
});

describe("picker notice", () => {
  const render = (notice?: string | null) =>
    renderToStaticMarkup(
      createElement(SkillPicker, {
        skills: [PLAN_COMMAND, COMPACT_COMMAND],
        query: "",
        active: 0,
        creating: false,
        cwd: "remote://env/home/me/app",
        notice,
        onActive: vi.fn(),
        onPick: vi.fn(),
        onStartCreate: vi.fn(),
        onCancelCreate: vi.fn(),
        onCreate: vi.fn(),
      }),
    );

  it("explains why a machine's skills are missing", () => {
    const html = render(
      "Update MonoCode Host in Connections settings to use this machine’s skills.",
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Update MonoCode Host");
  });

  it("shows nothing extra without a notice", () => {
    expect(render(null)).not.toContain('role="status"');
    expect(render()).not.toContain('role="status"');
  });
});
