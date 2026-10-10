import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Check,
  CircleDashed,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  Inbox,
  MoreHorizontal,
  TriangleAlert,
  UserCheck,
  UserRemove,
  X,
} from "../../../shared/ui/icons";
import { Popover } from "../../../shared/ui/Popover";
import {
  freshnessLabel,
  isSnapshotStale,
  statusIcon,
} from "../model/prSetModel";
import type { PrEntry } from "../model/types";
import { PR_STATUS, PrStatusIcon } from "./PrStatusIcon";

/**
 * Put this class on the element that holds a PR list. It names the `prlist`
 * inline-size container that narrow rows (under 340px) query.
 */
export const PR_LIST_CONTAINER = "pr-list-container";

export type PrRowProps = {
  entry: PrEntry;
  /** Selected fill; lists pass it for the live-branch row. */
  selected?: boolean;
  /** Follow the `prlist` container query (signals move to line 2 under 340px). */
  narrowAware?: boolean;
  /** Roving tab index from the owning list. */
  tabIndex?: number;
  /** Clock for the stale check; defaults to `Date.now()`. */
  now?: number;
  onOpenInbox: (entry: PrEntry) => void;
  onOpenGithub: (entry: PrEntry) => void;
  onCopyLink: (entry: PrEntry) => void;
  onDismiss: (entry: PrEntry, dismissed: boolean) => void;
};

type Tag = { text: string; tone?: "head" };

/** The one line-2 tag: HEAD, Not checked out, Existing, by @user, Other chat. */
function rowTag(entry: PrEntry): Tag | null {
  if (entry.onLiveBranch) return { text: "HEAD", tone: "head" };
  if (entry.relation === "other") {
    if (entry.ownerSessionId) return { text: "Other chat" };
    return entry.snapshot.author ? { text: `by @${entry.snapshot.author}` } : null;
  }
  if (entry.relation === "existing") return { text: "Existing" };
  return entry.snapshot.state === "open" ? { text: "Not checked out" } : null;
}

const plural = (n: number, one: string, other: string) =>
  (n === 1 ? one : other).replace("{n}", String(n));

/** Right-aligned glyphs for an open PR, only the ones that carry signal. */
function signals(entry: PrEntry, stale: boolean, freshness: string): ReactNode[] {
  const { state, checks, review, mergeable, behindBy } = entry.snapshot;
  const out: ReactNode[] = [];
  if (state === "open") {
    if (checks === "passing")
      out.push(
        <span key="checks" className="text-pr-open-text" title="Checks passing">
          <Check aria-hidden="true" size={12} />
        </span>,
      );
    if (checks === "failing")
      out.push(
        <span key="checks" className="text-pr-closed-text" title="Checks failing">
          <X aria-hidden="true" size={12} />
        </span>,
      );
    if (checks === "pending")
      out.push(
        <span key="checks" className="text-pr-warn" title="Checks pending">
          <CircleDashed aria-hidden="true" size={12} />
        </span>,
      );
    if (review === "approved")
      out.push(
        <span key="review" className="text-pr-open-text" title="Approved">
          <UserCheck aria-hidden="true" size={12} />
        </span>,
      );
    if (review === "changesRequested")
      out.push(
        <span key="review" className="text-pr-warn" title="Changes requested">
          <UserRemove aria-hidden="true" size={12} />
        </span>,
      );
    if (mergeable === "conflicting")
      out.push(
        <span key="conflict" className="text-pr-closed-text" title="Merge conflict">
          <TriangleAlert aria-hidden="true" size={12} />
        </span>,
      );
    if (behindBy != null && behindBy > 0)
      out.push(
        <span
          key="behind"
          className="text-pr-warn-text tabular-nums"
          title={plural(behindBy, "1 commit behind base", "{n} commits behind base")}
        >
          ↓{behindBy}
        </span>,
      );
    if (entry.attentionReason === "Needs restack")
      out.push(
        <span key="restack" className="pr-tag" data-tone="warn" title="Needs restack">
          restack
        </span>,
      );
  }
  if (stale)
    out.push(
      <span
        key="stale"
        className="text-ink-muted"
        data-pr-stale="true"
        title={freshness}
      >
        <Clock aria-hidden="true" size={12} />
      </span>,
    );
  return out;
}

