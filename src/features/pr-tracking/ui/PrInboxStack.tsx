import { useEffect, useState } from "react";
import { appendComposerDraft } from "../../sessions/model/composerPrefill";
import { usePrStack } from "../data/prStack";
import type { PrEntryLite, PrStackView } from "../model/types";
import { isRestackReason, PrHealthLine } from "./PrHealthLine";
import { PrStackRail } from "./PrStackRail";

const FINISH = "resolve conflicts, and force-push with lease.";

/** The PR `entry` is stacked on: the member whose head it targets, else the one before it. */
function parentOf(view: PrStackView, entry: PrEntryLite): PrEntryLite | null {
  const byBranch = view.entries.find(
    (e) => e.number !== entry.number && e.headRef === entry.baseRef,
  );
  if (byBranch) return byBranch;
  const index = view.entries.findIndex((e) => e.number === entry.number);
  return index > 0 ? (view.entries[index - 1] ?? null) : null;
}

/**
 * Branch a PR lands on once `parent` (merged) is out of the way: walk up past
 * merged ancestors to the first open one's head, or to the branch the last
 * merged one went into (the default branch at the bottom of the stack).
 */
function landingBranch(view: PrStackView, parent: PrEntryLite): string {
  let current = parent;
  const seen = new Set([current.number]);
  while (current.state === "merged") {
    const up = view.entries.find(
      (e) => e.headRef === current.baseRef && !seen.has(e.number),
    );
    if (!up) return current.baseRef || view.group.baseRef;
    seen.add(up.number);
    current = up;
  }
  return current.headRef;
}

/**
 * Prompt for the agent that restacks PR `number`, or null when its reason is
 * not one a rebase fixes. Plain text the user reviews before sending.
 */
export function restackPromptText(
  view: PrStackView,
  number: number,
): string | null {
  const entry = view.entries.find((e) => e.number === number);
  const reason = entry?.attentionReason?.trim() ?? "";
  if (!entry || !isRestackReason(reason)) return null;
  const head = entry.headRef;

  if (reason.startsWith("Behind ")) {
    const count = Number(/ by (\d+)$/.exec(reason)?.[1] ?? 0);
    const behind =
      count > 0
        ? `it is ${count} ${count === 1 ? "commit" : "commits"} behind`
        : "it is behind";
    return `Update #${number} with ${entry.baseRef}: ${behind}. Rebase ${head} onto ${entry.baseRef}, ${FINISH}`;
  }

  const parent = parentOf(view, entry);
  if (!parent) {
    return `Restack #${number} onto ${entry.baseRef}. Rebase ${head} onto ${entry.baseRef}, ${FINISH}`;
  }
  if (parent.state === "merged") {
    const target = landingBranch(view, parent);
    const retarget =
      entry.baseRef !== target
        ? ` Then retarget the pull request with gh pr edit ${number} --base ${target}.`
        : "";
    return `Restack #${number} onto ${target}: its parent #${parent.number} was merged. Rebase ${head} onto ${target}, ${FINISH}${retarget}`;
  }
  return `Restack #${number} onto #${parent.number}: ${parent.headRef} has new commits. Rebase ${head} onto ${parent.headRef}, ${FINISH}`;
}

export type PrInboxStackProps = {
  /** "owner/name", any case. */
  repo: string;
  number: number;
  /** Chats linked to this PR, display titles resolved, most relevant first. */
  relatedSessions: readonly { id: string; title: string }[];
  /** Display title of any live chat, so an owner that is not linked can be named. */
  sessionTitleById?: (id: string) => string | undefined;
  /** Opens another member of the stack in the Inbox. */
  onOpenPr: (entry: PrEntryLite) => void;
};

/**
 * Chat that receives the restack draft: a linked chat that owns the PR, else
 * any owner chat that still exists, else the first linked chat.
 */
function draftTarget(
  owners: readonly string[],
  related: PrInboxStackProps["relatedSessions"],
  titleOf: PrInboxStackProps["sessionTitleById"],
): { id: string; title: string } | null {
  const linkedOwner = related.find((s) => owners.includes(s.id));
  if (linkedOwner) return linkedOwner;
  for (const id of owners) {
    const title = titleOf?.(id)?.trim();
    if (title) return { id, title };
  }
  return related[0] ?? null;
}

/**
 * Inbox block above the PR overview: the stack rail (only when the PR stacks
 * with at least one other), then one health line (whenever the PR needs
 * attention). Renders nothing when neither applies. The restack action
 * drafts into the PR's owner chat (see `draftTarget`) and never sends.
 */
export function PrInboxStack({
  repo,
  number,
  relatedSessions,
  sessionTitleById,
  onOpenPr,
}: PrInboxStackProps) {
  const view = usePrStack(repo, number);
  const [added, setAdded] = useState<string | null>(null);
  useEffect(() => setAdded(null), [repo, number]);
  const entry = view?.entries.find((e) => e.number === number);
  if (!view || !entry) return null;
  const stacked = view.group.members.length >= 2 && view.entries.length >= 2;
  if (!stacked && entry.attention === "none") return null;

  const target = draftTarget(
    entry.ownerSessionIds,
    relatedSessions,
    sessionTitleById,
  );
  const prompt = restackPromptText(view, number);
  const draft = () => {
    if (!target || !prompt) return;
    appendComposerDraft(target.id, prompt);
    setAdded(target.title);
  };

  return (
    <div className="pr-inbox-stack">
      {stacked ? (
        <PrStackRail view={view} current={number} onOpenPr={onOpenPr} />
      ) : null}
      <PrHealthLine
        entry={entry}
        sessionTitle={prompt ? target?.title : null}
        onDraftRestack={draft}
      />
      {entry.attention !== "none" ? (
        <p role="status" className="pr-health-status">
          {added ? `Draft added to “${added}”` : ""}
        </p>
      ) : null}
    </div>
  );
}
