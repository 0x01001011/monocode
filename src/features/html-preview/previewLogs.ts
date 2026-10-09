import type { ConsoleLevel } from "./frameChannel";

/** What a preview shows: an artifact, or a file in a folder. */
export type PreviewLogSource =
  | { kind: "file"; path: string }
  | { kind: "artifact"; id: string };

export const previewLogKey = (source: PreviewLogSource): string =>
  source.kind === "file" ? `file:${source.path}` : `artifact:${source.id}`;

export type PreviewLog = { level: ConsoleLevel; text: string; at: number };

const MAX_ENTRIES = 500;
const NO_LOGS: PreviewLog[] = [];

// Console output of the pages being previewed, per preview. It lives only while
// the app runs, and only for pages that were actually shown.
const logs = new Map<string, PreviewLog[]>();
const listeners = new Map<string, Set<() => void>>();

const notify = (key: string) => listeners.get(key)?.forEach((listener) => listener());

/** Entries of one preview, oldest first. The same array until it changes. */
export function getPreviewLogs(key: string): PreviewLog[] {
  return logs.get(key) ?? NO_LOGS;
}

export function recordPreviewLog(
  key: string,
  level: ConsoleLevel,
  text: string,
): void {
  const next = [...getPreviewLogs(key), { level, text, at: Date.now() }];
  logs.set(key, next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next);
  notify(key);
}

export function clearPreviewLogs(key: string): void {
  if (!logs.delete(key)) return;
  notify(key);
}

export function subscribePreviewLogs(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}