/**
 * The link's name, e.g. "PR 482 open, checks failing, HEAD, mc/a → main:
 * Title". It carries the attention reason, so the mark beside it is hidden.
 */
function rowLabel(
  entry: PrEntry,
  tag: Tag | null,
  stale: boolean,
  freshness: string,
): string {
  const { number, title, state, checks, headRef, baseRef } = entry.snapshot;
  const parts = [`PR ${number} ${PR_STATUS[statusIcon(entry)].label.toLowerCase()}`];
  const checksShown = state === "open" && checks !== "none";
  if (checksShown) parts.push(`checks ${checks}`);
  if (state === "open") {
    const reason =
      entry.attentionReason?.trim().toLowerCase() ||
      (entry.attention === "block"
        ? "blocked"
        : entry.attention === "action"
          ? "needs action"
          : "");
    if (reason && !(checksShown && reason.startsWith("checks")))
      parts.push(reason);
  }
  if (stale) parts.push(`status may be out of date, ${freshness.toLowerCase()}`);
  if (tag) parts.push(tag.text);
  parts.push(`${headRef} → ${baseRef}`);
  return `${parts.join(", ")}: ${title}`;
}

/**
 * One PR in a list, ported from the mockup's `.pr-row`: line 1 is status
 * icon, number, title and signal glyphs; line 2 is `head → base` and one tag.
 * The link carries the real PR URL; activation is routed through callbacks so
 * the webview never navigates (↵ Inbox, ⌘↵ GitHub, ⌥↵ copy, ⌫ hide).
 */
