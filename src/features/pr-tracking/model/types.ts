/**
 * TypeScript mirrors of the Rust wire types in `src-tauri/src/pr_store.rs`.
 * Everything is serde `rename_all = "camelCase"`: field names and enum
 * strings are camelCase, and `TrackerStatus` is externally tagged (unit
 * variants are bare strings, `RateLimited` is `{ rateLimited: { until } }`).
 */

export type PrState = "open" | "merged" | "closed";
export type Checks = "passing" | "failing" | "pending" | "none";
export type Review = "approved" | "changesRequested" | "reviewRequired" | "none";
export type Mergeable = "mergeable" | "conflicting" | "unknown";
/** Created by this chat | on its branch but not created by it | someone else's. */
export type Relation = "owned" | "existing" | "other";
/** Chip dot: `block` is filled, `action` is a ring. Ordered by urgency. */
export type Attention = "none" | "pending" | "action" | "block";
export type Tracking = "full" | "limited";

export type TrackerStatus =
  | "ok"
  | "ghMissing"
  | "signedOut"
  | "offline"
  | "idle"
  | { rateLimited: { until: number } };

export type TrackerKind =
  | "ok"
  | "ghMissing"
  | "signedOut"
  | "rateLimited"
  | "offline"
  | "idle";

export type PrSnapshot = {
  repo: string;
  number: number;
  url: string;
  title: string;
  state: PrState;
  isDraft: boolean;
  headRef: string;
  baseRef: string;
  originalBaseRef: string;
  headOid: string;
  author: string | null;
  checks: Checks;
  review: Review;
  mergeable: Mergeable;
  behindBy: number | null;
  /** Milliseconds since the epoch. */
  fetchedAt: number;
};

export type PrEntry = {
  snapshot: PrSnapshot;
  relation: Relation;
  ownerSessionId: string | null;
  onLiveBranch: boolean;
  /** PR number of the parent within the same repo. */
  parent: number | null;
  attention: Attention;
  /** e.g. "Checks failing", "Merge conflict", "Needs restack". */
  attentionReason: string | null;
  dismissed: boolean;
  error: string | null;
};

export type PrStackGroup = {
  repo: string;
  baseRef: string;
  /** Base first, tip last. */
  members: number[];
  mergedCount: number;
};

export type PrSetView = {
  sessionId: string;
  entries: PrEntry[];
  stacks: PrStackGroup[];
  tracking: Tracking;
  status: TrackerStatus;
  refreshedAt: number | null;
};

export type PrSummary = {
  count: number;
  primaryNumber: number;
  primaryState: PrState;
  primaryIsDraft: boolean;
  attention: Attention;
  stale: boolean;
  /** `"owner/repo#N"` (repo lowercased) for each PR counted in `count`. */
  members: string[];
};

/** One stack member as the Inbox rail shows it (`pr_stack_for`). */
export type PrEntryLite = {
  number: number;
  title: string;
  url: string;
  state: PrState;
  isDraft: boolean;
  headRef: string;
  baseRef: string;
  checks: Checks;
  attention: Attention;
  attentionReason: string | null;
  /** Chats this PR is attributed to. */
  ownerSessionIds: string[];
  /** Not the viewed PR and shares no chat with it. */
  isNeighbor: boolean;
};

/** The stack holding one PR; `entries` follow `group.members` (base first). */
export type PrStackView = {
  group: PrStackGroup;
  entries: PrEntryLite[];
};

export type PrInterestLevel = "hot" | "fleet" | "off";

export type PrSetChangedPayload = {
  /** Empty means every session. */
  sessionIds: string[];
};

export const PR_SET_CHANGED_EVENT = "pr-set-changed";

export function trackerKind(status: TrackerStatus): TrackerKind {
  return typeof status === "string" ? status : "rateLimited";
}
