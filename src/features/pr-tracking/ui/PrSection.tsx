import { openUrl } from "@tauri-apps/plugin-opener";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { copyText } from "../../../platform/tauri/clipboard";
import type { GitPr } from "../../../platform/tauri/fs";
import { ChevronDown, ExternalLink, Inbox } from "../../../shared/ui/icons";
import { Popover } from "../../../shared/ui/Popover";
import type { LinkedWorkItem } from "../../sessions/model/session";
import { dismissPr, refreshPrSet, usePrSet } from "../data/prTracking";
import { freshnessLabel, sections, trackerNotice } from "../model/prSetModel";
import type { PrEntry, PrSetView } from "../model/types";
import { PR_LIST_CONTAINER, PR_MENU_ITEM, PrRow, prMenuKeyDown } from "./PrRow";
import { prWorkItem, usePrClock } from "./PrSetPopover";
import { PrStatusIcon } from "./PrStatusIcon";
import { useRovingRows } from "./usePrHoverCard";

const COPIED_MS = 1600;
const UNDO_MS = 6000;

const key = (entry: PrEntry) =>
  `${entry.snapshot.repo}#${entry.snapshot.number}`;

export type PrSectionProps = {
  sessionId: string;
  /** The checkout's PR from `gh pr view`: the View target when no row is on the live branch. */
  pr?: GitPr | null;
  /** A Git action is running in the panel. */
  busy?: boolean;
  /** Opens a PR in the Inbox panel; without it PRs open on GitHub. */
  onOpenInbox?: (item: LinkedWorkItem) => void;
};

/**
 * Rows in panel order: the live branch first, then stacks tip first, then
 * PRs in no stack. Hidden PRs are left out.
 */
export function panelRows(view: PrSetView): PrEntry[] {
  const { stack, other } = sections(view);
  const byKey = new Map(view.entries.map((e) => [key(e), e]));
  const ordered = [
    ...stack.flatMap((group) =>
      [...group.members]
        .reverse()
        .map((n) => byKey.get(`${group.repo}#${n}`))
        .filter((e): e is PrEntry => !!e && !e.dismissed),
    ),
    ...other,
  ];
  const live = ordered.filter((e) => e.onLiveBranch);
  return [...live, ...ordered.filter((e) => !e.onLiveBranch)];
}

type ViewTarget = { number: number; url: string; entry: PrEntry | null };

/** The live branch's open PR, else the checkout's open PR from `gh`. */
function viewTarget(
  rows: PrEntry[],
  pr: GitPr | null | undefined,
): ViewTarget | null {
  const live = rows.find((e) => e.onLiveBranch && e.snapshot.state === "open");
  if (live)
    return {
      number: live.snapshot.number,
      url: live.snapshot.url,
      entry: live,
    };
  if (pr && pr.state === "open" && pr.url) {
    const match =
      rows.find((e) => e.snapshot.url === pr.url) ??
      rows.find((e) => e.snapshot.number === pr.number && e.onLiveBranch) ??
      null;
    return { number: pr.number, url: pr.url, entry: match };
  }
  return null;
}

/**
 * "Pull requests · N" in the Changes panel, ported from the mockup's panel
 * section: the chat's PRs in the shared `PrRow` (live branch first with the
 * selected fill and HEAD tag), one roving tab stop, narrow rows under 340px
 * via the `prlist` container, and a "View #N ▾" split button whose caret
 * lists the other PRs. Zero PRs renders nothing.
 */
