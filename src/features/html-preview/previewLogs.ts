import type { ConsoleLevel } from "./frameChannel";

/** What a preview shows: an artifact, a file in a folder, or a page held in memory. */
export type PreviewLogSource =
  | { kind: "file"; path: string }
  | { kind: "artifact"; id: string }
  | { kind: "page"; path: string };

export const previewLogKey = (source: PreviewLogSource): string =>
  source.kind === "artifact" ? `artifact:${source.id}` : `${source.kind}:${source.path}`;

export type PreviewLog = { level: ConsoleLevel; text: string; at: number };

const MAX_ENTRIES = 500;
const NO_LOGS: PreviewLog[] = [];

// Console output of the pages being previewed, per preview. It lives only while
// the app runs, and only for pages that were actually shown.
const logs = new Map<string, PreviewLog[]>();
const listeners = new Map<string, Set<() => void>>();
// Previews that have loaded at least once; unlike the console, this survives a clear.
const loaded = new Set<string>();

export const markPreviewLoaded = (key: string): void => {
  loaded.add(key);
};
export const hasPreviewLoaded = (key: string): boolean => loaded.has(key);

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
