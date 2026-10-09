import { useSyncExternalStore } from "react";

export const QUIET_AFTER_MINUTES_KEY = "monocode.tasksQuietAfterMinutes";
export const QUIET_AFTER_MINUTES_DEFAULT = 5;
export const QUIET_AFTER_MINUTES_MIN = 1;
export const QUIET_AFTER_MINUTES_MAX = 60;

/** Fired on `window` whenever the quiet threshold is saved (detail: minutes). */
export const QUIET_AFTER_MINUTES_CHANGE_EVENT = "monocode:tasksquietafterchange";

const clampMinutes = (value: number) =>
  Math.round(Math.min(QUIET_AFTER_MINUTES_MAX, Math.max(QUIET_AFTER_MINUTES_MIN, value)));

/** Minutes a running session may stay silent before the Tasks status card calls it quiet. */
export function loadQuietAfterMinutes(): number {
  try {
    const raw = localStorage.getItem(QUIET_AFTER_MINUTES_KEY);
    if (raw == null) return QUIET_AFTER_MINUTES_DEFAULT;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampMinutes(parsed) : QUIET_AFTER_MINUTES_DEFAULT;
  } catch {
    return QUIET_AFTER_MINUTES_DEFAULT;
  }
}

export function saveQuietAfterMinutes(value: number) {
  const next = clampMinutes(value);
  try {
    localStorage.setItem(QUIET_AFTER_MINUTES_KEY, String(next));
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<number>(QUIET_AFTER_MINUTES_CHANGE_EVENT, { detail: next }));
}

export function subscribeQuietAfterMinutes(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === QUIET_AFTER_MINUTES_KEY || event.key === null) onStoreChange();
  };
  window.addEventListener(QUIET_AFTER_MINUTES_CHANGE_EVENT, onStoreChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(QUIET_AFTER_MINUTES_CHANGE_EVENT, onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

export const useQuietAfterMinutes = () =>
  useSyncExternalStore(subscribeQuietAfterMinutes, loadQuietAfterMinutes, () => QUIET_AFTER_MINUTES_DEFAULT);
