import { useId, useState, type ReactNode } from "react";
import {
  Clock,
  RefreshCw,
  Terminal,
  TriangleAlert,
} from "../../../shared/ui/icons";
import {
  STALE_AFTER_MS,
  freshnessLabel,
  sections,
  trackerNotice,
} from "../model/prSetModel";
import {
  trackerKind,
  type PrEntry,
  type PrSetView,
  type PrStackGroup,
} from "../model/types";
import { PR_LIST_CONTAINER, PrRow, type PrRowProps } from "./PrRow";
import { useRovingRows } from "./usePrHoverCard";

export type PrSetCardProps = {
  view: PrSetView;
  /** Id for the title; the dialog around the card is labelled by it. */
  titleId: string;
  now: number;
  /** Polite status line, e.g. "Copied link to #482". */
  status?: string | null;
  onRefresh: () => void;
} & Pick<
  PrRowProps,
  "onOpenInbox" | "onOpenGithub" | "onCopyLink" | "onDismiss"
>;

const key = (repo: string, number: number) => `${repo}#${number}`;

const plural = (n: number, one: string, other: string) =>
  (n === 1 ? one : other).replace("{n}", String(n));

function clockTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const Sep = () => (
  <span className="text-ink-faint" aria-hidden="true">
    ·
  </span>
);

/**
 * The chat's PRs, ported from the mockup's `cardHTML`: header with count,
 * freshness and refresh; tracker notice; "Stack · N into base · M merged"
 * groups with the tip on top joined by a connector; "Other"; a "Hidden · N"
 * toggle; footer hints. Rows form one roving tab stop. Renders the content
 * only: the owner supplies the dialog frame (see `PrChip`).
 */
