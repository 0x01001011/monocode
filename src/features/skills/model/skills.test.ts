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
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pairKey,
  resetSkillUsageForTests,
  type SkillUsage,
} from "./skillUsage";
import {
  BUILTIN_CREATE_SKILL,
  applySkillsToTurn,
  blankSkillMarkdown,
  injectSkillPrompt,
  invalidateSkills,
  isValidSkillName,
  isNativeCommandPrompt,
  loadSkills,
  mergeCatalog,
  recordSkillsUsedInTurn,
  onSkillsChanged,
  rankSkills,
  replaceSlashToken,
  skillNamesInText,
  skillTextParts,
  slashTokenAt,
  slugSkillName,
  type Skill,
} from "./skills";

describe("native command composer behavior", () => {
  it("filters commands by alias and inserts their invocation with arguments intact", () => {
    const workflow: Skill = {
      kind: "native",
      source: "omp",
      name: "orchestrate",
      invocation: "orchestrate",
      description: "Choose agents",
      aliases: ["review"],
    };
    expect(rankSkills([workflow], "review")).toEqual([workflow]);
    const text = "/rev foo";
    expect(
      replaceSlashToken(
        text,
        slashTokenAt(text, 4, true)!,
        workflow.invocation,
      ),
    ).toBe("/orchestrate foo");
    expect(slashTokenAt("/Review_Code", 12, true)?.query).toBe("Review_Code");
    expect(slashTokenAt("/Review_Code", 12)).toBeNull();
  });

  it("only treats leading command tokens as native invocations", () => {
    expect(isNativeCommandPrompt("/workflow foo @README.md", "omp")).toBe(true);
    expect(isNativeCommandPrompt("/omp:plan investigate", "omp")).toBe(true);
    for (const text of [
      "Explain /workflow",
      "> /workflow",
      "/tmp/file.ts",
      "/tmp\\file.ts",
      "hello",
    ]) {
      expect(isNativeCommandPrompt(text, "omp")).toBe(false);
    }
    expect(isNativeCommandPrompt("/review foo", "claude")).toBe(false);
  });
});

const review: Skill = {
  kind: "file",
  name: "review-pr",
  description: "Review pull requests against team standards.",
  invocation: "review-pr",
  path: "/tmp/.agents/skills/review-pr/SKILL.md",
  scope: "project",
  source: "agents",
};

const native: Skill = {
  kind: "file",
  name: "cursor-only",
  description: "Cursor native helper",
  invocation: "cursor-only",
  path: "/tmp/.cursor/skills/cursor-only/SKILL.md",
  scope: "project",
  source: "cursor",
};

const piNative: Skill = {
  kind: "native",
  name: "architect",
  description: "Design before implementation.",
  invocation: "skill:architect",
  source: "pi",
};

const piFile: Skill = {
  kind: "file",
  name: "pi-file",
  description: "A file discovered by the existing scanner.",
  invocation: "pi-file",
  path: "/tmp/.pi/skills/pi-file/SKILL.md",
  scope: "project",
  source: "pi",
};

describe("slashTokenAt", () => {
  it("reads the /token the cursor is in", () => {
    expect(slashTokenAt("/cre", 4)).toEqual({
      start: 0,
      end: 4,
      query: "cre",
    });
    expect(slashTokenAt("please /rev", 11)).toEqual({
      start: 7,
      end: 11,
      query: "rev",
    });
    expect(slashTokenAt("/skill:arch", 11)).toEqual({
      start: 0,
      end: 11,
      query: "skill:arch",
    });
  });

  it("ignores URLs and paths", () => {
    expect(slashTokenAt("https://example.com", 12)).toBeNull();
    expect(slashTokenAt("/Users/me", 4)).toBeNull();
    expect(slashTokenAt("foo/bar", 4)).toBeNull();
  });

  it("closes after a space", () => {
    expect(slashTokenAt("/review-pr now", 14)).toBeNull();
  });
});

describe("replaceSlashToken", () => {
  it("inserts an exact invocation and a trailing space", () => {
    expect(
      replaceSlashToken(
        "/cre",
        { start: 0, end: 4, query: "cre" },
        "create-skill",
      ),
    ).toBe("/create-skill ");
    expect(
      replaceSlashToken(
        "x /r y",
        { start: 2, end: 4, query: "r" },
        "review-pr",
      ),
    ).toBe("x /review-pr y");
    expect(
      replaceSlashToken(
        "/arch",
        { start: 0, end: 5, query: "arch" },
        "skill:architect",
      ),
    ).toBe("/skill:architect ");
  });
});

