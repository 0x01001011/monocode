// @vitest-environment happy-dom
vi.mock("../../../integrations/harness/core/registry", () => ({
  getHarness: () => undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setRemoteCommandRunner,
  type DiscoveredSkill,
} from "../../../platform/tauri/fs";
import {
  loadDiscoveredSkills,
  loadSkills,
  recordSkillsUsedInTurn,
  saveDisabledSkillPaths,
  skillCatalogIssue,
  type FileSkill,
  type Skill,
} from "./skills";
import {
  getSkillUsage,
  resetSkillUsageForTests,
  subscribeSkillUsage,
} from "./skillUsage";

const TTL_MS = 30_000;

const remoteSkill = (
  env: string,
  name: string,
  host = `/home/me/.claude/skills/${name}/SKILL.md`,
): DiscoveredSkill => ({
  name,
  description: `${name} on ${env}`,
  path: `remote://${env}${host}`,
  scope: "user",
  source: "claude",
});

type Answer =
  | { skills: DiscoveredSkill[]; revision: number }
  | { unchanged: true; revision: number };

let runner: ReturnType<typeof vi.fn>;
const answer = (...answers: Array<Answer | Error>) => {
  for (const next of answers)
    next instanceof Error
      ? runner.mockRejectedValueOnce(next)
      : runner.mockResolvedValueOnce(next);
};
const fileNames = (skills: Skill[]) =>
  skills.filter((skill) => skill.kind === "file").map((skill) => skill.name);
const localCalls = (cmd: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === cmd).length;

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async () => []);
  runner = vi.fn();
  setRemoteCommandRunner(runner);
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("remote skill catalogs", () => {
  it("lists the machine's skills instead of collapsing to the built-in", async () => {
    answer({
      revision: 11,
      skills: [remoteSkill("env-a", "ship"), remoteSkill("env-a", "greet")],
    });
    const catalog = await loadSkills({
      harness: "claude",
      cwd: "remote://env-a/home/me/app",
    });
    expect(fileNames(catalog)).toEqual(["ship", "greet"]);
    expect(catalog.some((skill) => skill.kind === "builtin")).toBe(true);
    expect((catalog.find((s) => s.name === "ship") as FileSkill).path).toBe(
      "remote://env-a/home/me/.claude/skills/ship/SKILL.md",
    );
    expect(runner).toHaveBeenCalledWith("list_skills", {
      cwd: "remote://env-a/home/me/app",
    });
    // Remote projects are never watched, and never scanned on this computer.
    expect(localCalls("skills_watch_project")).toBe(0);
    expect(localCalls("list_skills")).toBe(0);
  });

  it("revalidates with sinceRevision after the TTL and keeps the cache when unchanged", async () => {
    vi.useFakeTimers();
    const cwd = "remote://env-a/home/me/ttl";
    const context = { harness: "claude", cwd } as const;
    answer({ revision: 5, skills: [remoteSkill("env-a", "ship")] });
    await loadSkills(context);
    await loadSkills(context);
    expect(runner).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(TTL_MS + 1);
    answer({ unchanged: true, revision: 5 });
    const again = await loadSkills(context);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner).toHaveBeenLastCalledWith("list_skills", {
      cwd,
      sinceRevision: 5,
    });
    expect(fileNames(again)).toEqual(["ship"]);

    // The unchanged answer refreshed the timestamp: no new request yet.
    vi.advanceTimersByTime(TTL_MS - 1_000);
    await loadSkills(context);
    expect(runner).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(2_000);
    answer({ revision: 6, skills: [remoteSkill("env-a", "deploy")] });
    const changed = await loadSkills(context);
    expect(runner).toHaveBeenLastCalledWith("list_skills", {
      cwd,
      sinceRevision: 5,
    });
    expect(fileNames(changed)).toEqual(["deploy"]);
  });

  it("says why a machine's skills are missing and asks again on the next open", async () => {
    const context = {
      harness: "claude",
      cwd: "remote://env-old/home/me/app",
    } as const;
    answer(
      new Error(
        "Update MonoCode Host in Connections settings to use this project’s files.",
      ),
    );
    const fallback = await loadSkills(context);
    expect(fileNames(fallback)).toEqual([]);
    expect(skillCatalogIssue(context)).toBe(
      "Update MonoCode Host in Connections settings to use this machine’s skills.",
    );

    // The host was updated: the very next load asks again, no TTL wait.
    answer({ revision: 3, skills: [remoteSkill("env-old", "ship")] });
    const fixed = await loadSkills(context);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(fileNames(fixed)).toEqual(["ship"]);
    expect(skillCatalogIssue(context)).toBeNull();
  });

  it("reports an unreachable machine's error and never flags a local project", async () => {
    const remote = { harness: "claude", cwd: "remote://env-b/home/me/x" } as const;
    answer(new Error("[ssh:timeout] Machine is unreachable."));
    await loadSkills(remote);
    expect(skillCatalogIssue(remote)).toContain("[ssh:timeout]");

    vi.mocked(invoke).mockRejectedValueOnce(new Error("boom"));
    const local = { harness: "claude", cwd: "/Users/me/local-app" } as const;
    await loadSkills(local);
    expect(skillCatalogIssue(local)).toBeNull();
  });

  it("keeps the last good catalog when the machine is unreachable", async () => {
    vi.useFakeTimers();
    const context = {
      harness: "claude",
      cwd: "remote://env-a/home/me/offline",
    } as const;
    answer({ revision: 1, skills: [remoteSkill("env-a", "ship")] });
    await loadSkills(context);

    vi.advanceTimersByTime(TTL_MS + 1);
    answer(new Error("Machine is unreachable"));
    const stale = await loadSkills(context);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(fileNames(stale)).toEqual(["ship"]);

    // The shared raw cache also serves the Skills page after a failure.
    vi.advanceTimersByTime(TTL_MS + 1);
    answer(new Error("Machine is unreachable"));
    expect(
      (await loadDiscoveredSkills(context.cwd, { refresh: true })).map(
        (skill) => skill.name,
      ),
    ).toEqual(["ship"]);
  });

  it("falls back to the built-in alone when there was never a good catalog", async () => {
    answer(new Error("Machine is unreachable"));
    const catalog = await loadSkills({
      harness: "claude",
      cwd: "remote://env-a/home/me/never",
    });
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.kind).toBe("builtin");
  });

  it("re-requests the whole list when an unchanged answer has no cache, never an empty catalog", async () => {
    const context = {
      harness: "claude",
      cwd: "remote://env-a/home/me/no-cache",
    } as const;
    answer(
      { unchanged: true, revision: 9 },
      { revision: 9, skills: [remoteSkill("env-a", "ship")] },
    );
    expect(fileNames(await loadSkills(context))).toEqual(["ship"]);
    expect(runner).toHaveBeenCalledTimes(2);
    // Both calls were full requests: nothing was cached to revalidate.
    expect(runner).toHaveBeenNthCalledWith(1, "list_skills", { cwd: context.cwd });
    expect(runner).toHaveBeenNthCalledWith(2, "list_skills", { cwd: context.cwd });

    const other = { harness: "claude", cwd: "remote://env-a/home/me/odd-host" } as const;
    answer({ unchanged: true, revision: 1 }, { unchanged: true, revision: 1 });
    const catalog = await loadSkills(other);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.kind).toBe("builtin");
  });

  it("scopes disabled skill paths to the machine that owns them", async () => {
    const hostPath = "/home/me/.claude/skills/ship/SKILL.md";
    runner.mockImplementation(async (_cmd, args: { cwd: string }) => ({
      revision: 1,
      skills: [
        remoteSkill(args.cwd.includes("env-a") ? "env-a" : "env-b", "ship"),
      ],
    }));
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "list_skills"
        ? [
            {
              name: "ship",
              description: "local",
              path: hostPath,
              scope: "user",
              source: "claude",
            },
          ]
        : undefined,
    );
    // Disabled on env-a only: the same host path elsewhere stays enabled.
    saveDisabledSkillPaths([`remote://env-a${hostPath}`]);
    const [a, b, local] = await Promise.all([
      loadSkills({ harness: "claude", cwd: "remote://env-a/home/me/scoped" }),
      loadSkills({ harness: "claude", cwd: "remote://env-b/home/me/scoped" }),
      loadSkills({ harness: "claude", cwd: "/Users/me/scoped" }),
    ]);
    expect(fileNames(a)).toEqual([]);
    expect(fileNames(b)).toEqual(["ship"]);
    expect(fileNames(local)).toEqual(["ship"]);
  });
});

