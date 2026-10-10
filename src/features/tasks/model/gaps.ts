import type { BoardNode, BoardSection } from "./taskBoard";

export type GapKind = "no-commit" | "closed-with-parked" | "unticked-at-finish" | "no-final-review";

export type Gap = {
  kind: GapKind;
  /** The row to reveal: a task, or `"final-review"`. */
  nodeId: string;
  /** "Task 2", "Final review". */
  label: string;
  /** Plain words: "no commit recorded", "closed with 2 parked". */
  text: string;
};

function labelFor(node: BoardNode): string {
  return node.index !== undefined ? `Task ${node.index}` : node.title;
}

function hasCommit(node: BoardNode): boolean {
  return Boolean(node.commits) || (node.stages?.some((s) => Boolean(s.sha)) ?? false);
}

/**
 * What a finished plan is missing, in plan order (the final review last). A gap never
 * blocks work; it is a fact worth a look before the branch ships. Pure.
 */
export function gapsFor(section: BoardSection): Gap[] {
  const gaps: Gap[] = [];
  for (const node of section.nodes) {
    const gap = (kind: GapKind, text: string) => gaps.push({ kind, nodeId: node.id, label: labelFor(node), text });
    if (node.status === "done" && !hasCommit(node)) gap("no-commit", "no commit recorded");
    if ((node.parkedAtClose ?? 0) > 0) gap("closed-with-parked", `closed with ${node.parkedAtClose} parked`);
    // Only a plan file ticks its steps: brief steps are never ticked, so they are no evidence.
    if (node.status === "done" && section.steps) {
      const unticked = node.steps?.filter((s) => !s.ticked).length ?? 0;
      if (unticked > 0) gap("unticked-at-finish", `${unticked} ${unticked === 1 ? "step" : "steps"} not ticked`);
    }
  }
  const allDone = section.nodes.length > 0 && section.nodes.every((n) => n.status === "done");
  if (allDone && (!section.finalReview || section.finalReview.status === "pending")) {
    gaps.push({ kind: "no-final-review", nodeId: "final-review", label: "Final review", text: "final review not run" });
  }
  return gaps;
}