export function PrSection({
  sessionId,
  pr,
  busy = false,
  onOpenInbox,
}: PrSectionProps) {
  const view = usePrSet(sessionId);
  const titleId = useId();
  const now = usePrClock(true);
  const rows = view ? panelRows(view) : [];
  const roving = useRovingRows(rows.length);
  const listRef = useRef<HTMLUListElement>(null);
  const [status, setStatus] = useState<{ text: string; undo?: PrEntry } | null>(
    null,
  );
  const statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(statusTimer.current), []);

  // A hidden row leaves the list; focus that dropped to the body moves to
  // the row now at its index.
  const pendingFocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = pendingFocus.current;
    if (at == null) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) {
      pendingFocus.current = null;
      return;
    }
    const list = [
      ...(listRef.current?.querySelectorAll<HTMLElement>("[data-pr-row]") ??
        []),
    ];
    const next = list[Math.min(at, list.length - 1)];
    if (next) {
      pendingFocus.current = null;
      next.focus({ preventScroll: true });
    }
  });

  if (!view || rows.length === 0) return null;

  const announce = (next: { text: string; undo?: PrEntry }, ms: number) => {
    clearTimeout(statusTimer.current);
    setStatus(next);
    statusTimer.current = setTimeout(() => setStatus(null), ms);
  };
  const openGithub = (entry: PrEntry) =>
    void openUrl(entry.snapshot.url).catch(() => undefined);
  const openInbox = (entry: PrEntry) => {
    if (onOpenInbox) onOpenInbox(prWorkItem(entry));
    else openGithub(entry);
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
    if (dismissed) pendingFocus.current = Math.max(0, rows.indexOf(entry));
    void dismissPr(
      sessionId,
      entry.snapshot.repo,
      entry.snapshot.number,
      dismissed,
    );
    if (dismissed)
      announce(
        { text: `Hidden #${entry.snapshot.number}`, undo: entry },
        UNDO_MS,
      );
    else {
      clearTimeout(statusTimer.current);
      setStatus(null);
    }
  };

  const target = viewTarget(rows, pr);
  const others = rows.filter((e) => e !== target?.entry);
  const openTarget = () => {
    if (!target) return;
    if (target.entry) openInbox(target.entry);
    else void openUrl(target.url).catch(() => undefined);
  };
  const notice = trackerNotice(view.status, now);

  return (
    <section
      className={`pr-section ${PR_LIST_CONTAINER}`}
      aria-labelledby={titleId}
    >
      <div className="pr-section-head">
        <h4 id={titleId} data-pr-section-title="">
          Pull requests
        </h4>
        <span className="pr-section-count" data-pr-section-count="">
          {rows.length}
        </span>
        <span className="pr-card-updated">
          {freshnessLabel(view.refreshedAt, now)}
        </span>
      </div>
      {notice ? (
        <div className="pr-notice" data-tone={notice.tone}>
          <span className="min-w-0">{notice.text}</span>
          {notice.action === "retry" ? (
            <button
              type="button"
              className="pr-notice-act"
              onClick={() => void refreshPrSet(sessionId)}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      <ul
        ref={listRef}
        className="pr-list"
        aria-labelledby={titleId}
        onKeyDown={roving.onKeyDown}
        onFocus={roving.onFocus}
      >
        {rows.map((entry, i) => (
          <PrRow
            key={key(entry)}
            entry={entry}
            selected={entry.onLiveBranch}
            tabIndex={i === roving.activeIndex ? 0 : -1}
            now={now}
            onOpenInbox={openInbox}
            onOpenGithub={openGithub}
            onCopyLink={copyLink}
            onDismiss={dismiss}
          />
        ))}
      </ul>
      <div className="pr-section-status">
        <span role="status" className={status ? "truncate" : "sr-only"}>
          {status?.text ?? ""}
        </span>
        {status?.undo ? (
          <button
            type="button"
            className="pr-undo"
            onClick={() => dismiss(status.undo!, false)}
          >
            Undo
          </button>
        ) : null}
      </div>
      {target ? (
        <ViewSplitButton
          target={target}
          others={others}
          busy={busy}
          onOpenTarget={openTarget}
          onOpenOther={openInbox}
        />
      ) : null}
    </section>
  );
}

const SPLIT_BTN =
  "flex h-7 min-w-0 items-center gap-1.5 bg-content/10 px-2 text-[12px] font-medium text-content hover:bg-content/15 disabled:opacity-40";

function ViewSplitButton({
  target,
  others,
  busy,
  onOpenTarget,
  onOpenOther,
}: {
  target: ViewTarget;
  others: PrEntry[];
  busy: boolean;
  onOpenTarget: () => void;
  onOpenOther: (entry: PrEntry) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const caretRef = useRef<HTMLButtonElement>(null);
  const title = target.entry
    ? `View PR #${target.number}: ${target.entry.snapshot.title}`
    : `View PR #${target.number}`;
  return (
    <div className="pr-split">
      <button
        type="button"
        title={title}
        disabled={busy}
        onClick={onOpenTarget}
        className={`${SPLIT_BTN} flex-1 ${others.length > 0 ? "rounded-l-md" : "rounded-md"}`}
      >
        <ExternalLink
          aria-hidden="true"
          className="size-3.5 shrink-0"
          strokeWidth={1.75}
        />
        <span className="min-w-0 truncate">View #{target.number}</span>
      </button>
      {others.length > 0 ? (
        <button
          ref={caretRef}
          type="button"
          aria-label="More pull requests"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          className={`${SPLIT_BTN} w-7 shrink-0 justify-center rounded-r-md px-0 aria-expanded:bg-content/15`}
        >
          <ChevronDown
            aria-hidden="true"
            className="size-3.5"
            strokeWidth={2}
          />
        </button>
      ) : null}
      {menuOpen ? (
        <SplitMenu
          anchor={caretRef}
          entries={others}
          onClose={(refocus) => {
            setMenuOpen(false);
            if (refocus) caretRef.current?.focus();
          }}
          onOpen={onOpenOther}
        />
      ) : null}
    </div>
  );
}

function SplitMenu({
  anchor,
  entries,
  onClose,
  onOpen,
}: {
  anchor: { current: HTMLElement | null };
  entries: PrEntry[];
  onClose: (refocus: boolean) => void;
  onOpen: (entry: PrEntry) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    surface.current
      ?.querySelector<HTMLElement>('[role="menuitem"]')
      ?.focus({ preventScroll: true });
  }, []);

  return (
    <Popover
      ref={surface}
      anchor={anchor}
      side="bottom"
      align="end"
      width={280}
      role="menu"
      data-pr-split-menu=""
      aria-label="Other pull requests"
      onDismiss={(reason) => onClose(reason === "escape")}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) =>
        prMenuKeyDown(event, surface.current, () => onClose(true))
      }
      className="p-1"
    >
      {entries.map((entry) => (
        <button
          key={key(entry)}
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-pr-number={entry.snapshot.number}
          title={entry.snapshot.title}
          className={PR_MENU_ITEM}
          onClick={() => {
            onClose(true);
            onOpen(entry);
          }}
        >
          <PrStatusIcon
            state={entry.snapshot.state}
            isDraft={entry.snapshot.isDraft}
            checks={entry.snapshot.checks}
          />
          <span className="shrink-0 tabular-nums">
            #{entry.snapshot.number}
          </span>
          <span className="min-w-0 truncate">{entry.snapshot.title}</span>
          <Inbox
            aria-hidden="true"
            size={12}
            className="ml-auto shrink-0 text-ink-muted"
          />
        </button>
      ))}
    </Popover>
  );
}
