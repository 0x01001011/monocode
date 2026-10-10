import type { AgentStep, Block } from "../../sessions/model/session";

/**
 * Pull request URLs an agent mentioned in a turn. Only the output of a
 * `gh pr create` call can mark a PR as created by the chat; everything else
 * is at most a hint, which Rust shows only when the PR's head is one of the
 * chat's branches. Created rows are sticky, so this errs towards hints.
 */

// Owner: letters, digits, hyphens. Repo: also `.` and `_`. The number may be
// followed by a sub-page (`/files`), query or fragment, never more digits or
// letters. Anything after the number is dropped, so trailing punctuation and
// markdown brackets never reach the result.
const PR_URL =
  /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?![A-Za-z0-9_])/g;

const GH_PR_CREATE = /\bgh\s+pr\s+create\b/i;
/** Read-only `gh pr` commands: their output lists PRs the chat did not make. */
const GH_PR_READ = /\bgh\s+pr\s+(?:view|list|status|checks|diff)\b/i;
/** `gh pr create` prints the existing PR's URL, on the next line, when one is open. */
const ALREADY_EXISTS = /\balready\s+exists\b/i;

const canonical = (owner: string, repo: string, number: number) =>
  `https://github.com/${owner}/${repo}/pull/${number}`;

/** De-duplicated `https://github.com/<o>/<r>/pull/<n>` URLs, in order. */
export function extractPrUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(PR_URL)) {
    const [, owner, repo, digits] = match;
    const number = Number(digits);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const url = canonical(owner, repo, number);
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

/** `{ repo: "owner/name", number }` for a URL `extractPrUrls` returns. */
export function parsePrUrl(
  url: string,
): { repo: string; number: number } | null {
  // A non-global copy: exec on the shared /g regex would carry lastIndex.
  const match = new RegExp(PR_URL.source).exec(url);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { repo: `${match[1]}/${match[2]}`, number };
}

export type TurnPrUrl = { url: string; created: boolean };

type Found = Map<string, TurnPrUrl>;

function add(found: Found, url: string, created: boolean) {
  const key = url.toLowerCase();
  const prior = found.get(key);
  if (prior) prior.created ||= created;
  else found.set(key, { url, created });
}

function hints(found: Found, texts: (string | undefined)[]) {
  for (const text of texts) {
    if (text) for (const url of extractPrUrls(text)) add(found, url, false);
  }
}

/**
 * One tool call. `command` is what ran (title, preview title, label);
 * `output` is what it printed, which may hold a copy of the command (a
 * pending call's detail is the request summary), so output naming
 * `gh pr create` counts as command text. Rules:
 * - `gh pr view/list/...`: nothing at all.
 * - `gh pr create`: the last PR URL in its output is created, unless the
 *   output says "already exists"; every other URL is a hint.
 * - anything else: hints.
 */
function scanTool(
  found: Found,
  command: (string | undefined)[],
  output: (string | undefined)[],
) {
  const commandText = [
    ...command,
    ...output.filter((text) => !!text && GH_PR_CREATE.test(text)),
  ].filter((text): text is string => !!text);
  const printed = output.filter(
    (text): text is string => !!text && !GH_PR_CREATE.test(text),
  );
  if (commandText.some((text) => GH_PR_READ.test(text))) return;
  hints(found, commandText);
  const creates = commandText.some((text) => GH_PR_CREATE.test(text));
  const lines = printed.join("\n").split("\n");
  const exists = printed.some((text) => ALREADY_EXISTS.test(text));
  let last: string | undefined;
  for (const line of lines) {
    const urls = extractPrUrls(line);
    for (const url of urls) add(found, url, false);
    if (urls.length > 0) last = urls[urls.length - 1];
  }
  if (creates && !exists && last) add(found, last, true);
}

function scanStep(found: Found, step: AgentStep) {
  if (step.kind === "reasoning") return;
  if (step.kind === "message") {
    hints(found, [step.text]);
    return;
  }
  scanTool(
    found,
    [step.text, step.preview?.title],
    [step.detail, step.preview?.output],
  );
}

type TurnBlock = Pick<Block, "role" | "text" | "tool" | "agentRun">;

/**
 * PR URLs from the latest turn (blocks after the last user message):
 * assistant text and subagent messages (hints), tool calls and subagent
 * tool steps (see `scanTool`). Reasoning and user text are skipped. A URL
 * created by any call in the turn counts as created.
 */
export function findTurnPrUrls(blocks: readonly TurnBlock[]): TurnPrUrl[] {
  let start = 0;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].role === "user") {
      start = i + 1;
      break;
    }
  }
  const found: Found = new Map();
  for (const block of blocks.slice(start)) {
    if (block.role === "assistant" || block.role === "plan") {
      hints(found, [block.text]);
    } else if (block.role === "tool") {
      const tool = block.tool;
      scanTool(
        found,
        [tool?.title, tool?.preview?.title],
        [tool?.detail, tool?.preview?.output, block.text],
      );
    }
    for (const step of block.agentRun?.steps ?? []) scanStep(found, step);
  }
  return [...found.values()];
}
