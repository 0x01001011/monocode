import {
  cpSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSkills, parseFrontmatter, type DiscoveredSkill } from "./skills";

const fixture = resolve(__dirname, "../test-fixtures/skills");
const expected = JSON.parse(
  readFileSync(join(fixture, "expected.json"), "utf8"),
) as { skills: DiscoveredSkill[] };

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A private copy of the fixture so tests can edit files. */
function copyFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "monocode-skills-")));
  cleanups.push(dir);
  cpSync(fixture, dir, { recursive: true });
  return { dir, project: join(dir, "project"), home: join(dir, "home") };
}

/** Case-insensitive file systems report `SKILL.md` for a `skill.md` file, so
 * the base name is compared without case. */
const comparable = (skills: DiscoveredSkill[]) =>
  skills.map((skill) => ({
    ...skill,
    path: skill.path.replace(/\/skill\.md$/i, "/skill.md"),
  }));

const ok = (result: ReturnType<typeof listSkills>) => {
  if ("unchanged" in result) throw new Error("expected skills");
  return result;
};

describe("listSkills", () => {
  it("matches the shared parity fixture", () => {
    const base = fixture.replace(/\\/g, "/");
    const { skills, revision } = ok(
      listSkills({
        cwd: join(fixture, "project"),
        home: join(fixture, "home"),
      }),
    );
    expect(comparable(skills)).toEqual(
      comparable(
        expected.skills.map((skill) => ({
          ...skill,
          path: `${base}/${skill.path}`,
        })),
      ),
    );
    expect(Number.isSafeInteger(revision)).toBe(true);
    expect(revision).toBeGreaterThan(0);
  });

  it("resolves same-name folders to the alphabetically first, like the desktop", () => {
    const { project, home } = copyFixture();
    for (let i = 15; i >= 0; i--) {
      const folder = `dup-${String(i).padStart(2, "0")}`;
      const dir = join(project, ".agents/skills", folder);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: shared\ndescription: From ${folder}\n---\n`,
      );
    }
    const shared = ok(listSkills({ cwd: project, home })).skills.find(
      (skill) => skill.name === "shared",
    );
    expect(shared?.description).toBe("From dup-00");
  });

  it("returns unchanged when the revision still matches", () => {
    const { project, home } = copyFixture();
    const first = ok(listSkills({ cwd: project, home }));
    expect(
      listSkills({ cwd: project, home, sinceRevision: first.revision }),
    ).toEqual({ unchanged: true, revision: first.revision });
    expect(
      ok(listSkills({ cwd: project, home, sinceRevision: first.revision + 1 }))
        .skills,
    ).toEqual(first.skills);
  });

  it("changes the revision when a skill file is added or removed", () => {
    const { project, home } = copyFixture();
    const first = ok(listSkills({ cwd: project, home }));
    const dir = join(home, ".claude/skills/fresh");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: fresh\n---\n");
    const added = ok(
      listSkills({ cwd: project, home, sinceRevision: first.revision }),
    );
    expect(added.revision).not.toBe(first.revision);
    expect(added.skills.map((skill) => skill.name)).toContain("fresh");
    rmSync(dir, { recursive: true });
    expect(ok(listSkills({ cwd: project, home })).revision).toBe(first.revision);
  });

  it("changes the revision when a description is edited at the same size", () => {
    const { project, home } = copyFixture();
    const file = join(home, ".claude/skills/user-only/SKILL.md");
    const first = ok(listSkills({ cwd: project, home }));
    const before = statSync(file);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("User scope claude", "User scope CLAUDE"),
    );
    expect(statSync(file).size).toBe(before.size);
    utimesSync(file, before.atimeMs / 1000 + 5, before.mtimeMs / 1000 + 5);
    const edited = ok(
      listSkills({ cwd: project, home, sinceRevision: first.revision }),
    );
    expect(edited.revision).not.toBe(first.revision);
    expect(
      edited.skills.find((skill) => skill.name === "user-only")?.description,
    ).toBe("User scope CLAUDE");
  });

  it("reuses parsed files whose mtime and size are unchanged", () => {
    const { project, home } = copyFixture();
    const file = join(home, ".claude/skills/user-only/SKILL.md");
    // Whole seconds survive the round trip through utimes exactly.
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    ok(listSkills({ cwd: project, home }));
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("User scope claude", "User scope CLAUDE"),
    );
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    expect(
      ok(listSkills({ cwd: project, home })).skills.find(
        (skill) => skill.name === "user-only",
      )?.description,
    ).toBe("User scope claude");
  });

  it("applies plugin enablement from user settings", () => {
    const { project, home } = copyFixture();
    writeFileSync(
      join(home, ".claude/settings.json"),
      JSON.stringify({ enabledPlugins: { "off@market": true } }),
    );
    const names = ok(listSkills({ cwd: project, home })).skills.map(
      (skill) => skill.name,
    );
    expect(names).toContain("off:muted");
    expect(names).toContain("demo:audit");
  });

  it("falls back to an empty list when no roots exist", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "monocode-skills-")));
    cleanups.push(dir);
    expect(
      ok(listSkills({ cwd: join(dir, "p"), home: join(dir, "h") })).skills,
    ).toEqual([]);
  });
});

describe("symlink containment", () => {
  const link = (target: string, path: string) =>
    symlinkSync(target, path, process.platform === "win32" ? "junction" : undefined);
  const names = (project: string, home: string) =>
    ok(listSkills({ cwd: project, home })).skills.map((skill) => skill.name);

  it("does not list a SKILL.md symlinked to a non-skill file", () => {
    const { dir, project, home } = copyFixture();
    mkdirSync(join(dir, "secret"));
    writeFileSync(join(dir, "secret/id_rsa"), "name: stolen\ndescription: private key\n");
    const evil = join(project, ".claude/skills/evil");
    mkdirSync(evil);
    link(join(dir, "secret/id_rsa"), join(evil, "SKILL.md"));
    const listed = ok(listSkills({ cwd: project, home })).skills;
    expect(listed.map((skill) => skill.name)).not.toContain("evil");
    expect(listed.map((skill) => skill.name)).not.toContain("stolen");
    expect(listed.map((skill) => skill.description)).not.toContain("private key");
  });

  it("still lists a symlinked skill folder that holds a real SKILL.md", () => {
    const { dir, project, home } = copyFixture();
    mkdirSync(join(dir, "dev/foo"), { recursive: true });
    writeFileSync(join(dir, "dev/foo/SKILL.md"), "---\nname: foo\ndescription: Linked\n---\n");
    link(join(dir, "dev/foo"), join(home, ".claude/skills/foo"));
    const found = ok(listSkills({ cwd: project, home })).skills.find(
      (skill) => skill.name === "foo",
    );
    // Catalog paths use forward slashes on every platform.
    expect(found?.path).toBe(
      join(home, ".claude/skills/foo/SKILL.md").replace(/\\/g, "/"),
    );
  });

  it("lists skills under a symlinked skills root by the same rule", () => {
    const { dir, project, home } = copyFixture();
    mkdirSync(join(dir, "dev/shared/bar"), { recursive: true });
    writeFileSync(join(dir, "dev/shared/bar/SKILL.md"), "---\nname: bar\n---\n");
    mkdirSync(join(dir, "dev/shared/baz"));
    writeFileSync(join(dir, "secret.txt"), "name: baz\n");
    link(join(dir, "secret.txt"), join(dir, "dev/shared/baz/SKILL.md"));
    mkdirSync(join(home, ".hermes"), { recursive: true });
    link(join(dir, "dev/shared"), join(home, ".hermes/skills"));
    expect(names(project, home)).toContain("bar");
    expect(names(project, home)).not.toContain("baz");
  });
});

describe("parseFrontmatter", () => {
  it("reads CRLF frontmatter with a folded description", () => {
    expect(
      parseFrontmatter(
        "---\r\nname: crlf-skill\r\ndescription: >\r\n  One\r\n  two\r\n---\r\nbody\r\n",
        "fallback",
      ),
    ).toEqual({ name: "crlf-skill", description: "One two" });
  });

  it("ignores leading byte order marks", () => {
    expect(
      parseFrontmatter("\uFEFF---\nname: bom-skill\ndescription: Hi\n---\n", "fallback"),
    ).toEqual({ name: "bom-skill", description: "Hi" });
  });

  it("reads to the end when the frontmatter is never closed", () => {
    expect(
      parseFrontmatter("---\nname: open-ended\ndescription: Still read\n", "fallback"),
    ).toEqual({ name: "open-ended", description: "Still read" });
  });
});
