import { useEffect, type ReactNode, type SyntheticEvent } from "react";
import { GitPullRequest } from "../../../shared/ui/icons";
import type { LinkedWorkItem } from "../../sessions/model/session";
import {
  ensurePrSet,
  getPrSet,
  usePrSet,
  usePrSummary,
} from "../data/prTracking";
import { linkedPrInSummary, primaryEntry } from "../model/prSetModel";
import type { PrSummary } from "../model/types";
import { PrSetPopover, usePrClock } from "./PrSetPopover";
import { PrStatusIcon } from "./PrStatusIcon";
import { usePrHoverCard } from "./usePrHoverCard";

/** The sidebar waits longer than the composer chip before previewing. */
export const PR_SIDEBAR_OPEN_DELAY = 400;

/**
 * Screen-reader text from a summary, e.g. "PR 482 open, 1 pull request" or
 * "4 pull requests, PR 482 open, blocked, status may be out of date". A
 * summary has no check or reason detail; the card says the rest.
 */
export function sidebarGlyphLabel(summary: PrSummary): string {
  const { count, primaryNumber, primaryState, primaryIsDraft } = summary;
  const state =
    primaryState === "open" ? (primaryIsDraft ? "draft" : "open") : primaryState;
  const primary = `PR ${primaryNumber} ${state}`;
  const total = `${count} ${count === 1 ? "pull request" : "pull requests"}`;
  const parts = count === 1 ? [primary] : [total, primary];
  if (summary.attention === "block") parts.push("blocked");
  else if (summary.attention === "action") parts.push("needs action");
  if (summary.stale) parts.push("status may be out of date");
  if (count === 1) parts.push(total);
  return parts.join(", ");
}

// The glyph sits inside the session row, whose pointer and click handlers
// select and drag the chat. React bubbles events from the portalled card
// through here too, so stop them before they reach the row.
const stop = (event: SyntheticEvent) => event.stopPropagation();

export type PrSidebarGlyphProps = {
  sessionId: string;
  /** Opens a PR in the Inbox panel; without it card rows open GitHub. */
  onOpenInbox?: (item: LinkedWorkItem) => void;
};

/**
 * The sidebar row's PR mark: the primary PR's status icon, or a PR icon and
 * the count for several PRs, with the attention dot (filled = blocking, ring
 * = needs action). Stale status draws a dashed outline at full contrast.
 * Hovering 400ms previews the same card as the composer chip, to the right;
 * click / Enter pins it. At rest it reads only the chat's summary; the full
 * set is warmed when the pointer or focus arrives and read once the card
 * opens. It never sets tracking interest: only the composer chip does.
 */
export function PrSidebarGlyph({ sessionId, onOpenInbox }: PrSidebarGlyphProps) {
  const summary = usePrSummary(sessionId);
  const card = usePrHoverCard({ openDelay: PR_SIDEBAR_OPEN_DELAY });
  const view = usePrSet(card.open ? sessionId : undefined);
  const now = usePrClock(card.open);
  const { open: cardOpen, pinned, close, retryPinFocus } = card;
  const loaded = !!view;

  useEffect(() => {
    if (!summary && cardOpen) close(false);
  }, [summary, cardOpen, close]);

  // A card opened on a cold cache shows "Loading pull requests" until the
  // set arrives, and closes if it cannot be loaded.
  useEffect(() => {
    if (!cardOpen || loaded) return;
    let live = true;
    void ensurePrSet(sessionId).then((next) => {
      if (live && !next) close(false);
    });
    return () => {
      live = false;
    };
  }, [cardOpen, loaded, sessionId, close]);

  // A pin made while loading moves focus in once the rows exist.
  useEffect(() => {
    if (pinned && loaded) retryPinFocus();
  }, [pinned, loaded, retryPinFocus]);

  if (!summary) return null;

  const warm = () => void getPrSet(sessionId);
  const { onPointerEnter, onClick, ...triggerProps } = card.triggerProps;
  const attention =
    summary.attention === "block" || summary.attention === "action"
      ? summary.attention
      : null;
  const hiddenOnly =
    !!view && !primaryEntry(view) && view.entries.some((e) => e.dismissed);

  return (
    <span
      className="contents"
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onAuxClick={stop}
      onContextMenu={stop}
    >
      <button
        ref={card.triggerRef}
        type="button"
        data-no-drag
        data-tauri-drag-region="false"
        className="sb-glyph"
        data-stale={summary.stale ? "true" : undefined}
        aria-label={sidebarGlyphLabel(summary)}
        title={summary.stale ? "Status may be out of date" : undefined}
        {...triggerProps}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") warm();
          onPointerEnter(event);
        }}
        onFocus={warm}
        onClick={() => {
          warm();
          onClick();
        }}
      >
        {summary.count === 1 ? (
          <PrStatusIcon
            state={summary.primaryState}
            isDraft={summary.primaryIsDraft}
            size={12}
            decorative
          />
        ) : (
          <>
            <GitPullRequest
              aria-hidden="true"
              size={12}
              className="text-content/70"
            />
            <span className="tabular-nums text-content/70">
              {summary.count}
            </span>
          </>
        )}
        {attention ? (
          <span className="pr-att" data-kind={attention} aria-hidden="true" />
        ) : null}
      </button>
      {cardOpen ? (
        <PrSetPopover
          sessionId={sessionId}
          view={view}
          card={card}
          now={now}
          hiddenOnly={hiddenOnly}
          side="right"
          onOpenInbox={onOpenInbox}
        />
      ) : null}
    </span>
  );
}

export type PrSidebarSlotProps = {
  sessionId: string;
  linkedWorkItem?: LinkedWorkItem;
  /** The row's existing linked-item badge, rendered as before. */
  badge: ReactNode;
  onOpenInbox?: (item: LinkedWorkItem) => void;
};

/**
 * The sidebar row's work-item area. The glyph replaces the linked badge only
 * when the linked PR is one of the chat's own PRs (it would say the same
 * thing twice); otherwise the badge stays and the glyph joins it when the
 * chat has PRs. With zero PRs the badge renders exactly as before. Owns the
 * PR subscriptions so a summary change re-renders this slot, not the row.
 */
export function PrSidebarSlot({
  sessionId,
  linkedWorkItem,
  badge,
  onOpenInbox,
}: PrSidebarSlotProps) {
  const summary = usePrSummary(sessionId);
  const hasPrs = !!summary;
  // Answered from the summary's members: no set fetch at rest.
  const linkedInSet = linkedPrInSummary(summary, linkedWorkItem);
  return (
    <>
      {linkedInSet ? null : badge}
      {hasPrs ? (
        <PrSidebarGlyph sessionId={sessionId} onOpenInbox={onOpenInbox} />
      ) : null}
    </>
  );
}
