import type { StatusCard } from "./statusCard";

export type TaskAlert = { kind: "struggling" | "quiet" | "plan-done"; key: string; title: string; body: string };

const TITLES: Record<TaskAlert["kind"], string> = {
  struggling: "A task keeps failing review",
  quiet: "A run has gone quiet",
  "plan-done": "Plan finished",
};

function alertKind(card: StatusCard): TaskAlert["kind"] | undefined {
  if (card.kind === "struggling") return "struggling";
  if (card.kind === "quiet") return "quiet";
  if (card.kind === "done") return "plan-done";
  return undefined;
}

/**
 * Exceptions worth an OS notification when the status card moves from `prev` to `next`:
 * entering struggling, quiet or done, or the same kind landing on another session.
 * `needs-you` is left to the existing input notifications, and routine progress never alerts.
 */
export function taskAlertsBetween(prev: StatusCard | undefined, next: StatusCard): TaskAlert[] {
  const kind = alertKind(next);
  if (!kind) return [];
  if (prev && alertKind(prev) === kind && prev.sessionId === next.sessionId) return [];
  const body = [next.headline, next.detail].filter(Boolean).join(". ");
  return [{ kind, key: `${kind}:${next.sessionId ?? "plan"}`, title: TITLES[kind], body }];
}
