import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../../../platform/tauri/clipboard";
import type { PopoverAlign, PopoverSide } from "../../../shared/lib/popover";
import { Popover } from "../../../shared/ui/Popover";
import type { LinkedWorkItem } from "../../sessions/model/session";
import { dismissPr, refreshPrSet } from "../data/prTracking";
import type { PrEntry, PrSetView } from "../model/types";
import { PrSetCard, type PrCardStatus } from "./PrSetCard";
import type { usePrHoverCard } from "./usePrHoverCard";

const COPIED_MS = 1600;
const UNDO_MS = 6000;

const workItem = (entry: PrEntry): LinkedWorkItem => ({
  kind: "pr",
  repo: entry.snapshot.repo,
  number: entry.snapshot.number,
  url: entry.snapshot.url,
});

/** Wall clock for freshness labels, ticking while the card is open. */
export function usePrClock(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [ticking]);
  return ticking ? now : Date.now();
}

export type PrSetPopoverProps = {
  sessionId: string;
  view: PrSetView;
  /** The owner's `usePrHoverCard()`; render this only while `card.open`. */
  card: ReturnType<typeof usePrHoverCard>;
  now: number;
  hiddenOnly?: boolean;
  side: PopoverSide;
  align?: PopoverAlign;
  /** Opens the PR in the Inbox panel; without it rows open GitHub. */
  onOpenInbox?: (item: LinkedWorkItem) => void;
};

/**
 * The PrSetCard in its non-modal dialog frame, with the row actions (open,
 * copy link, dismiss with undo, refresh). Shared by the composer chip and the
 * sidebar glyph so both open the same card. Mounted only while the card is
 * open, so its status line belongs to one look at the card.
 */
export function PrSetPopover({
  sessionId,
  view,
  card,
  now,
  hiddenOnly = false,
  side,
  align = "start",
  onOpenInbox,
}: PrSetPopoverProps) {
  const [status, setStatus] = useState<PrCardStatus | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(statusTimer.current), []);
  const { close, surfaceRef, triggerRef } = card;

  const closeCard = useCallback(() => {
    // Keep focus on the trigger if it was in the card (a ⋯ menu item).
    close(!!surfaceRef.current?.contains(document.activeElement));
  }, [surfaceRef, close]);

  const openGithub = (entry: PrEntry) => {
    closeCard();
    void openUrl(entry.snapshot.url).catch(() => undefined);
  };
  const openInbox = (entry: PrEntry) => {
    if (!onOpenInbox) {
      openGithub(entry);
      return;
    }
    closeCard();
    onOpenInbox(workItem(entry));
  };
  const announce = (next: PrCardStatus, ms: number) => {
    clearTimeout(statusTimer.current);
    setStatus(next);
    statusTimer.current = setTimeout(() => setStatus(null), ms);
  };
  const copyLink = (entry: PrEntry) => {
    copyText(entry.snapshot.url).then(
      () =>
        announce(
          { text: `Copied link to #${entry.snapshot.number}` },
          COPIED_MS,
        ),
      () => announce({ text: "Couldn't copy the link" }, COPIED_MS),
    );
  };
  const dismiss = (entry: PrEntry, dismissed: boolean) => {
    void dismissPr(
      sessionId,
      entry.snapshot.repo,
      entry.snapshot.number,
      dismissed,
    );
    if (dismissed) {
      announce(
        { text: `Hidden #${entry.snapshot.number}`, undo: entry },
        UNDO_MS,
      );
    } else if (status?.undo) {
      clearTimeout(statusTimer.current);
      setStatus(null);
    }
  };

  return (
    <Popover
      ref={surfaceRef}
      anchor={triggerRef}
      side={side}
      align={align}
      width={360}
      maxHeight={440}
      {...card.surfaceProps}
      className="pr-card"
      dismissOnEscape={false}
      ignore="[data-pr-row-menu]"
      onDismiss={(reason) => {
        if (reason === "outside") close(false);
      }}
    >
      <PrSetCard
        view={view}
        titleId={card.titleId}
        now={now}
        status={status}
        hiddenOnly={hiddenOnly}
        onFocusLost={() => triggerRef.current?.focus({ preventScroll: true })}
        onRefresh={() => void refreshPrSet(sessionId)}
        onOpenInbox={openInbox}
        onOpenGithub={openGithub}
        onCopyLink={copyLink}
        onDismiss={dismiss}
      />
    </Popover>
  );
}