describe("skillNamesInText", () => {
  it("collects unique /skill tokens", () => {
    expect(skillNamesInText("/create-skill write a deploy skill")).toEqual([
      "create-skill",
    ]);
    expect(skillNamesInText("/review-pr /create-skill /review-pr")).toEqual([
      "review-pr",
      "create-skill",
    ]);
    expect(skillNamesInText("path /tmp/foo")).toEqual([]);
  });
});

describe("skillTextParts", () => {
  const names = new Set(["review-pr", "create-skill", "skill:architect"]);

  it("marks known /skill tokens", () => {
    expect(skillTextParts("/review-pr look at auth", names)).toEqual([
      { text: "/review-pr", skill: true },
      { text: " look at auth", skill: false },
    ]);
  });

  it("marks a known namespaced invocation", () => {
    expect(skillTextParts("/skill:architect inspect this", names)).toEqual([
      { text: "/skill:architect", skill: true },
      { text: " inspect this", skill: false },
    ]);
  });

  it("leaves unknown /tokens as plain text", () => {
    expect(skillTextParts("see /not-a-skill please", names)).toEqual([
      { text: "see /not-a-skill please", skill: false },
    ]);
  });

  it("splits multiple skills", () => {
    expect(skillTextParts("/review-pr then /create-skill", names)).toEqual([
      { text: "/review-pr", skill: true },
      { text: " then ", skill: false },
      { text: "/create-skill", skill: true },
    ]);
  });

  it("ignores skill tokens inside Markdown blockquotes", () => {
    const text = "/review-pr\n> /create-skill\n  > /review-pr";
    expect(slashTokenAt(text, text.indexOf("/create-skill") + 3)).toBeNull();
    expect(skillNamesInText(text)).toEqual(["review-pr"]);
    expect(
      skillTextParts(text, names)
        .filter((part) => part.skill)
        .map((part) => part.text),
    ).toEqual(["/review-pr"]);
  });
});

describe("applySkillsToTurn", () => {
  it("leaves Pi-native skill commands unchanged", async () => {
    await expect(
      applySkillsToTurn("/skill:architect inspect this", {
        harness: "pi",
        cwd: "/repo",
      }),
    ).resolves.toBe("/skill:architect inspect this");
  });
});

describe("injectSkillPrompt", () => {
  it("prefixes invoked skill bodies and keeps the user text", () => {
    const out = injectSkillPrompt("/review-pr look at auth", [review], {
      "review-pr": "# Review\n\nBe strict.",
    });
    expect(out).toContain("## /review-pr");
    expect(out).toContain("Be strict.");
    expect(out.endsWith("/review-pr look at auth")).toBe(true);
  });

  it("returns the original text when nothing matches", () => {
    expect(injectSkillPrompt("hello", [], {})).toBe("hello");
  });
});

describe("mergeCatalog", () => {
  it("lets .agents win, then MonoCode create-skill, then provider skills", () => {
    const catalog = mergeCatalog([
      {
        name: "review-pr",
        description: "from agents",
        path: "/p/.agents/skills/review-pr/SKILL.md",
        scope: "project",
        source: "agents",
      },
      {
        name: "review-pr",
        description: "from claude",
        path: "/p/.claude/skills/review-pr/SKILL.md",
        scope: "project",
        source: "claude",
      },
      {
        name: "create-skill",
        description: "claude native",
        path: "/home/.claude/skills/create-skill/SKILL.md",
        scope: "user",
        source: "claude",
      },
      {
        name: "cursor-only",
        description: "native",
        path: "/p/.cursor/skills/cursor-only/SKILL.md",
        scope: "project",
        source: "cursor",
      },
    ]);
    expect(catalog.find((s) => s.name === "review-pr")?.description).toBe(
      "from agents",
    );
    expect(catalog.find((s) => s.name === "create-skill")).toEqual(
      BUILTIN_CREATE_SKILL,
    );
    expect(catalog.find((s) => s.name === "cursor-only")?.source).toBe(
      "cursor",
    );
  });
});

