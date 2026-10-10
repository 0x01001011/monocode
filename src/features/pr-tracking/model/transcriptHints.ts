import type { AgentStep, Block } from "../../sessions/model/session";

/**
 * Pull request URLs an agent mentioned in a turn. A URL printed by
 * `gh pr create`, or on a "Created pull request" line, is a PR the chat
 * created; any other PR URL is only a hint that the chat worked on it.
 */

// Owner: letters, digits, hyphens. Repo: also `.` and `_`. The number may be
// followed by a sub-page (`/files`), query or fragment, never more digits or
// letters. Anything after the number is dropped, so trailing punctuation and
// markdown brackets never reach the result.
const PR_URL =
  /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?![A-Za-z0-9_])/g;

const GH_PR_CREATE = /\bgh\s+pr\s+create\b/i;
const CREATED_LINE = /\bcreated\s+(?:a\s+)?(?:new\s+)?(?:draft\s+)?(?:pull\s+request|PR)\b/i;
/** `gh pr create` prints the existing PR's URL when one is already open. */
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

/** URLs in prose: created when their own line says so. */
function scanProse(found: Found, text: string | undefined) {
  if (!text) return;
  for (const line of text.split("\n")) {
    const urls = extractPrUrls(line);
    if (urls.length === 0) continue;
    const created = CREATED_LINE.test(line) && !ALREADY_EXISTS.test(line);
    for (const url of urls) add(found, url, created);
  }
}

/** URLs in a tool call: created when the call ran `gh pr create`. */
function scanTool(
  found: Found,
  command: (string | undefined)[],
  output: (string | undefined)[],
) {
  const creates = command.some((part) => !!part && GH_PR_CREATE.test(part));
  for (const text of [...command, ...output]) {
    if (!text) continue;
    for (const line of text.split("\n")) {
      const urls = extractPrUrls(line);
      if (urls.length === 0) continue;
      const created =
        !ALREADY_EXISTS.test(line) && (creates || CREATED_LINE.test(line));
      for (const url of urls) add(found, url, created);
    }
  }
}

function scanStep(found: Found, step: AgentStep) {
  if (step.kind === "reasoning") return;
  if (step.kind === "message") {
    scanProse(found, step.text);
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
 * assistant text, tool calls and output, and subagent steps. Reasoning and
 * user text are skipped. A URL seen in a create context anywhere in the turn
 * counts as created.
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
      scanProse(found, block.text);
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
