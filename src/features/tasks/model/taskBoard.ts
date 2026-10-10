export type BoardStatus = "pending" | "running" | "done" | "attention" | "failed" | "blocked" | "cancelled";
export type BoardStage = { kind: "implement" | "review" | "fix" | "final-review" | "final-fix"; label: string; status: BoardStatus; verdict?: string; startedAt?: number; endedAt?: number; /** The commit this stage produced: the implementation, or a fix round's end. */ sha?: string };
/** `done` also holds for every step of a finished task; `ticked` is the plan file's own tick (never set for brief steps). */
export type BoardStep = { text: string; done: boolean; ticked: boolean };
export type BoardNode = { id: string; title: string; index?: number; status: BoardStatus; startedAt?: number; endedAt?: number; summary?: string; stages?: BoardStage[]; steps?: BoardStep[]; children?: BoardNode[]; dependsOn?: string[]; commits?: string; models?: string; fixRounds?: number; /** Items still parked when the task was closed. */ parkedAtClose?: number; target?: BoardTarget };
export type BoardTarget = { kind: "report" | "brief" | "review" | "transcript" | "session" | "commit"; ref: string };
export type BoardNote = { taskIndex?: number; text: string };
export type BoardSection = { source: "sdd" | "orchestration" | "agents" | "todos"; id: string; title: string; done: number; total: number; startedAt?: number; nodes: BoardNode[]; decisions?: BoardNote[]; minors?: BoardNote[]; parked?: BoardNote[]; steps?: { done: number; total: number }; planPath?: string; specPath?: string; finalReview?: BoardNode };

const SHA = /^[0-9a-f]{4,40}$/;

/** Seven-character shas for a commit ref: `a..b` gives both ends, a bare sha one, anything else none. */
export function shortSha(ref: string): string[] {
  return ref
    .split("..")
    .filter((part) => SHA.test(part))
    .map((part) => part.slice(0, 7));
}
