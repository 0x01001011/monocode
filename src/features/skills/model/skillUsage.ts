import { useCallback, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { normalizeProjectPath } from "../../projects/model/recents";

/**
 * Per-project skill usage, used to rank the slash picker. Keys are skill
 * invocations (what the user types after `/`). Pure ranking input: the store
 * below fills it from the session database and never throws into the UI.
 */
export type SkillUsage = {
  counts: Map<string, { count: number; lastUsedAt: number }>;
  /** `pairKey(a, b)` to the number of messages that used both. */
  pairs: Map<string, number>;
};

type UsageRow = { invocation: string; count: number; lastUsedAt: number };
type PairRow = { a: string; b: string; count: number; lastUsedAt: number };
type UsageSnapshot = { usage: UsageRow[]; pairs: PairRow[] };

/** Order-independent key for two invocations (`a < b`, NUL separated). */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

export function usageFromSnapshot(snapshot: unknown): SkillUsage {
  const raw = (snapshot ?? {}) as Partial<UsageSnapshot>;
  const counts: SkillUsage["counts"] = new Map();
  const pairs: SkillUsage["pairs"] = new Map();
  if (Array.isArray(raw.usage)) {
    for (const row of raw.usage) {
      if (!row || typeof row.invocation !== "string") continue;
      counts.set(row.invocation, {
        count: Number(row.count) || 0,
        lastUsedAt: Number(row.lastUsedAt) || 0,
      });
    }
  }
  if (Array.isArray(raw.pairs)) {
    for (const row of raw.pairs) {
      if (!row || typeof row.a !== "string" || typeof row.b !== "string") {
        continue;
      }
      pairs.set(pairKey(row.a, row.b), Number(row.count) || 0);
    }
  }
  return { counts, pairs };
}

type Entry = {
  usage?: SkillUsage;
  loading: boolean;
  /** Bumped per request so a slow older snapshot never overwrites a newer one. */
  generation: number;
  listeners: Set<() => void>;
};

const entries = new Map<string, Entry>();
let backfill: Promise<void> | null = null;

function debug(what: string, error: unknown) {
  console.debug(`skill usage: ${what} failed`, error);
}

/** Same normalizer the catalog cache uses; the backend applies it again. */
function usageKey(projectKey: string): string {
  return projectKey.trim() ? normalizeProjectPath(projectKey.trim()) : "";
}

/**
 * Imports usage from stored transcripts once per app session. Live recording
 * and snapshot reads wait for it, so messages sent from now on are counted
 * only live. A message saved to a transcript while the very first backfill is
 * still scanning may be counted by both; that small overcount is accepted.
 */
function ensureBackfill(): Promise<void> {
  backfill ??= invoke<number>("skill_usage_backfill").then(
    () => undefined,
    (error) => debug("backfill", error),
  );
  return backfill;
}

function entryFor(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { loading: false, generation: 0, listeners: new Set() };
    entries.set(key, entry);
  }
  return entry;
}

async function loadSnapshot(key: string): Promise<void> {
  const entry = entryFor(key);
  const generation = ++entry.generation;
  entry.loading = true;
  try {
    await ensureBackfill();
    const snapshot = await invoke<UsageSnapshot>("skill_usage_snapshot", {
      projectKey: key,
    });
    if (generation !== entry.generation) return;
    entry.usage = usageFromSnapshot(snapshot);
    for (const listener of [...entry.listeners]) listener();
  } catch (error) {
    debug("snapshot", error);
  } finally {
    if (generation === entry.generation) entry.loading = false;
  }
}

export function getSkillUsage(projectKey: string): SkillUsage | undefined {
  const key = usageKey(projectKey);
  return key ? entries.get(key)?.usage : undefined;
}

/** Subscribes to usage changes for a project; loads its snapshot on first use. */
export function subscribeSkillUsage(
  projectKey: string,
  listener: () => void,
): () => void {
  const key = usageKey(projectKey);
  if (!key) return () => undefined;
  const entry = entryFor(key);
  entry.listeners.add(listener);
  if (!entry.usage && !entry.loading) void loadSnapshot(key);
  return () => {
    entry.listeners.delete(listener);
  };
}

/** Usage for ranking; `undefined` until loaded or when the store is unavailable. */
export function useSkillUsage(
  projectKey: string | null | undefined,
): SkillUsage | undefined {
  const key = projectKey ? usageKey(projectKey) : "";
  const subscribe = useCallback(
    (listener: () => void) => subscribeSkillUsage(key, listener),
    [key],
  );
  return useSyncExternalStore(subscribe, () =>
    key ? entries.get(key)?.usage : undefined,
  );
}

/**
 * Counts one sent message. Duplicate invocations collapse so a skill is
 * counted once per message. Calls made before the backfill finishes wait for
 * it (in call order). Never rejects.
 */
export async function recordSkillUse(
  projectKey: string,
  invocations: readonly string[],
): Promise<void> {
  const key = usageKey(projectKey);
  const distinct = [
    ...new Set(invocations.map((name) => name.trim()).filter(Boolean)),
  ];
  if (!key || distinct.length === 0) return;
  try {
    await ensureBackfill();
    await invoke("skill_usage_record", {
      projectKey: key,
      invocations: distinct,
    });
  } catch (error) {
    debug("record", error);
    return;
  }
  if (entries.has(key)) await loadSnapshot(key);
}

export function resetSkillUsageForTests() {
  entries.clear();
  backfill = null;
}
