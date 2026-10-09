import { formatDuration } from "./duration";
import type { BoardNode, BoardSection } from "./taskBoard";

const ETA_FROM_DONE = 3;

const isDone = (n: BoardNode) => n.status === "done";

function finishedAt(plan: BoardSection): number | undefined {
  const ends = [...plan.nodes, ...(plan.finalReview ? [plan.finalReview] : [])]
    .map((n) => n.endedAt)
    .filter((t): t is number => t !== undefined);
  return ends.length ? Math.max(...ends) : undefined;
}

/**
 * "1h 01m so far · about 35m left" while it runs, "took 1h 52m" when it is done. The counts
 * ("5 of 8 tasks") are the overview's job. The ETA needs three finished tasks. Undefined when the
 * start time is unknown, so no line is shown rather than an invented one.
 */
export function timeLine(plan: BoardSection, now: number): string | undefined {
  const parts: string[] = [];
  const finished = plan.total > 0 && plan.done >= plan.total;
  const end = finished ? finishedAt(plan) : now;
  if (plan.startedAt !== undefined && end !== undefined) {
    const span = formatDuration(end - plan.startedAt, !finished);
    parts.push(finished ? `took ${span}` : `${span} so far`);
  }
  if (plan.done >= ETA_FROM_DONE && !finished) {
    const spans = plan.nodes
      .filter(isDone)
      .flatMap((n) => (n.startedAt !== undefined && n.endedAt !== undefined && n.endedAt >= n.startedAt ? [n.endedAt - n.startedAt] : []));
    if (spans.length) {
      const mean = spans.reduce((a, b) => a + b, 0) / spans.length;
      parts.push(`about ${formatDuration(mean * (plan.total - plan.done), false)} left`);
    }
  }
  return parts.length ? parts.join(" · ") : undefined;
}
