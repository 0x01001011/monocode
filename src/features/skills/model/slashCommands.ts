import { fuzzyMatch } from "../../../shared/lib/fuzzy";
import { isMarkdownBlockquotePosition } from "../../sessions/model/quoteDraft";
import { pairKey, type SkillUsage } from "./skillUsage";
import type { Skill } from "./skills";

// Keep picker helpers independent of skill discovery for the floating composer.
export type SlashToken = {
  start: number;
  end: number;
  query: string;
};

const MAX_PICKER = 50;

const FRECENCY_CAP = 120;
const FRECENCY_SCALE = 40;
const FRECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const CO_USE_CAP = 80;
const CO_USE_SCALE = 20;

/**
 * Ranking boost from past use: frecency (count, halved every 14 days) plus a
 * co-use bonus for skills already used with a `/other` in the draft. The
 * maximum is 200, below the +400 a name hit earns, so usage reorders matches
 * but never lets a description-only hit outrank a name hit.
 */
function usageBoost(
  skill: Skill,
  usage: SkillUsage,
  draftInvocations: readonly string[],
  now: number,
): number {
  let boost = 0;
  const used = usage.counts.get(skill.invocation);
  if (used && used.count > 0) {
    const age = Math.max(0, now - used.lastUsedAt);
    boost +=
      Math.min(FRECENCY_CAP, FRECENCY_SCALE * Math.log2(1 + used.count)) *
      0.5 ** (age / FRECENCY_HALF_LIFE_MS);
  }
  let coUse = 0;
  for (const other of draftInvocations) {
    if (other === skill.invocation) continue;
    const pairs = usage.pairs.get(pairKey(skill.invocation, other));
    if (pairs) {
      coUse += Math.min(CO_USE_CAP, CO_USE_SCALE * Math.log2(1 + pairs));
    }
  }
  return boost + Math.min(CO_USE_CAP, coUse);
}

export function rankSkills(
  skills: Skill[],
  query: string,
  limit = MAX_PICKER,
  usage?: SkillUsage,
  draftInvocations: readonly string[] = [],
  now = Date.now(),
): Skill[] {
  const boostOf = (skill: Skill) =>
    usage ? usageBoost(skill, usage, draftInvocations, now) : 0;
  const needle = query.trim().toLowerCase();
  if (!needle) {
    const rows = skills.map((skill) => ({ skill, boost: boostOf(skill) }));
    return rows
      .sort((a, b) => {
        if (b.boost !== a.boost) return b.boost - a.boost;
        const rank = scopeRank(a.skill) - scopeRank(b.skill);
        if (rank !== 0) return rank;
        return a.skill.name.localeCompare(b.skill.name);
      })
      .slice(0, limit)
      .map((row) => row.skill);
  }

  const scored: { skill: Skill; score: number }[] = [];
  for (const skill of skills) {
    const nameHit = fuzzyMatch(needle, skill.name);
    const invocationHit = nameHit
      ? null
      : fuzzyMatch(
          needle,
          [
            skill.invocation,
            ...(skill.kind === "native" ? (skill.aliases ?? []) : []),
          ].join(" "),
        );
    const descHit =
      nameHit || invocationHit ? null : fuzzyMatch(needle, skill.description);
    const hit = nameHit ?? invocationHit ?? descHit;
    if (!hit) continue;
    const score =
      (nameHit || invocationHit ? hit.score + 400 : hit.score) + boostOf(skill);
    scored.push({ skill, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.skill.name.localeCompare(b.skill.name);
  });
  return scored.slice(0, limit).map((row) => row.skill);
}

function scopeRank(skill: Skill): number {
  if (skill.kind === "builtin") return 0;
  if (skill.kind === "native" || skill.scope === "project") return 1;
  return 2;
}

/** Slash token that contains `cursor`, if the user is typing `/skill`. */
export function slashTokenAt(
  text: string,
  cursor: number,
  native = false,
): SlashToken | null {
  const i = clamp(cursor, 0, text.length);
  let start = i;
  while (start > 0 && !isSpace(text[start - 1]!)) start -= 1;
  if (text[start] !== "/") return null;
  if (start > 0 && text[start - 1] === ":") return null;
  if (isMarkdownBlockquotePosition(text, start)) return null;

  let end = start + 1;
  while (end < text.length && !isSpace(text[end]!)) end += 1;

  const typed = text.slice(start + 1, i);
  if (typed.includes("/") || typed.includes("\\")) return null;
  if (native) {
    if (!/^[a-zA-Z0-9_.:-]*$/.test(typed)) return null;
  } else {
    if (/[A-Z]/.test(typed)) return null;
    if (!/^(?:[a-z0-9-]+(?::[a-z0-9-]*)?)?$/.test(typed)) return null;
  }

  return { start, end, query: typed };
}

export function replaceSlashToken(
  text: string,
  token: SlashToken,
  name: string,
): string {
  const rest = text.slice(token.end);
  const spacer = rest.startsWith(" ") ? "" : " ";
  return `${text.slice(0, token.start)}/${name}${spacer}${rest}`;
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
