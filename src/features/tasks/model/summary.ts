import type { Gap } from "./gaps";
import type { Ship } from "./ship";
import { shortSha, type BoardNode, type BoardSection } from "./taskBoard";

/** The review rounds after which a task is sent to a human; the same cap the controller uses. */
const MAX_FIX_ROUNDS = 5;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** How the review went for this task, in plain words. */
function reviewState(node: BoardNode): string {
  const stages = node.stages ?? [];
  const lastStage = stages[stages.length - 1];
  if (stages.some((s) => s.status === "failed")) return "review failed";
  const rounds = node.fixRounds ?? stages.filter((s) => s.kind === "fix").length;
  const reviews = stages.filter((s) => s.kind === "review");
  if (node.status === "done") {
    if (rounds > 0) return `fixed in ${plural(rounds, "round", "rounds")}`;
    return reviews.length > 0 ? "review clean" : "not reviewed";
  }
  if (rounds > 0) return lastStage?.status === "running" ? `fix round ${Math.min(rounds, MAX_FIX_ROUNDS)} of ${MAX_FIX_ROUNDS}` : "issues found";
  const lastReview = reviews[reviews.length - 1];
  if (lastReview?.status === "running") return "in review";
  if (lastReview?.status === "attention") return "issues found";
  return "not reviewed";
}

function shaOf(node: BoardNode): string {
  const fromCommits = node.commits ? shortSha(node.commits) : [];
  if (fromCommits.length > 0) return fromCommits.join("..");
  const stageSha = [...(node.stages ?? [])].reverse().find((s) => s.sha)?.sha;
  const fromStage = stageSha ? shortSha(stageSha) : [];
  return fromStage.length > 0 ? fromStage.join("..") : "no commit";
}

function taskName(node: BoardNode): string {
  return node.index !== undefined ? `Task ${node.index}: ${node.title}` : node.title;
}

/**
 * A short Markdown status for a PR body or standup: title, counts, one line per task with
 * review state and sha, deferred items and gaps, and the ship verdict. Plain text. Pure.
 */
export function planSummaryMarkdown(section: BoardSection, ship: Ship, gaps: Gap[]): string {
  const counts = [`${section.done} of ${plural(section.total, "task", "tasks")} done`];
  if (section.steps) counts.push(`${section.steps.done} of ${plural(section.steps.total, "step", "steps")}`);
  counts.push(plural(ship.commits, "commit", "commits"));

  const lines = [`# ${section.title}`, "", counts.join(" · "), ""];
  for (const node of section.nodes) {
    const box = node.status === "done" ? "x" : " ";
    lines.push(`- [${box}] ${taskName(node)} · ${reviewState(node)} · ${shaOf(node)}`);
  }

  const deferred = [...(section.parked ?? []), ...(section.minors ?? [])];
  if (deferred.length > 0) {
    lines.push("", "Deferred");
    for (const note of deferred) lines.push(`- ${note.taskIndex !== undefined ? `Task ${note.taskIndex}: ` : ""}${note.text}`);
  }
  if (gaps.length > 0) {
    lines.push("", "Gaps");
    for (const gap of gaps) lines.push(`- ${gap.label}: ${gap.text}`);
  }
  lines.push("", ship.ready ? "Ship: Ready to ship" : `Ship: ${plural(ship.left, "thing", "things")} before ship`, "");
  return lines.join("\n");
}
