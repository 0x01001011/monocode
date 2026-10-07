import { createHash } from "node:crypto";
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Port of the desktop skill scanner (`src-tauri/src/skills.rs`): same roots,
 * priority, frontmatter rules, plugin handling and parsed-file memo. The
 * parity fixture under `test-fixtures/skills` is scanned by both and must
 * produce the same list. The host does not apply the desktop's disabled-path
 * filter; the app filters the returned list itself.
 */

export type DiscoveredSkill = {
  name: string;
  description: string;
  path: string;
  scope: "project" | "user";
  source: string;
};

export type ListSkillsResult =
  | { skills: DiscoveredSkill[]; revision: number }
  | { unchanged: true; revision: number };

const MAX_SKILLS = 5_000;
const MAX_FRONTMATTER_BYTES = 16 * 1024;

/** Provider skill directories scanned under both the project and the home
 * directory, in priority order. */
export const PROVIDER_SKILL_DIRS: readonly (readonly [string, string])[] = [
  [".claude/skills", "claude"],
  [".cursor/skills", "cursor"],
  [".codex/skills", "codex"],
  [".opencode/skills", "opencode"],
  [".pi/skills", "pi"],
  [".omp/skills", "omp"],
  [".fx/skills", "fx"],
  [".grok/skills", "grok"],
  [".hermes/skills", "hermes"],
];

type Stamp = { mtime: bigint; size: bigint };
type Scanned = { skill: DiscoveredSkill; stamp: Stamp | undefined };
type Parsed = { name: string; description: string };

/** Parsed frontmatter keyed by SKILL.md path. An entry is valid only while
 * both mtime (full precision) and byte length still match the file. */
const memo = new Map<string, Stamp & { parsed: Parsed }>();

const toJs = (path: string) =>
  process.platform === "win32" ? path.replace(/\\/g, "/") : path;

export function listSkills(args: {
  cwd: string;
  home: string;
  sinceRevision?: number;
}): ListSkillsResult {
  const home = args.home;
  const project = expandHome(args.cwd, home);
  const byName = new Map<string, Scanned>();
  const seenRoots = new Set<string>();

  const addRoot = (root: string, scope: "project" | "user", source: string) => {
    if (byName.size >= MAX_SKILLS) return;
    const key = canonical(root);
    if (seenRoots.has(key)) return;
    seenRoots.add(key);
    for (const item of scanRoot(root, scope, source)) {
      if (byName.size >= MAX_SKILLS) break;
      if (!byName.has(item.skill.name)) byName.set(item.skill.name, item);
    }
  };

  // Highest priority first so later roots cannot replace a name.
  addRoot(join(project, ".agents/skills"), "project", "agents");
  addRoot(join(home, ".agents/skills"), "user", "agents");
  for (const [dir, source] of PROVIDER_SKILL_DIRS) {
    addRoot(join(project, dir), "project", source);
    addRoot(join(home, dir), "user", source);
  }
  addRoot(join(home, ".pi/agent/skills"), "user", "pi");
  addRoot(join(home, ".omp/agent/skills"), "user", "omp");
  // New-provider roots come after every pre-existing root so an identically
  // named skill can never shadow an established provider.
  const antigravity = join(home, ".gemini/antigravity/skills");
  if (isDir(antigravity)) addRoot(antigravity, "user", "antigravity");
  for (const [root, scope, namespace] of claudePluginSkillRoots(home, project))
    addNamespacedRoot(byName, root, scope, "claude", namespace);

  const found = [...byName.values()].sort((a, b) =>
    a.skill.name < b.skill.name ? -1 : a.skill.name > b.skill.name ? 1 : 0,
  );
  const revision = revisionOf(found);
  if (args.sinceRevision === revision) return { unchanged: true, revision };
  return { skills: found.map((item) => item.skill), revision };
}

/** A positive integer below 2^53 that changes whenever the listed skills'
 * files (path, mtime, size) or their parsed identity change. */
function revisionOf(found: Scanned[]): number {
  const hash = createHash("sha256");
  for (const { skill, stamp } of found)
    hash.update(
      [
        skill.path,
        stamp?.mtime ?? "-",
        stamp?.size ?? "-",
        skill.name,
        skill.scope,
        skill.source,
        skill.description,
      ].join("\0") + "\n",
    );
  return hash.digest().readUIntBE(0, 6) + 1;
}

function addNamespacedRoot(
  byName: Map<string, Scanned>,
  root: string,
  scope: "project" | "user",
  source: string,
  namespace: string,
) {
  if (byName.size >= MAX_SKILLS) return;
  for (const item of scanRoot(root, scope, source)) {
    if (byName.size >= MAX_SKILLS) break;
    const name = `${namespace}:${item.skill.name}`;
    if (!byName.has(name))
      byName.set(name, { ...item, skill: { ...item.skill, name } });
  }
}