export function PrSetCard({
  view,
  titleId,
  now,
  status,
  onRefresh,
  onOpenInbox,
  onOpenGithub,
  onCopyLink,
  onDismiss,
}: PrSetCardProps) {
  const idBase = useId();
  const [showHidden, setShowHidden] = useState(false);
  const { stack, other, hiddenCount } = sections(view);
  const byKey = new Map(
    view.entries.map((e) => [key(e.snapshot.repo, e.snapshot.number), e]),
  );
  const hidden = showHidden ? view.entries.filter((e) => e.dismissed) : [];

  // Tip first: merge order reads bottom-up.
  const groups = stack.map((group) => ({
    group,
    rows: [...group.members]
      .reverse()
      .map((n) => byKey.get(key(group.repo, n)))
      .filter((e): e is PrEntry => !!e),
  }));
  const ordered = [...groups.flatMap((g) => g.rows), ...other, ...hidden];
  const roving = useRovingRows(ordered.length);

  const visibleCount = view.entries.filter((e) => !e.dismissed).length;
  const notice = trackerNotice(view.status, now);
  const kind = trackerKind(view.status);
  const until =
    typeof view.status === "object" ? view.status.rateLimited.until : null;
  const rateLimited = until != null && until > now;
  const freshness = freshnessLabel(view.refreshedAt, now);
  const stale =
    view.refreshedAt != null && now - view.refreshedAt > STALE_AFTER_MS;
  const updated =
    notice && view.refreshedAt != null
      ? `Last known · ${freshness.replace(/^Updated /, "")}`
      : freshness;

  let index = 0;
  const row = (entry: PrEntry) => {
    const at = index++;
    return (
      <PrRow
        key={key(entry.snapshot.repo, entry.snapshot.number)}
        entry={entry}
        selected={entry.onLiveBranch}
        tabIndex={at === roving.activeIndex ? 0 : -1}
        now={now}
        onOpenInbox={onOpenInbox}
        onOpenGithub={onOpenGithub}
        onCopyLink={onCopyLink}
        onDismiss={onDismiss}
      />
    );
  };

  const stackLabel = (group: PrStackGroup) => (
    <>
      Stack <Sep /> {group.members.length} into{" "}
      <span className="font-mono">{group.baseRef}</span>
      {group.mergedCount > 0 ? (
        <>
          {" "}
          <Sep /> {group.mergedCount} merged
        </>
      ) : null}
    </>
  );

  let noticeIcon: ReactNode = null;
  if (notice) {
    const Icon =
      kind === "rateLimited"
        ? Clock
        : kind === "offline"
          ? TriangleAlert
          : Terminal;
    noticeIcon = (
      <Icon
        aria-hidden="true"
        size={14}
        className={`mt-px shrink-0 ${notice.tone === "warn" ? "text-pr-warn" : "text-ink-muted"}`}
      />
    );
  }

  return (
    <>
      <div className="pr-card-head">
        <span className="pr-card-title" id={titleId}>
          {plural(
            visibleCount,
            "1 pull request from this chat",
            "{n} pull requests from this chat",
          )}
        </span>
        <span
          className="pr-card-updated"
          data-stale={stale ? "true" : undefined}
        >
          {updated}
        </span>
        <button
          type="button"
          className="pr-icon-btn disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Refresh pull request status"
          title={rateLimited ? `Available at ${clockTime(until!)}` : undefined}
          disabled={rateLimited}
          onClick={onRefresh}
        >
          <RefreshCw aria-hidden="true" size={12} />
        </button>
      </div>
      <div
        className={`pr-card-body ${PR_LIST_CONTAINER} min-h-0 flex-1 overflow-y-auto overscroll-contain`}
        onKeyDown={roving.onKeyDown}
        onFocus={roving.onFocus}
      >
        {notice ? (
          <div className="pr-notice" data-tone={notice.tone}>
            {noticeIcon}
            <span className="min-w-0">{notice.text}</span>
            {notice.action === "retry" ? (
              <button
                type="button"
                className="pr-notice-act"
                onClick={onRefresh}
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
        {view.tracking === "limited" ? (
          <div className="pr-notice">
            <span className="pr-tag">Limited tracking</span>
            <span className="min-w-0">
              This agent's sandbox hides its git activity. Showing this
              worktree's branch and PRs the agent links.
            </span>
          </div>
        ) : null}
        {groups.map(({ group, rows }, i) => {
          const labelId = `${idBase}-stack-${i}`;
          return (
            <div
              key={key(group.repo, group.members[0] ?? i)}
              className="pr-stack"
            >
              <div className="pr-group-label" id={labelId}>
                {stackLabel(group)}
              </div>
              <ol
                reversed
                className="pr-list pr-stack-list"
                aria-labelledby={labelId}
              >
                {rows.map(row)}
              </ol>
            </div>
          );
        })}
        {other.length > 0 ? (
          <>
            {groups.length > 0 ? (
              <div className="pr-group-label" id={`${idBase}-other`}>
                Other
              </div>
            ) : null}
            <ul
              className="pr-list"
              aria-labelledby={groups.length > 0 ? `${idBase}-other` : titleId}
            >
              {other.map(row)}
            </ul>
          </>
        ) : null}
        {hiddenCount > 0 ? (
          <>
            <button
              type="button"
              className="pr-hidden-toggle"
              aria-expanded={showHidden}
              aria-controls={showHidden ? `${idBase}-hidden` : undefined}
              onClick={() => setShowHidden((v) => !v)}
            >
              Hidden <Sep /> {hiddenCount}
            </button>
            {showHidden ? (
              <ul
                id={`${idBase}-hidden`}
                className="pr-list"
                aria-label="Hidden pull requests"
              >
                {hidden.map(row)}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>
      <div className="pr-card-foot">
        {/* One persistent live region, so the message is announced. */}
        <span role="status" className={status ? "truncate" : "sr-only"}>
          {status ?? ""}
        </span>
        {status ? null : (
          <>
            <span>
              <kbd>↵</kbd>Open in Inbox
            </span>
            <span>
              <kbd>⌘↵</kbd>Open on GitHub
            </span>
            <span>
              <kbd>⌥↵</kbd>Copy link
            </span>
          </>
        )}
      </div>
    </>
  );
}
