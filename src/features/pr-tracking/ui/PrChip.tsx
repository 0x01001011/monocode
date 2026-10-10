import { useEffect, type ReactNode } from "react";
import { EyeOff } from "../../../shared/ui/icons";
import type { LinkedWorkItem } from "../../sessions/model/session";
import { setPrInterest, usePrSet } from "../data/prTracking";
import {
  ariaLabel,
  freshnessLabel,
  isSnapshotStale,
  primaryEntry,
  stripBars,
} from "../model/prSetModel";
import type { Attention, PrEntry } from "../model/types";
import { PrSetPopover, usePrClock } from "./PrSetPopover";
import { PrStatusIcon } from "./PrStatusIcon";
import { PrStrip } from "./PrStrip";
import { usePrHoverCard } from "./usePrHoverCard";

export type PrChipProps = {
  sessionId: string;
  /** The chat's display name, for the restack prompt copy. */
  sessionTitle?: string;
  /** The pane is visible; only then is this chat's tracking hot. */
  active?: boolean;
  /** Opens the PR in the Inbox panel; without it rows open GitHub. */
  onOpenInbox?: (item: LinkedWorkItem) => void;
};

/** Hot while the pane is visible and the window focused, fleet otherwise. */
function usePrInterest(sessionId: string, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const hot = () => void setPrInterest(sessionId, "hot");
    const fleet = () => void setPrInterest(sessionId, "fleet");
    hot();
    window.addEventListener("focus", hot);
    window.addEventListener("blur", fleet);
    return () => {
      window.removeEventListener("focus", hot);
      window.removeEventListener("blur", fleet);
      fleet();
    };
  }, [sessionId, active]);
}

function worstAttention(entries: PrEntry[]): Attention {
  if (entries.some((e) => e.attention === "block")) return "block";
  if (entries.some((e) => e.attention === "action")) return "action";
  return "none";
}

/**
 * The composer's PR chip, after the branch button: the primary PR's status
 * icon and number, its stack strip, `+N` for PRs outside that stack, and an
 * attention mark. Hovering previews the PrSetCard; clicking pins it. Zero
 * PRs means no chip. Narrow composers shed the strip and `+N` through the
 * `composer-head` container query in index.css.
 */
export function PrChip({ sessionId, active = true, onOpenInbox }: PrChipProps) {
  const view = usePrSet(sessionId);
  usePrInterest(sessionId, active);
  const card = usePrHoverCard();
  const now = usePrClock(card.open);

  // Never feature someone else's PR: with none of this chat's own PRs
  // visible, fall back to the hidden chip, or to no chip at all.
  const primary = view ? primaryEntry(view) : null;
  const hiddenCount = view ? view.entries.filter((e) => e.dismissed).length : 0;
  const hiddenOnly = !primary && hiddenCount > 0;
  const shown = !!view && (!!primary || hiddenOnly);
  const { open: cardOpen, close } = card;

  useEffect(() => {
    if (!shown && cardOpen) close(false);
  }, [shown, cardOpen, close]);

  if (!view || !shown) return null;

  let label: string;
  let title: string | undefined;
  let content: ReactNode;
  if (primary) {
    const { snapshot } = primary;
    const own = view.entries.filter(
      (e) => !e.dismissed && e.relation !== "other",
    );
    const group = view.stacks.find(
      (g) => g.repo === snapshot.repo && g.members.includes(snapshot.number),
    );
    const seen = new Set<number>();
    const bars = group
      ? stripBars(view).filter((bar) => {
          if (!group.members.includes(bar.number) || seen.has(bar.number))
            return false;
          seen.add(bar.number);
          return true;
        })
      : [];
    // Same set as `ariaLabel()`'s count: this chat's own visible PRs.
    const inGroup = group
      ? own.filter(
          (e) =>
            e.snapshot.repo === group.repo &&
            group.members.includes(e.snapshot.number),
        ).length
      : 1;
    const outside = Math.max(0, own.length - inGroup);
    const attention = worstAttention(view.entries.filter((e) => !e.dismissed));
    const stale = isSnapshotStale(snapshot, now);
    label = stale
      ? `${ariaLabel(view, primary)}, status may be out of date, ${freshnessLabel(snapshot.fetchedAt, now).toLowerCase()}`
      : ariaLabel(view, primary);
    title = stale ? freshnessLabel(snapshot.fetchedAt, now) : undefined;
    content = (
      <>
        <PrStatusIcon
          state={snapshot.state}
          isDraft={snapshot.isDraft}
          stale={stale}
          decorative
        />
        <span className="pr-chip-num">#{snapshot.number}</span>
        {bars.length > 1 ? <PrStrip bars={bars} /> : null}
        {outside > 0 ? <span className="pr-chip-more">+{outside}</span> : null}
        {attention !== "none" ? (
          <span className="pr-att" data-kind={attention} aria-hidden="true" />
        ) : null}
      </>
    );
  } else {
    label =
      hiddenCount === 1
        ? "1 hidden pull request"
        : `${hiddenCount} hidden pull requests`;
    content = (
      <>
        <EyeOff aria-hidden="true" size={14} className="shrink-0" />
        <span className="tabular-nums">{hiddenCount} hidden</span>
      </>
    );
  }

  return (
    <>
      <button
        ref={card.triggerRef}
        type="button"
        className={`pr-chip -ml-1.5 flex h-6 max-w-[168px] shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[12px] ${hiddenOnly ? "text-ink-muted" : "text-muted"} hover:bg-content/8 hover:text-content active:scale-[0.97] aria-expanded:bg-content/8 aria-expanded:text-content`}
        aria-label={label}
        title={title}
        {...card.triggerProps}
      >
        {content}
      </button>
      {card.open ? (
        <PrSetPopover
          sessionId={sessionId}
          view={view}
          card={card}
          now={now}
          hiddenOnly={hiddenOnly}
          side="top"
          onOpenInbox={onOpenInbox}
        />
      ) : null}
    </>
  );
}
