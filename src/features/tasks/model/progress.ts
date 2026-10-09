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

/** "5 of 8 done · 1h 01m so far · about 35m left"; the ETA needs three finished tasks. */
export function progressLine(plan: BoardSection, now: number): string {
  const parts = [`${plan.done} of ${plan.total} done`];
  const finished = plan.total > 0 && plan.done >= plan.total;
  const end = finished ? finishedAt(plan) : now;
  if (plan.startedAt !== undefined && end !== undefined) {
    parts.push(`${formatDuration(end - plan.startedAt, !finished)}${finished ? "" : " so far"}`);
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
  return parts.join(" · ");
}
