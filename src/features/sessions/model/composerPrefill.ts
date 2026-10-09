/**
 * Text waiting to be inserted into a session's composer, keyed by session id. Like a transcript
 * jump, it is consumed by that session's pane once the pane is mounted and showing, so the
 * caller needs no timing and a missing pane never sends the text anywhere else.
 */
export type ComposerPrefill = { text: string; token: number; at: number };

/** A request nobody picked up (the pane never showed) is dropped rather than applied much later. */
const MAX_AGE_MS = 60_000;

const pending = new Map<string, ComposerPrefill>();
const listeners = new Set<() => void>();
let nextToken = 0;

function notify() {
  for (const listener of listeners) listener();
}

export function requestComposerPrefill(sessionId: string, text: string): void {
  pending.set(sessionId, { text, token: ++nextToken, at: Date.now() });
  notify();
}

export function peekComposerPrefill(sessionId: string): ComposerPrefill | null {
  const request = pending.get(sessionId);
  if (!request) return null;
  if (Date.now() - request.at > MAX_AGE_MS) {
    pending.delete(sessionId);
    return null;
  }
  return request;
}

export function clearComposerPrefill(sessionId: string, token: number): void {
  if (pending.get(sessionId)?.token !== token) return;
  pending.delete(sessionId);
  notify();
}

export function subscribeComposerPrefill(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
