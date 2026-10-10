import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../../../platform/tauri/clipboard";
import { Popover } from "../../../shared/ui/Popover";
import type { LinkedWorkItem } from "../../sessions/model/session";
import {
  dismissPr,
  refreshPrSet,
  setPrInterest,
  usePrSet,
} from "../data/prTracking";
import {
  ariaLabel,
  freshnessLabel,
  isSnapshotStale,
  primaryEntry,
  stripBars,
} from "../model/prSetModel";
import type { Attention, PrEntry } from "../model/types";
import { PrSetCard } from "./PrSetCard";
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

const COPIED_MS = 1600;

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

/** Wall clock for freshness labels, ticking while the card is open. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [ticking]);
  return ticking ? now : Date.now();
}

function worstAttention(entries: PrEntry[]): Attention {
  if (entries.some((e) => e.attention === "block")) return "block";
  if (entries.some((e) => e.attention === "action")) return "action";
  return "none";
}

const workItem = (entry: PrEntry): LinkedWorkItem => ({
  kind: "pr",
  repo: entry.snapshot.repo,
  number: entry.snapshot.number,
  url: entry.snapshot.url,
});

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
  const now = useNow(card.open);
  const [status, setStatus] = useState<string | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(statusTimer.current), []);

  const visible = view ? view.entries.filter((e) => !e.dismissed) : [];
  const primary = view ? (primaryEntry(view) ?? visible[0] ?? null) : null;
  const { open: cardOpen, close } = card;

  useEffect(() => {
    if (!primary && cardOpen) close(false);
  }, [primary, cardOpen, close]);

  const closeCard = useCallback(() => {
    // Keep focus on the chip if it was in the card (a ⋯ menu item).
    close(!!card.surfaceRef.current?.contains(document.activeElement));
  }, [card.surfaceRef, close]);

  if (!view || !primary) return null;

  const { snapshot } = primary;
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
  const inGroup = group
    ? visible.filter(
        (e) =>
          e.snapshot.repo === group.repo &&
          group.members.includes(e.snapshot.number),
      ).length
    : 1;
  const outside = Math.max(0, visible.length - inGroup);
  const attention = worstAttention(visible);
  const stale = isSnapshotStale(snapshot, now);
  const label = stale
    ? `${ariaLabel(view, primary)}, status may be out of date, ${freshnessLabel(snapshot.fetchedAt, now).toLowerCase()}`
    : ariaLabel(view, primary);

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
  const announce = (message: string) => {
    clearTimeout(statusTimer.current);
    setStatus(message);
    statusTimer.current = setTimeout(() => setStatus(null), COPIED_MS);
  };
  const copyLink = (entry: PrEntry) => {
    copyText(entry.snapshot.url).then(
      () => announce(`Copied link to #${entry.snapshot.number}`),
      () => announce("Couldn't copy the link"),
    );
  };
  const dismiss = (entry: PrEntry, dismissed: boolean) => {
    void dismissPr(
      sessionId,
      entry.snapshot.repo,
      entry.snapshot.number,
      dismissed,
    );
  };

  return (
    <>
      <button
        ref={card.triggerRef}
        type="button"
        className="pr-chip -ml-1.5 flex h-6 max-w-[168px] shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-muted hover:bg-content/8 hover:text-content active:scale-[0.97] aria-expanded:bg-content/8 aria-expanded:text-content"
        aria-label={label}
        title={stale ? freshnessLabel(snapshot.fetchedAt, now) : undefined}
        {...card.triggerProps}
      >
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
      </button>
      {card.open ? (
        <Popover
          ref={card.surfaceRef}
          anchor={card.triggerRef}
          side="top"
          align="start"
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
            onRefresh={() => void refreshPrSet(sessionId)}
            onOpenInbox={openInbox}
            onOpenGithub={openGithub}
            onCopyLink={copyLink}
            onDismiss={dismiss}
          />
        </Popover>
      ) : null}
    </>
  );
}