describe("rankSkills", () => {
  it("puts create-skill first when the query is empty", () => {
    const ranked = rankSkills([native, review, BUILTIN_CREATE_SKILL], "");
    expect(ranked.map((s) => s.name)).toEqual([
      "create-skill",
      "cursor-only",
      "review-pr",
    ]);
  });

  it("fuzzy-matches names ahead of descriptions", () => {
    const ranked = rankSkills([native, review, BUILTIN_CREATE_SKILL], "rev");
    expect(ranked[0]?.name).toBe("review-pr");
  });

  it("ranks native Pi rows with project skills", () => {
    const ranked = rankSkills([review, piNative, piFile], "");
    expect(ranked.map((skill) => skill.name)).toEqual([
      "architect",
      "pi-file",
      "review-pr",
    ]);
  });

  it("matches the displayed invocation", () => {
    expect(rankSkills([review, piNative], "skill")).toEqual([piNative]);
    expect(rankSkills([review, piNative], "skill:arch")).toEqual([piNative]);
  });

  it("gives the built-in row its exact invocation", () => {
    expect(BUILTIN_CREATE_SKILL.invocation).toBe("create-skill");
  });

  it("keeps every Pi result when the composer removes the default cap", () => {
    const rows: Skill[] = Array.from({ length: 75 }, (_, index) => ({
      kind: "native",
      name: `skill-${String(index).padStart(2, "0")}`,
      description: "Pi skill",
      invocation: `skill:skill-${String(index).padStart(2, "0")}`,
      source: "pi",
    }));

    expect(rankSkills(rows, "")).toHaveLength(50);
    expect(rankSkills(rows, "", Number.POSITIVE_INFINITY)).toHaveLength(75);
    expect(
      rankSkills(rows, "skill-74", Number.POSITIVE_INFINITY)[0]?.name,
    ).toBe("skill-74");
  });
});

describe("skill names", () => {
  it("slugs and validates", () => {
    expect(slugSkillName("Review PR")).toBe("review-pr");
    expect(isValidSkillName("review-pr")).toBe(true);
    expect(isValidSkillName("Review")).toBe(false);
    expect(isValidSkillName("-nope")).toBe(false);
  });

  it("writes a starter SKILL.md", () => {
    const md = blankSkillMarkdown("review-pr");
    expect(md).toContain("name: review-pr");
    expect(md).toContain("# Review Pr");
  });
});

describe("skills-changed event", () => {
  it("skills-changed invalidates cache", async () => {
    let handler:
      ((event: { payload: { revision: number } }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (_name, cb) => {
      handler = cb as typeof handler;
      return () => undefined;
    });
    const listCalls = (): number =>
      vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "list_skills")
        .length;
    vi.mocked(invoke).mockImplementation(async () => []);
    invalidateSkills();
    const context = { harness: "claude", cwd: "/work/cache-project" } as const;

    const seen: number[] = [];
    const off = await onSkillsChanged((revision) => seen.push(revision));
    await loadSkills(context);
    await loadSkills(context);
    expect(listCalls()).toBe(1);

    handler?.({ payload: { revision: 7 } });
    expect(seen).toEqual([7]);
    await loadSkills(context);
    expect(listCalls()).toBe(2);

    off();
    handler?.({ payload: { revision: 8 } });
    expect(seen).toEqual([7]);
  });
});

describe("unwatched project fallback", () => {
  const TTL_MS = 30_000;
  const calls = (cmd: string): number =>
    vi.mocked(invoke).mock.calls.filter(([name]) => name === cmd).length;
  const mockBackend = (watch: () => Promise<boolean> | boolean) => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "skills_watch_project" ? watch() : [],
    );
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refetches an unwatched project's catalog after the TTL", async () => {
    vi.useFakeTimers();
    mockBackend(() => false);
    const context = { harness: "claude", cwd: "/work/unwatched-ttl" } as const;
    await loadSkills(context);
    await loadSkills(context);
    expect(calls("list_skills")).toBe(1);

    vi.advanceTimersByTime(TTL_MS + 1);
    await loadSkills(context);
    expect(calls("list_skills")).toBe(2);
  });

  it("keeps a watched project's catalog cached past the TTL", async () => {
    vi.useFakeTimers();
    mockBackend(() => true);
    const context = { harness: "claude", cwd: "/work/watched-ttl" } as const;
    await loadSkills(context);
    vi.advanceTimersByTime(TTL_MS * 10);
    await loadSkills(context);
    expect(calls("list_skills")).toBe(1);
    expect(calls("skills_watch_project")).toBe(1);
  });

  it("retries registration after a failed watch invoke", async () => {
    let attempt = 0;
    mockBackend(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("watcher down");
      return true;
    });
    const context = { harness: "claude", cwd: "/work/watch-retry" } as const;
    await loadSkills(context);
    expect(calls("skills_watch_project")).toBe(1);

    await loadSkills(context, { refresh: true });
    expect(calls("skills_watch_project")).toBe(2);

    await loadSkills(context, { refresh: true });
    expect(calls("skills_watch_project")).toBe(2);
  });
});

