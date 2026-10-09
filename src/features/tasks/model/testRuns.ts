import { isExecuteTool } from "../../../integrations/harness/core/preview";
import { unwrapShellCommand } from "../../../integrations/harness/core/shellIntent";
import type { Block } from "../../sessions/model/session";
import { toolCallState } from "../../sessions/model/transcriptActivity";

export type TestRunStatus = "running" | "passed" | "failed";

export type TestRun = {
  status: TestRunStatus;
  /** Epoch ms the run finished (else started); absent on sessions restored before timing existed. */
  at?: number;
  command: string;
};

// Each pattern is tested against one command (the start of a `&&`, `;` or `|` segment), after
// env assignments and launchers are stripped, so a runner named inside another word or in
// an argument (`vitest.config.ts`, `grep jest`, `git commit -m "fix jest"`) never matches.
const RUNNERS: readonly RegExp[] = [
  /^(?:\S*\/)?vitest(?![\w.-])/,
  /^(?:\S*\/)?jest(?![\w.-])/,
  /^(?:\S*\/)?pytest(?![\w.-])/,
  /^python3?\s+-m\s+pytest(?![\w.-])/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)?(?![\w:.-])/,
  /^(?:npm\s+run|pnpm(?:\s+run)?|yarn(?:\s+run)?)\s+check(?::web)?(?![\w:.-])/,
  /^cargo(?:\s+\+\S+)?\s+test(?![\w.-])/,
  /^go\s+test(?![\w.-])/,
  /^(?:\S*\/)?playwright\s+test(?![\w.-])/,
];

const SEGMENT_BREAK = /&&|\|\||[;|&\n(){}]/;
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=\S*\s+/;
const LAUNCHER = /^(?:(?:npx|bunx|time|env|exec|sudo|nohup|command)(?:\s+--?[\w-]+)*|pnpm\s+(?:exec|dlx)|yarn\s+dlx)\s+/;
const RUN_PREFIX = /^(?:run(?:ning)?(?:\s+command)?|bash|shell)\s*:?\s+/i;

function isRunnerSegment(segment: string): boolean {
  let text = segment.trim();
  for (let i = 0; i < 6; i++) {
    const stripped = text.replace(ENV_ASSIGNMENT, "").replace(LAUNCHER, "");
    if (stripped === text) break;
    text = stripped;
  }
  return RUNNERS.some((runner) => runner.test(text));
}

function runsATestRunner(command: string): boolean {
  return unwrapShellCommand(command.trim().replace(RUN_PREFIX, ""))
    .split(SEGMENT_BREAK)
    .some(isRunnerSegment);
}

/** The text a shell tool block shows as its command: the preview keeps the original argv. */
function commandsOf(block: Block): string[] {
  const tool = block.tool;
  if (!tool) return [];
  return [tool.preview?.kind === "shell" ? tool.preview.title : undefined, tool.title, block.text].filter(
    (text): text is string => Boolean(text?.trim()),
  );
}

function isShellBlock(block: Block): boolean {
  if (block.role !== "tool" || !block.tool) return false;
  return block.tool.preview?.kind === "shell" || isExecuteTool(block.tool.kind, block.tool.title);
}

/**
 * The most recent test run in the session's tool calls, newest first. The status is the
 * harness's own verdict on the call (`toolCallState`); no output is parsed. Undefined when
 * no shell call ran a known test runner.
 */
export function lastTestRun(blocks: readonly Block[] | undefined): TestRun | undefined {
  if (!blocks) return undefined;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!isShellBlock(block)) continue;
    const command = commandsOf(block).find(runsATestRunner);
    if (command === undefined) continue;
    const state = toolCallState(block);
    const status: TestRunStatus = state === "rejected" ? "failed" : state === "accepted" ? "passed" : "running";
    // toolEndedAt can outlive a status that went back to running.
    const at = status === "running" ? block.toolStartedAt : (block.toolEndedAt ?? block.toolStartedAt);
    return { status, ...(at !== undefined && Number.isFinite(at) ? { at } : {}), command: command.trim().replace(RUN_PREFIX, "") };
  }
  return undefined;
}
