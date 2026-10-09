import type { StatusSessionInput } from "./statusCard";

/** Session id to the time its snooze ends. Held in memory only: a snooze is a short pause. */
const until = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

export function snoozeSession(sessionId: string, ms: number, now: number = Date.now()): void {
  until.set(sessionId, now + ms);
  version++;
  for (const listener of listeners) listener();
}

export function clearSnoozes(): void {
  until.clear();
  version++;
}

export const snoozeVersion = (): number => version;

export function subscribeSnoozes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Treats each snoozed session as active at `now`, so the status card does not call it quiet
 * until the snooze ends. Returns the same array when nothing applies.
 */
export function applySnoozes<T extends StatusSessionInput>(sessions: readonly T[], now: number): readonly T[] {
  if (until.size === 0) return sessions;
  let changed = false;
  const next = sessions.map((session) => {
    const end = until.get(session.id);
    if (end === undefined || end <= now) return session;
    changed = true;
    return { ...session, lastActivityAt: now };
  });
  return changed ? next : sessions;
}
