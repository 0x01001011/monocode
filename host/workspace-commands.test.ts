import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostStore } from "./store";
import * as skills from "./skills";
import { WorkspaceCommands } from "./workspace-commands";

vi.mock("./skills", async (importOriginal) => {
  const original = await importOriginal<typeof import("./skills")>();
  return { ...original, listSkills: vi.fn(original.listSkills) };
});

const fixture = resolve(__dirname, "../test-fixtures/skills");
const cleanups: string[] = [];
afterEach(() => {
  vi.mocked(skills.listSkills).mockClear();
  for (const dir of cleanups.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function setup() {
  // `.native` expands Windows 8.3 short names (RUNNER~1), as the host's promises realpath does.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "monocode-wscmd-")));
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

describe("skill read containment", () => {
  const link = (target: string, path: string) =>
    symlinkSync(target, path, process.platform === "win32" ? "junction" : undefined);

  // A junction cannot point at a file and unprivileged Windows cannot create file symlinks,
  // so this case only runs where `symlink` can really link a file.
  it.skipIf(process.platform === "win32")("does not read a secret through a symlinked SKILL.md", async () => {
    const { dir, project, home, commands } = setup();
    mkdirSync(join(dir, "secret"));
    writeFileSync(join(dir, "secret/id_rsa"), "PRIVATE KEY");
    for (const root of [project, home]) {
      const evil = join(root, ".claude/skills/evil");
      mkdirSync(evil);
      link(join(dir, "secret/id_rsa"), join(evil, "SKILL.md"));
      await expect(
        commands.run("read_text_file", { path: join(evil, "SKILL.md") }),
      ).rejects.toThrow("outside");
      await expect(
        commands.run("read_binary_file", { path: join(evil, "SKILL.md") }),
      ).rejects.toThrow("outside");
    }
    const listed = (await commands.run("list_skills", { cwd: project })) as {
      skills: { name: string }[];
    };
    expect(listed.skills.map((skill) => skill.name)).not.toContain("evil");
  });

  it("reads a SKILL.md inside a symlinked skill folder", async () => {
    const { dir, home, commands } = setup();
    mkdirSync(join(dir, "dev/foo"), { recursive: true });
    writeFileSync(join(dir, "dev/foo/SKILL.md"), "---\nname: foo\n---\n");
    link(join(dir, "dev/foo"), join(home, ".claude/skills/foo"));
    expect(
      await commands.run("read_text_file", {
        path: join(home, ".claude/skills/foo/SKILL.md"),
      }),
    ).toBe("---\nname: foo\n---\n");
  });

  it("reads a SKILL.md under a symlinked skills root", async () => {
    const { dir, home, commands } = setup();
    mkdirSync(join(dir, "dev/shared/bar"), { recursive: true });
    writeFileSync(join(dir, "dev/shared/bar/SKILL.md"), "---\nname: bar\n---\n");
    mkdirSync(join(home, ".hermes"), { recursive: true });
    link(join(dir, "dev/shared"), join(home, ".hermes/skills"));
    expect(
      await commands.run("read_text_file", {
        path: join(home, ".hermes/skills/bar/SKILL.md"),
      }),
    ).toBe("---\nname: bar\n---\n");
  });

  it("rejects a prefix-sibling of a skills directory without scanning", async () => {
    const { home, commands } = setup();
    const evil = join(home, ".claude/skills-evil/x");
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, "SKILL.md"), "---\nname: x\n---\n");
    await expect(
      commands.run("read_text_file", { path: join(evil, "SKILL.md") }),
    ).rejects.toThrow("outside");
    expect(skills.listSkills).not.toHaveBeenCalled();
  });

  it("does not scan skills for other missing or unrelated files", async () => {
    const { project, home, commands } = setup();
    await expect(
      commands.run("read_text_file", { path: join(project, "missing.txt") }),
    ).rejects.toThrow();
    await expect(
      commands.run("read_text_file", { path: join(home, ".claude/skills/user-only/notes.md") }),
    ).rejects.toThrow("outside");
    await expect(
      commands.run("read_text_file", { path: join(project, "docs/SKILL.md") }),
    ).rejects.toThrow();
    expect(skills.listSkills).not.toHaveBeenCalled();
  });

  it("still rejects writes to a listed skill path", async () => {
    const { home, commands } = setup();
    const path = join(home, ".claude/skills/user-only/SKILL.md");
    await commands.run("read_text_file", { path });
    await expect(
      commands.run("write_text_file", { path, content: "x" }),
    ).rejects.toThrow("outside");
  });
});
