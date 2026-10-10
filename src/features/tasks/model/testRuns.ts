import { isExecuteTool } from "../../../integrations/harness/core/preview";
import { unwrapShellCommand } from "../../../integrations/harness/core/shellIntent";
import type { Block } from "../../sessions/model/session";
import { toolCallState } from "../../sessions/model/transcriptActivity";

/**
 * `unknown`: the call ran, but its exit status says nothing about the tests because the
 * test command is piped (`npx vitest run | tail`) and the harness reports the last stage.
 */
export type TestRunStatus = "running" | "passed" | "failed" | "unknown";

export type TestRun = {
  status: TestRunStatus;
  /** Epoch ms the run finished (else started); absent on sessions restored before timing existed. */
  at?: number;
  command: string;
};

/**
 * Only the first characters of a command are analysed (and reported). A test run is typed
 * at the start of a command; a long script (a heredoc, a generated file) is not one, and
 * the scan covers every shell block of the session on each poll. A runner that starts
 * after this many characters is not found, which reads as "no test run", never as a wrong one.
 */
const MAX_ANALYSED_CHARS = 1000;

const PM = "(?:npm|pnpm|yarn|bun)";
// Options a package manager takes before the script name: `-r`, `--filter x`, `--prefix dir`.
const OPTS = String.raw`(?:\s+(?:(?:--filter|-F|--prefix|-C|--cwd|--dir|--workspace|-w)(?:=|\s+)\S+|--?[\w-]+(?:=\S+)?))*`;
const SCRIPT_END = String.raw`(?![\w:.-])`;

// Each pattern is tested against one command (the start of a segment), after env
// assignments and launchers are stripped, so a runner named inside another word or in
// an argument (`vitest.config.ts`, `grep jest`, `git commit -m "fix jest"`) never matches.
const RUNNERS: readonly RegExp[] = [
  /^(?:\S*\/)?vitest(?![\w.-])/,
  /^(?:\S*\/)?jest(?![\w.-])/,
  /^(?:\S*\/)?pytest(?![\w.-])/,
  /^python3?\s+-m\s+pytest(?![\w.-])/,
  new RegExp(String.raw`^${PM}${OPTS}\s+(?:run(?:-script)?\s+)?test(?::[\w-]+)?${SCRIPT_END}`),
  new RegExp(String.raw`^npm${OPTS}\s+(?:t|tst)${SCRIPT_END}`),
  new RegExp(
    String.raw`^(?:npm${OPTS}\s+run|pnpm${OPTS}(?:\s+run)?|yarn${OPTS}(?:\s+run)?)\s+check(?::web)?${SCRIPT_END}`,
  ),
  /^cargo(?:\s+\+\S+)?\s+(?:test|nextest\s+run)(?![\w.-])/,
  /^go\s+test(?![\w.-])/,
  /^(?:\S*\/)?playwright\s+test(?![\w.-])/,
  /^make(?:\s+-\S+)*\s+test(?![\w.-])/,
  /^deno\s+test(?![\w.-])/,
  /^node(?:\s+-[\w=.-]+)*\s+--test(?![\w-])/,
];

const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+/;
// Words that run the rest of the command: `npx vitest`, `timeout 60 npm test`, `uv run pytest`.
const LAUNCHER = new RegExp(
  "^(?:" +
    [
      String.raw`(?:npx|bunx|time|env|exec|sudo|nohup|command)(?:\s+--?[\w-]+)*`,
      String.raw`(?:npm|pnpm|yarn|bun)\s+(?:exec|dlx)(?:\s+--?[\w-]+)*(?:\s+--)?`,
      String.raw`(?:pnpm|yarn|bun)(?=\s+(?:vitest|jest|playwright)(?![\w.-]))`,
      String.raw`(?:uv|poetry|pipenv)\s+run(?:\s+--?[\w-]+)*`,
      String.raw`timeout(?:\s+(?:-[ks]|--signal|--kill-after)\s+\S+|\s+--?[\w=.-]+)*\s+\d+(?:\.\d+)?[smhd]?`,
    ].join("|") +
    ")\\s+",
);
// What a tool row puts before the command. `bash` only counts as a tool name when it is not
// the shell being launched (`bash -lc '...'`): followed by a colon or by a non-option word.
const RUN_PREFIX = /^(?:\$\s+|(?:run(?:ning)?(?:\s+command)?|shell)\s*:?\s+|bash\s*:\s*|bash\s+(?!-))/i;