describe("rankSkills with usage", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_800_000_000_000;
  const file = (name: string, description = "A skill."): Skill => ({
    kind: "file",
    name,
    description,
    invocation: name,
    path: `/tmp/.agents/skills/${name}/SKILL.md`,
    scope: "project",
    source: "agents",
  });
  const usageOf = (
    counts: Record<string, [number, number]>,
    pairs: Record<string, number> = {},
  ): SkillUsage => ({
    counts: new Map(
      Object.entries(counts).map(([name, [count, lastUsedAt]]) => [
        name,
        { count, lastUsedAt },
      ]),
    ),
    pairs: new Map(Object.entries(pairs)),
  });

  it("matches the static order when usage is absent or empty", () => {
    const rows = [review, native, piFile, BUILTIN_CREATE_SKILL];
    for (const query of ["", "re", "skill"]) {
      const base = rankSkills(rows, query);
      expect(rankSkills(rows, query, undefined, undefined)).toEqual(base);
      expect(rankSkills(rows, query, undefined, usageOf({}), [], NOW)).toEqual(
        base,
      );
    }
  });

  it("ranks a frecent skill above its alphabetical neighbor on an empty query", () => {
    const a = file("alpha");
    const b = file("bravo");
    const usage = usageOf({ bravo: [3, NOW - DAY] });
    expect(
      rankSkills([a, b], "", undefined, usage, [], NOW).map((s) => s.name),
    ).toEqual(["bravo", "alpha"]);
  });

  it("keeps the static order between skills with no usage", () => {
    const rows = [file("delta"), file("charlie"), file("alpha"), file("bravo")];
    const usage = usageOf({ delta: [1, NOW] });
    expect(
      rankSkills(rows, "", undefined, usage, [], NOW).map((s) => s.name),
    ).toEqual(["delta", "alpha", "bravo", "charlie"]);
  });

  it("halves the boost every 14 days", () => {
    const a = file("alpha");
    const b = file("bravo");
    const c = file("charlie");
    // count 3 -> base 80. alpha is fresh, bravo is 14 days old (40),
    // charlie is 14 days old with a count worth 80 but ranks below bravo.
    const usage = usageOf({
      alpha: [1, NOW - 14 * DAY], // 40 * 0.5 = 20
      bravo: [3, NOW - 14 * DAY], // 80 * 0.5 = 40
      charlie: [1, NOW], // 40
    });
    // charlie (40) ties bravo (40) -> static name order; alpha (20) last.
    expect(
      rankSkills([a, b, c], "", undefined, usage, [], NOW).map((s) => s.name),
    ).toEqual(["bravo", "charlie", "alpha"]);
    // A hair older than 14 days drops bravo below charlie.
    const older = usageOf({
      bravo: [3, NOW - 14 * DAY - 60_000],
      charlie: [1, NOW],
    });
    expect(
      rankSkills([b, c], "", undefined, older, [], NOW).map((s) => s.name),
    ).toEqual(["charlie", "bravo"]);
  });

  it("caps the frecency boost at 120", () => {
    const hot = file("zeta");
    const hotter = file("yankee");
    const other = file("alpha", "Review pull requests.");
    // Both saturate: count 2^3 - 1 = 7 gives 120, count 10_000 would exceed it.
    const usage = usageOf({ zeta: [7, NOW], yankee: [10_000, NOW] });
    // Tied at the cap -> falls back to name order.
    expect(
      rankSkills([hotter, hot, other], "", undefined, usage, [], NOW).map(
        (s) => s.name,
      ),
    ).toEqual(["yankee", "zeta", "alpha"]);
    // On a query the cap keeps the boost below the +400 name bonus.
    const q = rankSkills(
      [file("review-x", "x"), file("zzz", "review things")],
      "review",
      undefined,
      usageOf({ zzz: [100_000, NOW] }),
      [],
      NOW,
    );
    expect(q.map((s) => s.name)).toEqual(["review-x", "zzz"]);
  });

  it("lets a fuzzy name hit beat a heavily used description-only hit", () => {
    const named = file("deploy-app", "Ship it.");
    const described = file("release", "Deploy the application safely.");
    const usage = usageOf(
      { release: [100_000, NOW] },
      { [pairKey("release", "x")]: 100_000 },
    );
    expect(
      rankSkills(
        [described, named],
        "deploy",
        undefined,
        usage,
        ["x"],
        NOW,
      ).map((s) => s.name),
    ).toEqual(["deploy-app", "release"]);
  });

  it("adds a co-use boost when the draft contains the paired skill", () => {
    const a = file("alpha");
    const b = file("bravo");
    const usage = usageOf({}, { [pairKey("bravo", "plan-x")]: 3 });
    expect(
      rankSkills([a, b], "", undefined, usage, [], NOW).map((s) => s.name),
    ).toEqual(["alpha", "bravo"]);
    expect(
      rankSkills([a, b], "", undefined, usage, ["plan-x"], NOW).map(
        (s) => s.name,
      ),
    ).toEqual(["bravo", "alpha"]);
  });

  it("caps the co-use boost at 80 and ignores the skill's own invocation", () => {
    const a = file("alpha");
    const b = file("bravo");
    const c = file("charlie");
    // pair rows: charlie pairs with p/q/r heavily (sum would exceed 80)
    const usage = usageOf(
      { bravo: [7, NOW] }, // frecency 120
      {
        [pairKey("charlie", "p")]: 1_000_000,
        [pairKey("charlie", "q")]: 1_000_000,
        [pairKey("charlie", "r")]: 1_000_000,
        [pairKey("alpha", "alpha")]: 1_000_000,
      },
    );
    // charlie boost = 80 (capped), bravo = 120, alpha own-pair ignored = 0.
    expect(
      rankSkills(
        [a, b, c],
        "",
        undefined,
        usage,
        ["p", "q", "r", "alpha"],
        NOW,
      ).map((s) => s.name),
    ).toEqual(["bravo", "charlie", "alpha"]);
    // One pair of count 3 yields exactly 20*log2(4) = 40; two such pairs = 80;
    // so charlie (80) beats a skill with frecency 79-ish but loses to 120.
    const two = usageOf(
      { alpha: [3, NOW] }, // 80
      {
        [pairKey("charlie", "p")]: 3,
        [pairKey("charlie", "q")]: 3,
        [pairKey("charlie", "r")]: 3,
      },
    );
    // charlie = min(80, 120) = 80 ties alpha = 80 -> name order, never above.
    expect(
      rankSkills([c, a], "", undefined, two, ["p", "q", "r"], NOW).map(
        (s) => s.name,
      ),
    ).toEqual(["alpha", "charlie"]);
  });
});

