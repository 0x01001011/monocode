export type BoardStatus = "pending" | "running" | "done" | "attention" | "failed" | "blocked" | "cancelled";
export type BoardStage = { kind: "implement" | "review" | "fix" | "final-review" | "final-fix"; label: string; status: BoardStatus; verdict?: string; startedAt?: number; endedAt?: number };
export type BoardStep = { text: string; done: boolean };
export type BoardNode = { id: string; title: string; index?: number; status: BoardStatus; startedAt?: number; endedAt?: number; summary?: string; stages?: BoardStage[]; steps?: BoardStep[]; children?: BoardNode[]; dependsOn?: string[]; commits?: string; models?: string; fixRounds?: number; target?: BoardTarget };
export type BoardTarget = { kind: "report" | "brief" | "review" | "transcript" | "session" | "commit"; ref: string };
export type BoardNote = { taskIndex?: number; text: string };
export type BoardSection = { source: "sdd" | "orchestration" | "agents" | "todos"; id: string; title: string; done: number; total: number; startedAt?: number; nodes: BoardNode[]; decisions?: BoardNote[]; minors?: BoardNote[]; parked?: BoardNote[]; planPath?: string; finalReview?: BoardNode };