function stripPrefix(command: string): string {
  let text = command.trim();
  const ticks = /^`+([^`]*)`+$/.exec(text);
  if (ticks) text = ticks[1].trim();
  text = text.replace(RUN_PREFIX, "");
  const inner = /^`+([^`]*)`+$/.exec(text);
  return (inner ? inner[1] : text).trim();
}

// --- Segmenting ---------------------------------------------------------------------------
// A segment is the text of one simple command. Quoted text, `$(...)`, backticks, comments and
// heredoc bodies are arguments or data, never the start of another command.

/** Index of the closing `"` of the double-quoted string starting at `start` (else the end). */
function skipDouble(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === '"') return i;
    else if (c === "$" && text[i + 1] === "(") i = skipParen(text, i + 1);
    else if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end < 0) return text.length;
      i = end;
    }
  }
  return text.length;
}

/** Index of the `)` closing the `(` at `start` (else the end), skipping quoted parens. */
function skipParen(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return text.length;
      i = end;
    } else if (c === '"') i = skipDouble(text, i);
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return text.length;
}

type Heredoc = { delimiter: string; strip: boolean };

/** Reads `<<[-]WORD` at `at` (the first `<`): the delimiter and the index after it. */
function readHeredoc(text: string, at: number): { heredoc: Heredoc; end: number } | undefined {
  let i = at + 2;
  const strip = text[i] === "-";
  if (strip) i++;
  while (text[i] === " " || text[i] === "\t") i++;
  let delimiter: string;
  const quote = text[i];
  if (quote === "'" || quote === '"') {
    const close = text.indexOf(quote, i + 1);
    if (close < 0) return undefined;
    delimiter = text.slice(i + 1, close);
    i = close + 1;
  } else {
    if (text[i] === "\\") i++;
    const word = /^[^\s;&|<>()'"`]+/.exec(text.slice(i, i + 200))?.[0] ?? "";
    delimiter = word;
    i += word.length;
  }
  return delimiter ? { heredoc: { delimiter, strip }, end: i } : undefined;
}

type Scan = { segments: string[]; piped: boolean };

function scanCommand(raw: string): Scan {
  const text = raw.replace(/\r\n?/g, "\n");
  const segments: string[] = [];
  const pending: Heredoc[] = [];
  let piped = false;
  let start = 0;
  const cut = (end: number) => {
    const segment = text.slice(start, end).trim();
    if (segment) segments.push(segment);
  };
  const split = (end: number, width: number) => {
    cut(end);
    start = end + width;
    return start;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "\\") i += 2;
    else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      i = end < 0 ? text.length : end + 1;
    } else if (c === '"') i = skipDouble(text, i) + 1;
    else if (c === "`") {
      const end = text.indexOf("`", i + 1);
      i = end < 0 ? text.length : end + 1;
    } else if (c === "$" && next === "(") i = skipParen(text, i + 1) + 1;
    else if (c === "$" && next === "{") {
      const end = text.indexOf("}", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (c === "#" && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) {
      cut(i);
      const end = text.indexOf("\n", i);
      i = start = end < 0 ? text.length : end;
    } else if (c === "<" && next === "<" && text[i + 2] !== "<") {
      const read = readHeredoc(text, i);
      if (read) pending.push(read.heredoc);
      i = read ? read.end : i + 2;
    } else if (c === "\n") {
      i = split(i, 1);
      for (const { delimiter, strip } of pending.splice(0)) {
        while (i < text.length) {
          const end = text.indexOf("\n", i);
          const line = text.slice(i, end < 0 ? text.length : end);
          i = end < 0 ? text.length : end + 1;
          if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break;
        }
      }
      start = i;
    } else if ((c === "&" && next === "&") || (c === "|" && next === "|")) i = split(i, 2);
    else if (c === "|") {
      piped = true;
      i = split(i, next === "&" ? 2 : 1);
    } else if (c === ";" || c === "&" || c === "(" || c === ")" || c === "{" || c === "}") i = split(i, 1);
    else i++;
  }
  cut(text.length);
  return { segments, piped };
}

// --- Matching -----------------------------------------------------------------------------

function isRunnerSegment(segment: string): boolean {
  let text = segment.trim();
  for (let i = 0; i < 6; i++) {
    const stripped = text.replace(ENV_ASSIGNMENT, "").replace(LAUNCHER, "");
    if (stripped === text) break;
    text = stripped;
  }
  return RUNNERS.some((runner) => runner.test(text));
}

type Analysis = { runner: boolean; piped: boolean };

/** Does the command run a test runner, and is that run piped so its exit status is not the runner's? */
function analyse(command: string, depth = 0): Analysis {
  const { segments, piped } = scanCommand(unwrapShellCommand(command));
  let runner = false;
  let nestedPiped = false;
  for (const segment of segments) {
    if (isRunnerSegment(segment)) {
      runner = true;
    } else if (depth < 2) {
      // `cd x && bash -lc 'npm test'`: a shell run inside the command.
      const inner = unwrapShellCommand(segment);
      if (inner === segment) continue;
      const nested = analyse(inner, depth + 1);
      if (nested.runner) {
        runner = true;
        nestedPiped ||= nested.piped;
      }
    }
  }
  return { runner, piped: runner && (piped || nestedPiped) && !/\bpipefail\b/.test(command) };
}

/** The text a shell tool block shows as its command: the preview keeps the original argv. */
function commandsOf(block: Block): string[] {
  const tool = block.tool;
  if (!tool) return [];
  return [tool.preview?.kind === "shell" ? tool.preview.title : undefined, tool.title, block.text]
    .filter((text): text is string => Boolean(text?.trim()))
    .map((text) => stripPrefix(text.slice(0, MAX_ANALYSED_CHARS)));
}

function isShellBlock(block: Block): boolean {
  if (block.role !== "tool" || !block.tool) return false;
  return block.tool.preview?.kind === "shell" || isExecuteTool(block.tool.kind, block.tool.title);
}

/** What the harness says happened to the call; undefined when the call never ran. */
function outcomeOf(block: Block): "running" | "passed" | "failed" | undefined {
  if (block.approval?.decided === "deny") return undefined;
  const status = block.tool?.status?.toLowerCase() ?? "";
  if (status === "cancelled" || status === "canceled") return undefined;
  if (status === "failed" || status === "error") return "failed";
  return toolCallState(block) === "accepted" ? "passed" : "running";
}

/**
 * The most recent test run in the session's tool calls, newest first. The status is the
 * harness's own verdict on the call; no output is parsed. A call that was denied or
 * cancelled never ran and is skipped. A piped run is `unknown` unless it is still running.
 * Undefined when no shell call ran a known test runner.
 */
export function lastTestRun(blocks: readonly Block[] | undefined): TestRun | undefined {
  if (!blocks) return undefined;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!isShellBlock(block)) continue;
    const outcome = outcomeOf(block);
    if (outcome === undefined) continue;
    let found: { command: string; piped: boolean } | undefined;
    for (const command of commandsOf(block)) {
      const analysis = analyse(command);
      if (analysis.runner) {
        found = { command, piped: analysis.piped };
        break;
      }
    }
    if (!found) continue;
    const status: TestRunStatus = outcome !== "running" && found.piped ? "unknown" : outcome;
    // toolEndedAt can outlive a status that went back to running.
    const at = status === "running" ? block.toolStartedAt : (block.toolEndedAt ?? block.toolStartedAt);
    return { status, ...(at !== undefined && Number.isFinite(at) ? { at } : {}), command: found.command };
  }
  return undefined;
}