describe("recordSkillsUsedInTurn", () => {
  const context = { harness: "claude" as const, cwd: "/p/app/" };
  const recordCalls = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "skill_usage_record")
      .map(([, args]) => args);

  afterEach(() => {
    resetSkillUsageForTests();
    vi.mocked(invoke).mockReset();
  });

  it("records each catalog skill once per message and skips app commands", async () => {
    vi.mocked(invoke).mockResolvedValue(0);
    await recordSkillsUsedInTurn(
      "/review-pr then /review-pr and /plan plus /skill:architect /unknown",
      context,
      async () => [review, piNative],
    );
    expect(recordCalls()).toEqual([
      { projectKey: "/p/app", invocations: ["review-pr", "skill:architect"] },
    ]);
  });

  it("does not load the catalog or record when the text has no skill token", async () => {
    const load = vi.fn(async () => [review]);
    await recordSkillsUsedInTurn("plain text, a/b and :/x", context, load);
    expect(load).not.toHaveBeenCalled();
    expect(recordCalls()).toEqual([]);
  });

  it("swallows catalog and recording failures", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.mocked(invoke).mockRejectedValue(new Error("down"));
    await expect(
      recordSkillsUsedInTurn("/review-pr", context, async () => [review]),
    ).resolves.toBeUndefined();
    await expect(
      recordSkillsUsedInTurn("/review-pr", context, async () => {
        throw new Error("scan failed");
      }),
    ).resolves.toBeUndefined();
  });
});