function expandHome(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

function claudePluginSkillRoots(
  home: string,
  project: string,
): [string, "project" | "user", string][] {
  const registry = readJson(join(home, ".claude/plugins/installed_plugins.json"));
  if (!isRecord(registry)) return [];
  const plugins = own(registry, "plugins");
  if (!isRecord(plugins)) return [];

  const roots: [string, "project" | "user", string][] = [];
  // serde_json keeps object keys sorted.
  for (const pluginId of Object.keys(plugins).sort()) {
    const installed = plugins[pluginId];
    if (!claudePluginEnabled(home, project, pluginId)) continue;
    const at = pluginId.lastIndexOf("@");
    const namespace = at >= 0 ? pluginId.slice(0, at) : pluginId;
    if (!isValidSkillName(namespace)) continue;
    const entries = Array.isArray(installed)
      ? installed
      : isRecord(installed)
        ? [installed]
        : undefined;
    if (!entries) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const installPath = own(entry, "installPath");
      if (typeof installPath !== "string") continue;
      const rawScope = own(entry, "scope");
      let scope: "project" | "user";
      if (rawScope === "project" || rawScope === "local") {
        const projectPath = own(entry, "projectPath");
        if (typeof projectPath !== "string") continue;
        if (!pathIsWithin(project, resolveHomePath(projectPath, home))) continue;
        scope = "project";
      } else if (rawScope === "user" || typeof rawScope !== "string") {
        scope = "user";
      } else continue;
      roots.push([join(resolveHomePath(installPath, home), "skills"), scope, namespace]);
    }
  }
  // Array.prototype.sort is stable.
  roots.sort((a, b) => (a[1] === "project" ? 0 : 1) - (b[1] === "project" ? 0 : 1));
  return roots;
}

function resolveHomePath(raw: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return join(home, raw.slice(2));
  return isAbsolute(raw) ? raw : join(home, raw);
}

function claudePluginEnabled(home: string, project: string, pluginId: string): boolean {
  const managed = managedPluginSetting(pluginId);
  if (managed !== undefined) return managed;
  const root = claudeSettingsProjectRoot(project);
  for (const settings of [
    join(root, ".claude/settings.local.json"),
    join(root, ".claude/settings.json"),
    join(home, ".claude/settings.json"),
  ]) {
    const enabled = pluginSetting(settings, pluginId);
    if (enabled !== undefined) return enabled;
  }
  return true;
}

function claudeSettingsProjectRoot(project: string): string {
  let candidate = resolve(project);
  for (;;) {
    const claude = join(candidate, ".claude");
    if (isFile(join(claude, "settings.local.json")) || isFile(join(claude, "settings.json")))
      return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return project;
    candidate = parent;
  }
}

function pluginSetting(path: string, pluginId: string): boolean | undefined {
  const value = readJson(path);
  if (!isRecord(value)) return undefined;
  const enabled = own(value, "enabledPlugins");
  if (!isRecord(enabled)) return undefined;
  const flag = own(enabled, pluginId);
  return typeof flag === "boolean" ? flag : undefined;
}

function managedSettingsRoot(): string | undefined {
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (process.platform === "linux" || process.platform === "android")
    return "/etc/claude-code";
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return undefined;
}

function managedPluginSetting(pluginId: string): boolean | undefined {
  const root = managedSettingsRoot();
  if (!root) return undefined;
  let value = pluginSetting(join(root, "managed-settings.json"), pluginId);
  let files: string[] = [];
  try {
    files = readdirSync(join(root, "managed-settings.d"))
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort();
  } catch {
    // No drop-in directory.
  }
  for (const file of files) {
    const enabled = pluginSetting(join(root, "managed-settings.d", file), pluginId);
    if (enabled !== undefined) value = enabled;
  }
  return value;
}

