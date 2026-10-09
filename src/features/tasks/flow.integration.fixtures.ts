import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Block, Session } from "../sessions/model/session";
import type { SddFs } from "./model/sddWorkspace";

/** The real controller ledger the Tasks flow is tested against (8 tasks, spec, final review). */
export const SKILLS_INDEX_FIXTURE = resolve(__dirname, "../../../test-fixtures/sdd/skills-index");
export const SKILLS_INDEX_SLUG = "skills-index";
export const SPEC_PATH = "docs/superpowers/specs/2026-10-07-skills-index-remote-ranking-design.md";
export const PLAN_PATH = "docs/superpowers/plans/2026-10-07-skills-index-remote-ranking.md";

export const MIN = 60_000;
/** The fake clock every scenario reads. */
export const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
/** The project and plan root of every scenario. */
export const CWD = "/repo";

export type FixtureOptions = {
  /** Rewrites a fixture file's text (by file name) before it is served. */
  transform?: (name: string, text: string) => string;
  /** Files (by name) the workspace does not have. */
  omit?: RegExp;
  /** Where the workspace is mounted. Default `CWD`. */
  cwd?: string;
};

/**
 * An in-memory `SddFs` served from the real fixture directory on disk, mounted at
 * `<cwd>/.superpowers/sdd/<slug>`. Every file gets a deterministic mtime (one minute
 * apart, in file-name order, ending ten minutes before `NOW`), so times never depend
 * on when the fixture was checked out.
 */
export function fixtureFs(options: FixtureOptions = {}, source = SKILLS_INDEX_FIXTURE): SddFs {
  const cwd = options.cwd ?? CWD;
  const dir = `${cwd}/.superpowers/sdd/${SKILLS_INDEX_SLUG}`;
  const names = readdirSync(source)
    .filter((name) => !options.omit?.test(name))
    .sort();
  const files = new Map<string, { text: string; mtimeMs: number }>();
  names.forEach((name, i) => {
    const raw = readFileSync(join(source, name), "utf8");
    const text = options.transform ? options.transform(name, raw) : raw;
    files.set(`${dir}/${name}`, { text, mtimeMs: NOW - 10 * MIN - (names.length - i) * MIN });
  });
  const root = `${cwd}/.superpowers/sdd`;
  return {
    async listDir(path) {
      const clean = path.replace(/\/+$/, "");
      if (clean === root) return [{ name: SKILLS_INDEX_SLUG, path: dir, isDir: true }];
      if (clean !== dir) throw new Error(`ENOENT ${path}`);
      return [...files.keys()].map((file) => ({ name: file.slice(dir.length + 1), path: file, isDir: false }));
    },
    async readText(path) {
      const file = files.get(path);
      if (!file) throw new Error(`ENOENT ${path}`);
      return file.text;
    },
    async statMtimes(paths) {
      return paths.map((path) => ({ path, mtimeMs: files.get(path)?.mtimeMs ?? null }));
    },
  };
}

/** Keeps the ledger up to and including the first line that starts with `lastLine`. */
export function ledgerUpTo(lastLine: string): NonNullable<FixtureOptions["transform"]> {
  return (name, text) => {
    if (name !== "progress.md") return text;
    const lines = text.split("\n");
    const at = lines.findIndex((line) => line.startsWith(lastLine));
    if (at < 0) throw new Error(`fixture ledger has no line starting with ${lastLine}`);
    return lines.slice(0, at + 1).join("\n");
  };
}

/** Replaces the first `Spec:` line of the ledger. */
export function withSpecLine(specLine: string): NonNullable<FixtureOptions["transform"]> {
  return (name, text) => (name === "progress.md" ? text.replace(/^Spec:.*$/m, specLine) : text);
}

let seq = 0;

type ShellOver = {
  /** Harness status; "completed" by default. */
  status?: string;
  startedAt?: number;
  endedAt?: number | null;
};

/** A finished (or, with another status, unfinished) shell tool call, as the harness records it. */
export function shellBlock(command: string, over: ShellOver = {}): Block {
  seq += 1;
  const { status = "completed", startedAt, endedAt } = over;
  return {
    id: `shell-${seq}`,
    role: "tool",
    text: "",
    tool: { kind: "execute", title: command, status, preview: { kind: "shell", title: command } },
    ...(startedAt !== undefined ? { toolStartedAt: startedAt } : {}),
    ...(endedAt !== undefined && endedAt !== null ? { toolEndedAt: endedAt } : {}),
  } as Block;
}

/** A subagent tool call that is still working (no end time, status in progress). */
export function runningAgentBlock(name: string, prompt: string, startedAt: number): Block {
  seq += 1;
  return {
    id: `agent-${seq}`,
    role: "tool",
    text: prompt,
    tool: { kind: "agent", title: name, status: "in_progress" },
    agentRun: { name, model: "claude-opus", steps: [] },
    toolStartedAt: startedAt,
  };
}

export function userBlock(text: string): Block {
  seq += 1;
  return { id: `user-${seq}`, role: "user", text };
}

/** A session the way the app holds one: only what the board reads is filled in. */
export function sessionWith(blocks: Block[], cwd = CWD): Session {
  return { id: "s1", cwd, title: "Skills index", blocks } as unknown as Session;
}
