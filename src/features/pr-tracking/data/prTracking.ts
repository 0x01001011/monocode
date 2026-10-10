import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useSyncExternalStore } from "react";
import {
  PR_SET_CHANGED_EVENT,
  type PrInterestLevel,
  type PrSetChangedPayload,
  type PrSetView,
  type PrSummary,
} from "../model/types";

/**
 * Data layer for chat PR tracking. Rust owns attribution and status; this
 * module only caches what `pr_session_set` / `pr_summaries` return and keeps
 * the cache fresh from the `pr-set-changed` event. Nothing here throws into
 * render: a rejected invoke leaves the previous value in place.
 */

// ---------------------------------------------------------------- commands

const warned = new Set<string>();

function warnOnce(command: string, error: unknown) {
  if (warned.has(command)) return;
  warned.add(command);
  console.warn(`[pr-tracking] ${command} failed`, error);
}

type Attempt<T> = { ok: true; value: T } | { ok: false };

async function attempt<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await invoke<T>(command, args) };
  } catch (error) {
    warnOnce(command, error);
    return { ok: false };
  }
}

/** The chat's PRs, or null when the lookup failed. */
export async function fetchPrSet(sessionId: string): Promise<PrSetView | null> {
  const result = await attempt<PrSetView>("pr_session_set", { sessionId });
  return result.ok ? (result.value ?? null) : null;
}

/** One summary per chat that has PRs, or null when the lookup failed. */
export async function fetchPrSummaries(): Promise<Record<
  string,
  PrSummary
> | null> {
  const result = await attempt<Record<string, PrSummary>>("pr_summaries");
  return result.ok ? (result.value ?? null) : null;
}

export async function setPrInterest(
  sessionId: string,
  level: PrInterestLevel,
): Promise<void> {
  await attempt("pr_set_interest", { sessionId, level });
}

export async function refreshPrSet(sessionId: string): Promise<void> {
  await attempt("pr_refresh", { sessionId });
}

export async function dismissPr(
  sessionId: string,
  repo: string,
  number: number,
  dismissed: boolean,
): Promise<void> {
  const result = await attempt("pr_dismiss", {
    sessionId,
    repo,
    number,
    dismissed,
  });
  // Dismissal changes the view without any GitHub traffic, so there is no
  // tracker event to wait for.
  if (result.ok) invalidateSessions([sessionId]);
}

export async function recordPrUrl(
  sessionId: string,
  url: string,
): Promise<void> {
  await attempt("pr_record_url", { sessionId, url });
}

export async function recordPrHints(
  sessionId: string,
  cwd: string,
  numbers: number[],
): Promise<void> {
  await attempt("pr_record_hints", { sessionId, cwd, numbers });
}

// ------------------------------------------------------------------ store

type Source<T> = {
  value: T;
  listeners: Set<() => void>;
  inFlight: boolean;
  /** An invalidation arrived while a fetch was running. */
  dirty: boolean;
  /** The cache reflects a fetch made since the last invalidation. */
  fresh: boolean;
  fetchNow: () => Promise<T | null>;
};

const EMPTY_SUMMARIES: Record<string, PrSummary> = Object.freeze({});

function makeSource<T>(initial: T, fetchNow: () => Promise<T | null>): Source<T> {
  return {
    value: initial,
    listeners: new Set(),
    inFlight: false,
    dirty: false,
    fresh: false,
    fetchNow,
  };
}

const sets = new Map<string, Source<PrSetView | null>>();
const summaries = makeSource<Record<string, PrSummary>>(
  EMPTY_SUMMARIES,
  fetchPrSummaries,
);

function setSource(sessionId: string): Source<PrSetView | null> {
  let source = sets.get(sessionId);
  if (!source) {
    source = makeSource<PrSetView | null>(null, () => fetchPrSet(sessionId));
    sets.set(sessionId, source);
  }
  return source;
}

async function load<T>(source: Source<T>): Promise<void> {
  source.fresh = true;
  if (source.inFlight) {
    source.dirty = true;
    return;
  }
  source.inFlight = true;
  try {
    do {
      source.dirty = false;
      const next = await source.fetchNow();
      if (next == null) {
        // Nothing was learned, so the next subscriber should try again.
        source.fresh = false;
        continue;
      }
      // A queued refetch that succeeds after a failed one makes the cache
      // current again.
      source.fresh = true;
      if (JSON.stringify(next) === JSON.stringify(source.value)) continue;
      source.value = next;
      for (const listener of [...source.listeners]) listener();
    } while (source.dirty);
  } finally {
    source.inFlight = false;
  }
}

/** Refetch now if somebody is watching, else remember to refetch on next use. */
function invalidate<T>(source: Source<T>) {
  if (source.listeners.size > 0) void load(source);
  else if (source.inFlight) {
    // The running fetch may predate the change; let it go round once more.
    source.dirty = true;
  } else source.fresh = false;
}

function invalidateSessions(sessionIds: string[]) {
  const all = sessionIds.length === 0;
  for (const [id, source] of sets) {
    if (all || sessionIds.includes(id)) invalidate(source);
  }
  // Any change to any chat can move a sidebar summary.
  invalidate(summaries);
}

// One event subscription shared by every consumer, held only while at least
// one consumer is mounted.
let consumers = 0;
let generation = 0;
let stopListening: (() => void) | null = null;

function attach() {
  consumers += 1;
  if (consumers !== 1) return;
  const mine = ++generation;
  listen<PrSetChangedPayload>(PR_SET_CHANGED_EVENT, (event) => {
    const ids = event.payload?.sessionIds;
    invalidateSessions(Array.isArray(ids) ? ids : []);
  })
    .then((unlisten) => {
      if (mine !== generation || consumers === 0) {
        unlisten();
        return;
      }
      stopListening = unlisten;
      // Events sent between the first fetches and now were never heard.
      invalidateSessions([]);
    })
    .catch((error) => warnOnce(PR_SET_CHANGED_EVENT, error));
}

function detach() {
  consumers -= 1;
  if (consumers !== 0) return;
  generation += 1;
  stopListening?.();
  stopListening = null;
  // Events are missed while nobody listens, so every cache is suspect now.
  for (const source of sets.values()) source.fresh = false;
  summaries.fresh = false;
}

function subscribeTo<T>(source: Source<T>, listener: () => void) {
  source.listeners.add(listener);
  attach();
  if (!source.fresh) void load(source);
  return () => {
    source.listeners.delete(listener);
    detach();
  };
}

const NO_UNSUBSCRIBE = () => undefined;

/** Cached view for a chat without subscribing; starts a first fetch if none ran. */
export function getPrSet(sessionId: string): PrSetView | null {
  const source = setSource(sessionId);
  if (!source.fresh && !source.inFlight) void load(source);
  return source.value;
}

/** The chat's PRs. Synchronous from cache; null until the first answer. */
export function usePrSet(sessionId?: string): PrSetView | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      sessionId ? subscribeTo(setSource(sessionId), listener) : NO_UNSUBSCRIBE,
    [sessionId],
  );
  const getSnapshot = useCallback(
    () => (sessionId ? setSource(sessionId).value : null),
    [sessionId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const subscribeSummaries = (listener: () => void) =>
  subscribeTo(summaries, listener);
const getSummaries = () => summaries.value;

/** One summary per chat that has PRs, keyed by session id. */
export function usePrSummaries(): Record<string, PrSummary> {
  return useSyncExternalStore(subscribeSummaries, getSummaries, getSummaries);
}