export function PrRow({
  entry,
  selected = false,
  narrowAware = true,
  tabIndex = 0,
  now = Date.now(),
  onOpenInbox,
  onOpenGithub,
  onCopyLink,
  onDismiss,
}: PrRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const { snapshot } = entry;
  const stale = isSnapshotStale(snapshot, now);
  const freshness = freshnessLabel(snapshot.fetchedAt, now);
  const tag = rowTag(entry);
  const glyphs = signals(entry, stale, freshness);
  const ref = `${snapshot.headRef} → ${snapshot.baseRef}`;
  const attention =
    entry.attention === "block" || entry.attention === "action"
      ? entry.attention
      : null;

  const activate = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (event.altKey) onCopyLink(entry);
    else if (event.metaKey || event.ctrlKey) onOpenGithub(entry);
    else onOpenInbox(entry);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key !== "Backspace" && event.key !== "Delete") return;
    if (entry.dismissed) return;
    event.preventDefault();
    onDismiss(entry, true);
  };

  return (
    <li
      className={`pr-row${narrowAware ? " pr-row-cq" : ""}`}
      data-selected={selected ? "true" : undefined}
    >
      <span className="pr-ico">
        <PrStatusIcon
          state={snapshot.state}
          isDraft={snapshot.isDraft}
          checks={snapshot.checks}
          decorative
        />
        {attention ? (
          <span
            className="pr-att"
            data-kind={attention}
            aria-hidden="true"
            title={
              entry.attentionReason?.trim() ||
              (attention === "block" ? "Blocked" : "Needs action")
            }
          />
        ) : null}
      </span>
      <a
        className="pr-main"
        href={snapshot.url}
        data-pr-row=""
        tabIndex={tabIndex}
        aria-label={rowLabel(entry, tag, stale, freshness)}
        onClick={activate}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          onOpenGithub(entry);
        }}
        onKeyDown={onKeyDown}
      >
        <span className="pr-n">#{snapshot.number}</span>
        <span className="pr-ttl" title={snapshot.title}>
          {snapshot.title}
        </span>
        {glyphs.length > 0 ? <span className="pr-sig">{glyphs}</span> : null}
        <span className="pr-l2">
          <span className="pr-ref" title={ref}>
            {ref}
          </span>
          {tag ? (
            <span className="pr-tag" data-tone={tag.tone} title={tag.text}>
              {tag.text}
            </span>
          ) : null}
        </span>
      </a>
      <button
        ref={moreRef}
        type="button"
        className="pr-icon-btn pr-row-more"
        aria-label={`More actions for PR ${snapshot.number}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <MoreHorizontal aria-hidden="true" size={14} />
      </button>
      {menuOpen ? (
        <RowMenu
          entry={entry}
          anchor={moreRef}
          onClose={(refocus) => {
            setMenuOpen(false);
            if (refocus) moreRef.current?.focus();
          }}
          onOpenInbox={onOpenInbox}
          onOpenGithub={onOpenGithub}
          onCopyLink={onCopyLink}
          onDismiss={onDismiss}
        />
      ) : null}
    </li>
  );
}

export const PR_MENU_ITEM =
  "flex min-h-6 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui text-content hover:bg-selection-hover focus-visible:bg-selection-hover focus-visible:focus-ring-inset";

/**
 * Keyboard for a PR action menu: ↑/↓ (wrapping), Home and End move between
 * its `menuitem`s; Tab closes it (the owner returns focus to its button).
 */
export function prMenuKeyDown(
  event: KeyboardEvent<HTMLElement>,
  surface: HTMLElement | null,
  close: () => void,
) {
  const items = [
    ...(surface?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ];
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  let next: number | null = null;
  if (event.key === "ArrowDown") next = (at + 1) % items.length;
  else if (event.key === "ArrowUp") next = (at - 1 + items.length) % items.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else if (event.key === "Tab") {
    event.preventDefault();
    close();
    return;
  }
  if (next == null) return;
  event.preventDefault();
  items[next].focus();
}

/**
 * Focuses a just-opened menu's first `menuitem`. Popover measures itself
 * under `visibility: hidden` on its first pass, and a hidden element cannot
 * take focus, so a try that does not land is repeated on the next frame.
 */
export function useFocusFirstMenuItem(surface: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const focusFirst = () => {
      const item =
        surface.current?.querySelector<HTMLElement>('[role="menuitem"]') ?? null;
      item?.focus({ preventScroll: true });
      return !!item && document.activeElement === item;
    };
    if (focusFirst()) return;
    const frame = requestAnimationFrame(focusFirst);
    return () => cancelAnimationFrame(frame);
  }, [surface]);
}

function RowMenu({
  entry,
  anchor,
  onClose,
  onOpenInbox,
  onOpenGithub,
  onCopyLink,
  onDismiss,
}: {
  entry: PrEntry;
  anchor: { current: HTMLElement | null };
  onClose: (refocus: boolean) => void;
} & Pick<PrRowProps, "onOpenInbox" | "onOpenGithub" | "onCopyLink" | "onDismiss">) {
  const surface = useRef<HTMLDivElement>(null);
  useFocusFirstMenuItem(surface);

  const run = (action: () => void) => () => {
    onClose(true);
    action();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) =>
    prMenuKeyDown(event, surface.current, () => onClose(true));

  return (
    <Popover
      ref={surface}
      anchor={anchor}
      side="bottom"
      align="end"
      width={184}
      constrainHeight={false}
      role="menu"
      data-pr-row-menu=""
      aria-label={`Actions for PR ${entry.snapshot.number}`}
      onDismiss={(reason) => onClose(reason === "escape")}
      onKeyDown={onKeyDown}
      className="p-1"
    >
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className={PR_MENU_ITEM}
        onClick={run(() => onOpenInbox(entry))}
      >
        <Inbox aria-hidden="true" size={14} className="shrink-0" />
        Open in Inbox
      </button>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className={PR_MENU_ITEM}
        onClick={run(() => onOpenGithub(entry))}
      >
        <ExternalLink aria-hidden="true" size={14} className="shrink-0" />
        Open on GitHub
      </button>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className={PR_MENU_ITEM}
        onClick={run(() => onCopyLink(entry))}
      >
        <Copy aria-hidden="true" size={14} className="shrink-0" />
        Copy link
      </button>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className={PR_MENU_ITEM}
        onClick={run(() => onDismiss(entry, !entry.dismissed))}
      >
        <Eye aria-hidden="true" size={14} className="shrink-0" />
        {entry.dismissed ? "Show" : "Hide"}
      </button>
    </Popover>
  );
}
