import type {
  OrchestrationDispatch,
  OrchestrationRun,
  TaskStatus,
} from "../../orchestration/model/orchestrationState";
import type { Block, TaskListItemStatus } from "../../sessions/model/session";
import { toolCallState } from "../../sessions/model/transcriptActivity";
import { isAgentToolName } from "../../../integrations/harness/core/preview";
import type { BoardNode, BoardSection, BoardStatus } from "./taskBoard";

const TODO_STATUS: Record<TaskListItemStatus, BoardStatus> = {
  completed: "done",
  in_progress: "running",
  cancelled: "cancelled",
  pending: "pending",
};

const ORCHESTRATION_STATUS: Record<TaskStatus, BoardStatus> = {
  queued: "pending",
  running: "running",
  cancelling: "running",
  completed: "done",
  failed: "failed",
  interrupted: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
};

const MIRROR_MATCH_RATIO = 0.8;
const TITLE_PREFIX = /^\s*(?:task\s*\d+\s*[:.)-]?|\d+\s*[.)])\s*/i;

function isTime(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

/** The end of a span, or undefined when it is unknown or would run backwards. */
function saneEnd(start: number | undefined, end: number | undefined): number | undefined {
  if (!isTime(end)) return undefined;
  return isTime(start) && end < start ? undefined : end;
}

function earliest(nodes: readonly BoardNode[]): number | undefined {
  const starts = nodes.map((n) => n.startedAt).filter(isTime);
  return starts.length ? Math.min(...starts) : undefined;
}

function sectionOf(
  source: BoardSection["source"],
  id: string,
  title: string,
  nodes: BoardNode[],
): BoardSection {
  const startedAt = earliest(nodes);
  return {
    source,
    id,
    title,
    done: nodes.filter((n) => n.status === "done").length,
    total: nodes.length,
    nodes,
    ...(startedAt !== undefined ? { startedAt } : {}),
  };
}

export function buildTodoSection(blocks: readonly Block[]): BoardSection | undefined {
  let latest: Block | undefined;
  for (const block of blocks) if (block.taskList) latest = block;
  const items = latest?.taskList?.items;
  if (!latest || !items?.length) return undefined;
  const nodes = items.map<BoardNode>((item, i) => ({
    id: `${latest.id}:${i}`,
    title: item.text,
    index: i + 1,
    status: TODO_STATUS[item.status] ?? "pending",
  }));
  return sectionOf("todos", "todos", "To-do list", nodes);
}

function isAgentBlock(block: Block): boolean {
  if (block.agentRun) return true;
  const tool = block.tool;
  if (!tool) return false;
  return isAgentToolName(tool.kind ?? "") || isAgentToolName(tool.title ?? "");
}

function agentNode(block: Block): BoardNode {
  const state = toolCallState(block);
  const status: BoardStatus =
    state === "rejected" ? "failed" : state === "accepted" ? "done" : "running";
  const startedAt = isTime(block.toolStartedAt) ? block.toolStartedAt : undefined;
  // toolEndedAt can outlive a status that went back to running.
  const endedAt = status === "running" ? undefined : saneEnd(startedAt, block.toolEndedAt);
  const title = block.agentRun?.name || block.tool?.title || block.text || "Subagent";
  const model = block.agentRun?.model;
  return {
    id: block.id,
    title,
    status,
    target: { kind: "transcript", ref: block.id },
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(model ? { models: model } : {}),
  };
}

const SDD_FILE = /\btask-\d+-(?:brief|report)\.md\b|\breview-\S+?\.\.\S+?\.diff\b/;

/** What an agent block says about its job: its prompt, tool detail and the steps it took. */
function agentText(block: Block): string {
  const steps = block.agentRun?.steps ?? [];
  return [block.text, block.tool?.detail, ...steps.flatMap((step) => [step.text, step.detail, step.preview?.path])]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n");
}

/**
 * True for an SDD implementer or reviewer: it is handed the plan workspace, a task brief or
 * report, or a review package. An agent with nothing readable cannot be told apart, so the
 * session that owns the plan counts it as a stage too.
 */
export function isSddStageAgent(block: Block, workspaceSlug: string, ownsPlan: boolean): boolean {
  const text = agentText(block);
  const all = [block.agentRun?.name, block.tool?.title, text].filter(Boolean).join("\n");
  if (SDD_FILE.test(all) || all.includes(`.superpowers/sdd/${workspaceSlug}`)) return true;
  return !text && ownsPlan;
}

/** Subagents of the transcript; `skip` leaves out the ones another section already shows. */
export function buildAgentSection(
  blocks: readonly Block[],
  _now: number,
  skip?: (block: Block) => boolean,
): BoardSection | undefined {
  const nodes = blocks.filter((block) => isAgentBlock(block) && !skip?.(block)).map(agentNode);
  return nodes.length ? sectionOf("agents", "agents", "Subagents", nodes) : undefined;
}

function latestDispatch(
  dispatches: readonly OrchestrationDispatch[] | undefined,
  taskId: string,
): OrchestrationDispatch | undefined {
  let latest: OrchestrationDispatch | undefined;
  for (const d of dispatches ?? []) {
    if (d.taskId === taskId && (!latest || d.startedAt >= latest.startedAt)) latest = d;
  }
  return latest;
}

export function buildOrchestrationSection(
  run: OrchestrationRun | undefined,
  _now: number,
): BoardSection | undefined {
  if (!run?.tasks.length) return undefined;
  const nodes = run.tasks.map<BoardNode>((task) => {
    const status = ORCHESTRATION_STATUS[task.status] ?? "pending";
    // A queued task is waiting for a retry: an older dispatch is not its time.
    const dispatch = status === "pending" ? undefined : latestDispatch(run.dispatches, task.id);
    const startedAt = isTime(dispatch?.startedAt) ? dispatch.startedAt : undefined;
    const settled = status !== "running";
    const endedAt = settled ? saneEnd(startedAt, dispatch?.updatedAt) : undefined;
    return {
      id: task.id,
      title: task.title,
      status,
      target: { kind: "session", ref: task.sessionId },
      ...(task.dependsOn.length ? { dependsOn: [...task.dependsOn] } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
    };
  });
  return sectionOf("orchestration", "orchestration", "Orchestration", nodes);
}

function normalizeTitle(title: string): string {
  return title.replace(TITLE_PREFIX, "").trim().toLowerCase();
}

/** The lead copied its plan into a to-do list: showing both would list every task twice. */
export function dropMirroredTodos(
  todos: BoardSection | undefined,
  plan: BoardSection | undefined,
): BoardSection | undefined {
  if (!todos || !plan || !plan.nodes.length) return todos;
  const planTitles = plan.nodes.map((n) => normalizeTitle(n.title));
  const todoTitles = todos.nodes.map((n) => normalizeTitle(n.title));
  const sameInOrder =
    todoTitles.length === planTitles.length && todoTitles.every((t, i) => t === planTitles[i]);
  if (sameInOrder) return undefined;
  if (todoTitles.length !== plan.total) return todos;
  const known = new Set(planTitles);
  const matching = todoTitles.filter((t) => known.has(t)).length;
  return matching >= MIRROR_MATCH_RATIO * todoTitles.length ? undefined : todos;
}
