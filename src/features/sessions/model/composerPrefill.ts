/**
 * Text waiting to be inserted into a session's composer, keyed by session id. Like a transcript
 * jump, it is consumed by that session's pane once the pane is mounted and showing, so the
 * caller needs no timing and a missing pane never sends the text anywhere else.
 */
import { getComposerDraft, setComposerDraft } from "./draftCache";

export type ComposerPrefill = {
  text: string;
  token: number;
  at: number;
  keep: boolean;
};

/** A request nobody picked up (the pane never showed) is dropped rather than applied much later. */
const MAX_AGE_MS = 60_000;

const pending = new Map<string, ComposerPrefill>();
const listeners = new Set<() => void>();
const mounted = new Map<string, number>();
let nextToken = 0;

function notify() {
  for (const listener of listeners) listener();
}

/** `keep` requests wait for the pane however long it takes instead of expiring after a minute. */
export function requestComposerPrefill(
  sessionId: string,
  text: string,
  options?: { keep?: boolean },
): void {
  pending.set(sessionId, {
    text,
    token: ++nextToken,
    at: Date.now(),
    keep: options?.keep ?? false,
  });
  notify();
}

export function peekComposerPrefill(sessionId: string): ComposerPrefill | null {
  const request = pending.get(sessionId);
  if (!request) return null;
  if (!request.keep && Date.now() - request.at > MAX_AGE_MS) {
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

/** Records that a pane with this session's live composer is mounted; call the result on unmount. */
export function markComposerMounted(sessionId: string): () => void {
  mounted.set(sessionId, (mounted.get(sessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (mounted.get(sessionId) ?? 1) - 1;
    if (left > 0) mounted.set(sessionId, left);
    else mounted.delete(sessionId);
  };
}

export function isComposerMounted(sessionId: string): boolean {
  return (mounted.get(sessionId) ?? 0) > 0;
}

/**
 * Adds `text` to a chat's unsent draft from another surface. Never sends. A mounted composer
 * keeps its live text in its own state, so it gets the text as a kept prefill that its pane
 * inserts once showing; otherwise the cached draft the pane mounts with is extended.
 */
export function appendComposerDraft(sessionId: string, text: string): void {
  if (isComposerMounted(sessionId)) {
    const queued = peekComposerPrefill(sessionId)?.text;
    requestComposerPrefill(sessionId, queued ? `${queued}\n\n${text}` : text, {
      keep: true,
    });
    return;
  }
  const existing = getComposerDraft(sessionId);
  setComposerDraft(sessionId, existing ? `${existing}\n\n${text}` : text);
}
