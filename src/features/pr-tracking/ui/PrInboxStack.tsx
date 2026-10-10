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
    const onParentHead = entry.baseRef === parent.headRef;
    const target = onParentHead
      ? parent.baseRef || view.group.baseRef
      : entry.baseRef;
    const retarget = onParentHead
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
  /** Opens another member of the stack in the Inbox. */
  onOpenPr: (entry: PrEntryLite) => void;
};

/**
 * Inbox block above the PR overview: the stack rail, then one health line.
 * Renders nothing for a PR in no stack. The restack action drafts into the
 * first related chat that owns the PR (else the first related chat) and
 * never sends.
 */
export function PrInboxStack({
  repo,
  number,
  relatedSessions,
  onOpenPr,
}: PrInboxStackProps) {
  const view = usePrStack(repo, number);
  const [added, setAdded] = useState<string | null>(null);
  useEffect(() => setAdded(null), [repo, number]);
  const entry = view?.entries.find((e) => e.number === number);
  if (!view || !entry) return null;

  const target =
    relatedSessions.find((s) => entry.ownerSessionIds.includes(s.id)) ??
    relatedSessions[0] ??
    null;
  const prompt = restackPromptText(view, number);
  const draft = () => {
    if (!target || !prompt) return;
    appendComposerDraft(target.id, prompt);
    setAdded(target.title);
  };

  return (
    <div className="pr-inbox-stack">
      <PrStackRail view={view} current={number} onOpenPr={onOpenPr} />
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
