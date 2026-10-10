import { formatDuration } from "./duration";
import type { BoardNode } from "./taskBoard";

const NO_DURATION = "—";

/** How long a node ran (or has been running); none for work not started, a dash when the start is unknown. */
export function durationLabel(node: Pick<BoardNode, "status" | "startedAt" | "endedAt">, now: number): string | undefined {
  if (node.status === "pending") return undefined;
  if (node.startedAt === undefined) return NO_DURATION;
  // An attention task is still being worked on until it has an end; blocked has no clock.
  if (node.status === "running" || (node.status === "attention" && node.endedAt === undefined)) {
    return formatDuration(now - node.startedAt, true);
  }
  return formatDuration(node.endedAt === undefined ? undefined : node.endedAt - node.startedAt, false);
}
