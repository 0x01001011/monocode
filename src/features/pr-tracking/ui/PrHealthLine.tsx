import { CircleDashed } from "../../../shared/ui/icons";
import type { PrEntryLite } from "../model/types";

/** Reasons a rebase fixes, so the restack draft is offered for them. */
export function isRestackReason(reason: string | null | undefined): boolean {
  const text = reason?.trim() ?? "";
  return text === "Needs restack" || text.startsWith("Behind ");
}

export type PrHealthLineProps = {
  entry: PrEntryLite;
  /** Chat that would receive the restack draft; no action without one. */
  sessionTitle: string | null | undefined;
  onDraftRestack: () => void;
};

/**
 * One line with the viewed PR's most urgent fact (Rust ranks the reasons),
 * from the mockup's `.health`. Restack and behind-base reasons offer to draft
 * a prompt into a related chat; drafting never sends.
 */
export function PrHealthLine({
  entry,
  sessionTitle,
  onDraftRestack,
}: PrHealthLineProps) {
  if (entry.attention === "none") return null;
  const reason =
    entry.attentionReason?.trim() ||
    (entry.attention === "block"
      ? "Blocked"
      : entry.attention === "action"
        ? "Needs action"
        : "Checks running");
  const chat = sessionTitle?.trim();
  const offer = !!chat && isRestackReason(reason);
  return (
    <div className="pr-health" role="note" data-attention={entry.attention}>
      {entry.attention === "pending" ? (
        <CircleDashed aria-hidden="true" size={12} className="text-pr-warn" />
      ) : (
        <span
          className="pr-att"
          data-kind={entry.attention}
          aria-hidden="true"
        />
      )}
      <span className="pr-health-text">{reason}</span>
      {offer ? (
        <button
          type="button"
          className="pr-health-act"
          onClick={onDraftRestack}
        >
          Draft restack prompt in “{chat}”
        </button>
      ) : null}
    </div>
  );
}
