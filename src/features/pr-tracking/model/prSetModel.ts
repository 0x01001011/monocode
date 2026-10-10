import {
  trackerKind,
  type PrEntry,
  type PrSetView,
  type PrStackGroup,
  type PrState,
  type TrackerStatus,
} from "./types";

export type StripBarKind = "current" | "normal" | "merged" | "draft" | "other";
export type StatusIcon = "open" | "draft" | "merged" | "closed";
export type StripBar = { number: number; kind: StripBarKind; status: StatusIcon };
export type TrackerNotice = {
  tone: "info" | "warn";
  text: string;
  action: "retry" | "none";
};

const key = (repo: string, number: number) => `${repo}#${number}`;

const isVisible = (entry: PrEntry) => !entry.dismissed;

/** Entries counted as "from this chat": not dismissed, not someone else's. */
const isOwnVisible = (entry: PrEntry) =>
  !entry.dismissed && entry.relation !== "other";

/**
 * The chat's headline PR. Mirrors `pr_store::pick_primary`: the entry on the
 * live branch, else the newest open one, else the newest. Dismissed and
 * `other` entries never qualify.
 */
export function primaryEntry(view: PrSetView): PrEntry | null {
  const eligible = view.entries.filter(isOwnVisible);
  const newest = (list: PrEntry[]) =>
    list.reduce<PrEntry | null>(
      (best, e) => (!best || e.snapshot.number > best.snapshot.number ? e : best),
      null,
    );
  const live = eligible.filter((e) => e.onLiveBranch);
  if (live.length > 0) {
    // Open beats non-open, then the higher number wins.
    const open = newest(live.filter((e) => e.snapshot.state === "open"));
    return open ?? newest(live);
  }
  const open = newest(eligible.filter((e) => e.snapshot.state === "open"));
  return open ?? newest(eligible);
}

/** Closed and merged win over draft: GitHub keeps `isDraft` on closed PRs. */
export function statusIconFor(state: PrState, isDraft: boolean): StatusIcon {
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  return isDraft ? "draft" : "open";
}

export function statusIcon(entry: PrEntry): StatusIcon {
  return statusIconFor(entry.snapshot.state, entry.snapshot.isDraft);
}

function stackPosition(
  view: PrSetView,
  entry: PrEntry,
): { index: number; size: number } | null {
  const { repo, number } = entry.snapshot;
  for (const group of view.stacks) {
    if (group.repo !== repo) continue;
    const index = group.members.indexOf(number);
    if (index >= 0) return { index: index + 1, size: group.members.length };
  }
  return null;
}

/** Screen-reader text, e.g. "PR 482 open, checks failing, stack 3 of 3, 4 pull requests". */
export function ariaLabel(view: PrSetView, primary: PrEntry): string {
  const { number, state, isDraft, checks } = primary.snapshot;
  const parts: string[] = [];
  const stateWord = state === "open" ? (isDraft ? "draft" : "open") : state;
  parts.push(`PR ${number} ${stateWord}`);

  const checksShown = state === "open" && checks !== "none";
  if (checksShown) parts.push(`checks ${checks}`);

  const reason = primary.attentionReason?.trim();
  if (reason && state === "open") {
    const lowered = reason.toLowerCase();
    if (!(checksShown && lowered.startsWith("checks"))) parts.push(lowered);
  }

  const position = stackPosition(view, primary);
  if (position) parts.push(`stack ${position.index} of ${position.size}`);

  const total = view.entries.filter(isOwnVisible).length;
  parts.push(`${total} ${total === 1 ? "pull request" : "pull requests"}`);
  return parts.join(", ");
}

/**
 * One bar per visible PR, base to tip following the stacks, then the PRs that
 * are in no stack.
 */