function pathIsWithin(path: string, root: string): boolean {
  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(path);
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  const rel = relative(realRoot, real);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function stampOf(path: string): Stamp | undefined {
  try {
    const info = statSync(path, { bigint: true });
    return { mtime: info.mtimeNs, size: info.size };
  } catch {
    return undefined;
  }
}

/** Reads and parses one SKILL.md, consulting the memo first. */
function loadSkillFrontmatter(
  skillMd: string,
  fallback: string,
  stamp: Stamp | undefined,
): Parsed | undefined {
  const hit = memo.get(skillMd);
  if (stamp && hit && hit.mtime === stamp.mtime && hit.size === stamp.size)
    return hit.parsed;
  const bytes = readPrefix(skillMd, MAX_FRONTMATTER_BYTES);
  if (!bytes) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const parsed = parseFrontmatter(text, fallback);
  if (stamp) memo.set(skillMd, { ...stamp, parsed });
  return parsed;
}

/** Drops entries of `root`'s skills (`root/<folder>/SKILL.md`) that this scan
 * did not see, so deleted or renamed skills do not accumulate. */
function memoPruneRoot(root: string, seen: Set<string>) {
  for (const path of memo.keys())
    if (dirname(dirname(path)) === root && !seen.has(path)) memo.delete(path);
}

function scanRoot(root: string, scope: "project" | "user", source: string): Scanned[] {
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    memoPruneRoot(root, new Set());
    return [];
  }
  const out: Scanned[] = [];
  const seen = new Set<string>();
  for (const folder of names) {
    const dir = join(root, folder);
    if (!isDir(dir)) continue;
    if (folder.startsWith(".") || folder === "skills-cursor") continue;
    const skillMd = skillMdPath(dir);
    if (!skillMd) continue;
    const fallback = slugName(folder);
    if (!fallback) continue;
    const stamp = stampOf(skillMd);
    const parsed = loadSkillFrontmatter(skillMd, fallback, stamp);
    if (!parsed) continue;
    seen.add(skillMd);
    if (!parsed.name) continue;
    out.push({
      skill: {
        name: parsed.name,
        description: parsed.description,
        path: toJs(skillMd),
        scope,
        source,
      },
      stamp,
    });
  }
  memoPruneRoot(root, seen);
  return out;
}

function skillMdPath(dir: string): string | undefined {
  const upper = join(dir, "SKILL.md");
  if (isFile(upper)) return upper;
  const lower = join(dir, "skill.md");
  return isFile(lower) ? lower : undefined;
}

function readPrefix(path: string, max: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(max);
    let length = 0;
    while (length < max) {
      const read = readSync(fd, buffer, length, max - length, length);
      if (read === 0) break;
      length += read;
    }
    return buffer.subarray(0, length);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function parseFrontmatter(text: string, fallback: string): Parsed {
  const trimmed = text.replace(/^\uFEFF+/, "");
  if (!trimmed.startsWith("---")) return { name: fallback, description: "" };
  let rest = trimmed.slice(3);
  if (rest.startsWith("\r")) rest = rest.slice(1);
  if (rest.startsWith("\n")) rest = rest.slice(1);
  const found = rest.indexOf("\n---");
  const yaml = rest.slice(0, found >= 0 ? found : rest.length);

  let name: string | undefined;
  let description = "";
  let inDesc = false;
  let foldDesc = false;

  const lines = yaml.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const raw of lines.map((line) => line.replace(/\r$/, ""))) {
    if (inDesc) {
      if (isYamlIndent(raw)) {
        const piece = raw.trim();
        if (!piece) continue;
        if (description) description += foldDesc ? " " : "\n";
        description += piece;
        continue;
      }
      inDesc = false;
    }
    const line = raw.trimEnd();
    const nameValue = yamlValue(line, "name");
    if (nameValue !== undefined) {
      name = unquote(nameValue);
      continue;
    }
    const descValue = yamlValue(line, "description");
    if (descValue !== undefined) {
      const value = descValue.trim();
      if (isFoldedScalar(value)) {
        inDesc = true;
        foldDesc = value.startsWith(">");
        description = "";
      } else description = unquote(value);
    }
  }
  return {
    name: name !== undefined && isValidSkillName(name) ? name : fallback,
    description: description.trim(),
  };
}

function yamlValue(line: string, key: string): string | undefined {
  const trimmed = line.trimStart();
  const prefix = `${key}:`;
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length).trim() : undefined;
}

const isFoldedScalar = (value: string) => value.startsWith(">") || value.startsWith("|");
const isYamlIndent = (line: string) => line.startsWith(" ") || line.startsWith("\t");

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'"))
      return value.slice(1, -1);
  }
  return value;
}

function isValidSkillName(name: string): boolean {
  if (!name || name.length > 64) return false;
  let prevDash = true;
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      prevDash = false;
      continue;
    }
    if (ch === "-" && i > 0 && !prevDash) {
      prevDash = true;
      continue;
    }
    return false;
  }
  return !prevDash;
}

function slugName(raw: string): string {
  let out = "";
  let dash = false;
  for (const ch of raw) {
    if (/^[A-Za-z0-9]$/.test(ch)) {
      out += ch.toLowerCase();
      dash = false;
    } else if (out && !dash) {
      out += "-";
      dash = true;
    }
  }
  out = out.replace(/-+$/, "");
  if (out.length > 64) out = out.slice(0, 64).replace(/-+$/, "");
  return out;
}
