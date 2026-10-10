import { openUrl } from "@tauri-apps/plugin-opener";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { copyText } from "../../../platform/tauri/clipboard";
import { EyeOff } from "../../../shared/ui/icons";
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
import { PrSetCard, type PrCardStatus } from "./PrSetCard";
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
const UNDO_MS = 6000;

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
  const [status, setStatus] = useState<PrCardStatus | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(statusTimer.current), []);

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

  // A status (and its Undo) belongs to one look at the card.
  useEffect(() => {
    if (cardOpen) return;
    clearTimeout(statusTimer.current);
    setStatus(null);
  }, [cardOpen]);

  const closeCard = useCallback(() => {
    // Keep focus on the chip if it was in the card (a ⋯ menu item).
    close(!!card.surfaceRef.current?.contains(document.activeElement));
  }, [card.surfaceRef, close]);

  if (!view || !shown) return null;

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
            hiddenOnly={hiddenOnly}
            onFocusLost={() =>
              card.triggerRef.current?.focus({ preventScroll: true })
            }
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