describe("remote skill usage", () => {
  it("records and reads usage under the remote:// project key", async () => {
    resetSkillUsageForTests();
    const cwd = "remote://env-a/home/me/usage/";
    const snapshot = {
      usage: [{ invocation: "ship", count: 3, lastUsedAt: 9 }],
      pairs: [],
    };
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "skill_usage_snapshot" ? snapshot : undefined,
    );
    answer({ revision: 1, skills: [remoteSkill("env-a", "ship")] });
    const off = subscribeSkillUsage(cwd, () => undefined);
    await recordSkillsUsedInTurn("run /ship now", {
      harness: "claude",
      cwd,
      projectCwd: cwd,
    });
    const record = vi
      .mocked(invoke)
      .mock.calls.find(([cmd]) => cmd === "skill_usage_record");
    expect(record?.[1]).toEqual({
      projectKey: "remote://env-a/home/me/usage",
      invocations: ["ship"],
    });
    // The snapshot is read back under that same prefixed key.
    expect(getSkillUsage(cwd)?.counts.get("ship")?.count).toBe(3);
    off();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([cmd]) => cmd === "skill_usage_snapshot")
        .every(
          ([, args]) =>
            (args as { projectKey: string }).projectKey ===
            "remote://env-a/home/me/usage",
        ),
    ).toBe(true);
  });
});
