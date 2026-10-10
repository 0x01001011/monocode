import { isRemoteProjectPath } from "../../projects/model/recents";
import type { Block } from "../../sessions/model/session";
import { findTurnPrUrls, parsePrUrl } from "../model/transcriptHints";
import { recordPrHints, recordPrUrl } from "./prTracking";

/** What was already sent per `${sessionId}:${url}`, for this app run. */
const recorded = new Map<string, "hint" | "created">();

type TurnSession = {
  id: string;
  cwd: string;
  worktreeCwd?: string;
  blocks: readonly Pick<Block, "role" | "text" | "tool" | "agentRun">[];
};

/**
 * After a turn finishes, tells Rust about the PR URLs the agent produced:
 * `recordPrUrl` for ones it created, `recordPrHints` (grouped by repo) for
 * the rest. Each URL is sent once per chat, except that a hint may later be
 * upgraded to created. Fire and forget: it never throws or awaits, so the
 * turn pipeline cannot be held up by it. Remote chats are out of scope.
 */
export function recordTurnPrs(session: TurnSession): void {
  try {
    const cwd = session.worktreeCwd || session.cwd;
    if (!cwd || isRemoteProjectPath(cwd) || isRemoteProjectPath(session.cwd))
      return;
    const hints = new Map<string, number[]>();
    for (const { url, created } of findTurnPrUrls(session.blocks)) {
      const key = `${session.id}:${url.toLowerCase()}`;
      const prior = recorded.get(key);
      if (prior === "created" || (prior === "hint" && !created)) continue;
      if (created) {
        recorded.set(key, "created");
        void recordPrUrl(session.id, url).catch(() => undefined);
        continue;
      }
      const parsed = parsePrUrl(url);
      if (!parsed) continue;
      recorded.set(key, "hint");
      const numbers = hints.get(parsed.repo) ?? [];
      numbers.push(parsed.number);
      hints.set(parsed.repo, numbers);
    }
    for (const [repo, numbers] of hints) {
      void recordPrHints(session.id, cwd, numbers, repo).catch(() => undefined);
    }
  } catch {
    // Attribution is best effort; the turn has already finished.
  }
}
