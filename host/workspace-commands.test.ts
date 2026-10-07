import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostStore } from "./store";
import { WorkspaceCommands } from "./workspace-commands";

const fixture = resolve(__dirname, "../test-fixtures/skills");
const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "monocode-wscmd-")));
  cleanups.push(dir);
  cpSync(fixture, dir, { recursive: true });
  const project = join(dir, "project");
  const home = join(dir, "home");
  const store = {
    projects: () => [{ id: "p1", cwd: project, name: "project" }],
  } as unknown as HostStore;
  const commands = new WorkspaceCommands(
    store,
    (_id, action) => action(),
    home,
  );
  return { dir, project, home, commands };
}

describe("list_skills workspace command", () => {
  it("returns skills with a revision and honors sinceRevision", async () => {
    const { project, commands } = setup();
    const result = (await commands.run("list_skills", { cwd: project })) as {
      skills: { name: string; path: string }[];
      revision: number;
    };
    expect(result.skills.map((skill) => skill.name)).toContain("demo:audit");
    expect(result.skills.map((skill) => skill.name)).toContain("ship");
    expect(Number.isSafeInteger(result.revision)).toBe(true);
    expect(
      await commands.run("list_skills", {
        cwd: project,
        sinceRevision: result.revision,
      }),
    ).toEqual({ unchanged: true, revision: result.revision });
  });

  it("rejects a cwd outside every registered project", async () => {
    const { dir, commands } = setup();
    await expect(
      commands.run("list_skills", { cwd: join(dir, "home") }),
    ).rejects.toThrow("outside");
  });
});

describe("skill root read-only allowance", () => {
  it("reads a listed skill file outside any project", async () => {
    const { home, commands } = setup();
    for (const path of [
      join(home, ".claude/skills/user-only/SKILL.md"),
      join(home, ".agents/skills/greet/SKILL.md"),
      join(home, ".claude/plugins/cache/demo/skills/audit/SKILL.md"),
    ])
      expect(await commands.run("read_text_file", { path })).toBe(
        readFileSync(path, "utf8"),
      );
    expect(
      await commands.run("read_file_preview", {
        path: join(home, ".claude/skills/user-only/SKILL.md"),
        maxLines: 2,
      }),
    ).toEqual(["---", "name: user-only"]);
  });

  it("rejects writes and deletes to a listed skill file", async () => {
    const { home, commands } = setup();
    const path = join(home, ".claude/skills/user-only/SKILL.md");
    const before = readFileSync(path, "utf8");
    await expect(
      commands.run("write_text_file", { path, content: "pwned" }),
    ).rejects.toThrow("outside");
    await expect(commands.run("delete_path", { path })).rejects.toThrow(
      "outside",
    );
    await expect(
      commands.run("rename_path", { path, name: "other.md" }),
    ).rejects.toThrow("outside");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("rejects files that the scanner does not list", async () => {
    const { home, commands } = setup();
    for (const path of [
      join(home, ".claude/settings.json"),
      join(home, ".claude/plugins/installed_plugins.json"),
      // Plugin disabled by settings, so its skills are not listed.
      join(home, ".claude/plugins/cache/off/skills/muted/SKILL.md"),
    ])
      await expect(commands.run("read_text_file", { path })).rejects.toThrow(
        "outside",
      );
  });
});