export function stripBars(view: PrSetView): StripBar[] {
  const visible = view.entries.filter(isVisible);
  const byKey = new Map(visible.map((e) => [key(e.snapshot.repo, e.snapshot.number), e]));
  const primary = primaryEntry(view);
  const current =
    primary && primary.onLiveBranch
      ? key(primary.snapshot.repo, primary.snapshot.number)
      : null;

  const ordered: PrEntry[] = [];
  const seen = new Set<string>();
  const push = (k: string) => {
    const entry = byKey.get(k);
    if (!entry || seen.has(k)) return;
    seen.add(k);
    ordered.push(entry);
  };
  for (const group of view.stacks) {
    for (const member of group.members) push(key(group.repo, member));
  }
  for (const entry of visible) push(key(entry.snapshot.repo, entry.snapshot.number));

  return ordered.map((entry) => {
    const k = key(entry.snapshot.repo, entry.snapshot.number);
    let kind: StripBarKind = "normal";
    if (k === current) kind = "current";
    else if (entry.snapshot.state === "merged") kind = "merged";
    // Closed wins over draft, as in `statusIcon`: a closed draft is not hollow.
    else if (entry.snapshot.state === "open" && entry.snapshot.isDraft)
      kind = "draft";
    else if (entry.relation === "other") kind = "other";
    return { number: entry.snapshot.number, kind, status: statusIcon(entry) };
  });
}

/** Stack groups, then PRs in no stack; dismissed PRs are only counted. */
export function sections(view: PrSetView): {
  stack: PrStackGroup[];
  other: PrEntry[];
  hiddenCount: number;
} {
  const hidden = new Set<string>();
  let hiddenCount = 0;
  for (const entry of view.entries) {
    if (entry.dismissed) {
      hiddenCount += 1;
      hidden.add(key(entry.snapshot.repo, entry.snapshot.number));
    }
  }
  const stacked = new Set<string>();
  const stack: PrStackGroup[] = [];
  for (const group of view.stacks) {
    const members = group.members.filter(
      (m) => !hidden.has(key(group.repo, m)),
    );
    if (members.length === 0) continue;
    for (const m of group.members) stacked.add(key(group.repo, m));
    stack.push(
      members.length === group.members.length ? group : { ...group, members },
    );
  }
  const other = view.entries.filter(
    (e) =>
      !e.dismissed && !stacked.has(key(e.snapshot.repo, e.snapshot.number)),
  );
  return { stack, other, hiddenCount };
}

/** A snapshot older than this shows a clock (never reduced opacity). */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export function isSnapshotStale(
  snapshot: Pick<PrEntry["snapshot"], "fetchedAt">,
  now: number,
): boolean {
  return now - snapshot.fetchedAt > STALE_AFTER_MS;
}

export function freshnessLabel(
  refreshedAt: number | null,
  now: number,
): string {
  if (refreshedAt == null) return "Not checked yet";
  const seconds = Math.max(0, Math.floor((now - refreshedAt) / 1000));
  if (seconds < 60) return `Updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  return `Updated ${Math.floor(minutes / 60)}h ago`;
}

function clockTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Banner copy for a degraded tracker, or null when nothing needs saying. A
 * rate limit whose `until` has already passed is treated as lifted.
 */
export function trackerNotice(
  status: TrackerStatus,
  now: number,
): TrackerNotice | null {
  switch (trackerKind(status)) {
    case "signedOut":
      return {
        tone: "warn",
        text: "GitHub CLI is signed out. Run gh auth login, then refresh.",
        action: "retry",
      };
    case "rateLimited": {
      const until = (status as { rateLimited: { until: number } }).rateLimited
        .until;
      if (until <= now) return null;
      return {
        tone: "info",
        text: `GitHub rate limit reached. Status refreshes again at ${clockTime(until)}.`,
        action: "none",
      };
    }
    case "offline":
      return {
        tone: "warn",
        text: "Couldn't reach GitHub. Check your connection, then retry.",
        action: "retry",
      };
    case "ghMissing":
      return {
        tone: "warn",
        text: "GitHub CLI isn't installed. Install it from cli.github.com, then refresh.",
        action: "none",
      };
    default:
      return null;
  }
}
