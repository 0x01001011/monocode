import type { BoardNode, BoardStage } from "./taskBoard";

export type ChainTone = "plain" | "warn" | "run";
export type ChainStep = { text: string; tone: ChainTone };
export type Happened =
  | { kind: "phrase"; text: string }
  | { kind: "chain"; steps: ChainStep[] }
  | { kind: "none" };

const STRUGGLING_FROM_ROUNDS = 2;

const rounds = (n: number): string => `${n} ${n === 1 ? "round" : "rounds"}`;

function implementStep(stage: BoardStage): ChainStep {
  if (stage.status === "blocked") return { text: "blocked", tone: "warn" };
  if (stage.status === "running") return { text: "writing", tone: "run" };
  return { text: "written", tone: "plain" };
}

function reviewStep(stage: BoardStage): ChainStep {
  switch (stage.status) {
    case "attention":
      return { text: "review found issues", tone: "warn" };
    case "done":
      return { text: "review passed", tone: "plain" };
    case "failed":
      return { text: "review failed", tone: "warn" };
    case "blocked":
      return { text: "blocked", tone: "warn" };
    case "cancelled":
      return { text: "review cancelled", tone: "plain" };
    default:
      return { text: "in review", tone: "run" };
  }
}

/** All fix rounds fold into one step so the chain stays short. */
function fixStep(fixes: BoardStage[], passed: boolean): ChainStep {
  const last = fixes[fixes.length - 1];
  if (last.status === "running") return { text: `fixing, round ${fixes.length}`, tone: "run" };
  if (last.status === "attention") {
    return { text: `round ${fixes.length}${last.verdict ? `: ${last.verdict}` : ""}`, tone: "warn" };
  }
  return { text: `fixed in ${rounds(fixes.length)}${passed ? ", passed" : ""}`, tone: "plain" };
}

/** Builds the chain only from stages the node has; a stage it lacks is never printed. */
export function chainFor(node: BoardNode): ChainStep[] {
  const steps: ChainStep[] = [];
  const stages = node.stages ?? [];
  const fixes = stages.filter((s) => s.kind === "fix");
  let foldedFixes = false;
  for (const stage of stages) {
    if (stage.kind === "implement") steps.push(implementStep(stage));
    else if (stage.kind === "review") steps.push(reviewStep(stage));
    else if (stage.kind === "final-review") steps.push({ text: "final review", tone: "plain" });
    else if (stage.kind === "final-fix") {
      steps.push(stage.status === "running" ? { text: "fixing", tone: "run" } : { text: "fixed", tone: "plain" });
    } else if (!foldedFixes) {
      foldedFixes = true;
      steps.push(fixStep(fixes, node.status === "done"));
    }
  }
  return steps;
}

/**
 * One phrase for ordinary tasks. A chain only for the running task, a blocked one,
 * 2 or more fix rounds, or a task with parked notes.
 */
export function whatHappened(node: BoardNode, hasParked: boolean): Happened {
  const unusual =
    node.status === "running" ||
    node.status === "blocked" ||
    (node.fixRounds ?? 0) >= STRUGGLING_FROM_ROUNDS ||
    hasParked;
  const chain = chainFor(node);
  if (unusual && chain.length > 0) return { kind: "chain", steps: chain };
  if (node.summary) return { kind: "phrase", text: node.summary };
  if (chain.length > 0 && node.status !== "pending") return { kind: "chain", steps: chain };
  return { kind: "none" };
}
