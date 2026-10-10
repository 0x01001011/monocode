import type {
  Attention,
  Checks,
  PrEntry,
  PrEntryLite,
  PrSetView,
  PrStackGroup,
  PrStackView,
  PrState,
  PrSummary,
  Relation,
  Review,
  TrackerStatus,
} from "../../src/features/pr-tracking/model/types";

/**
 * Fixture data for the PR tracking browser harness (`pr-tracking.html`).
 * Everything is a wire payload exactly as Rust would send it, so the real
 * store, hooks and components run on it unchanged.
 */

export const SESSION = "chat-tasks";
export const NEIGHBOR_SESSION = "chat-neighbor";
export const SESSION_TITLE = "Tasks panel keyboard";
export const NEIGHBOR_TITLE = "Rail fit follow-up";
export const REPO = "monocode/desktop";
export const RAIL_REPO = "monocode/rail";
export const BRANCH = "mc/tasks-panel-keyboard-navigation";
export const CWD = "/Users/dev/projects/monocode-desktop";

const MINUTE = 60_000;

type PrOptions = {
  title?: string;
  state?: PrState;
  isDraft?: boolean;
  headRef?: string;
  baseRef?: string;
  checks?: Checks;
  review?: Review;
  mergeable?: PrEntry["snapshot"]["mergeable"];
  behindBy?: number | null;
  relation?: Relation;
  ownerSessionId?: string | null;
  onLiveBranch?: boolean;
  parent?: number | null;
  attention?: Attention;
  attentionReason?: string | null;
  dismissed?: boolean;
  author?: string | null;
  fetchedAgo?: number;
  repo?: string;
};

function pr(now: number, number: number, o: PrOptions = {}): PrEntry {
  const repo = o.repo ?? REPO;
  return {
    snapshot: {
      repo,
      number,
      url: `https://github.com/${repo}/pull/${number}`,
      title: o.title ?? `Pull request ${number}`,
      state: o.state ?? "open",
      isDraft: o.isDraft ?? false,
      headRef: o.headRef ?? `mc/pr-${number}`,
      baseRef: o.baseRef ?? "main",
      originalBaseRef: o.baseRef ?? "main",
      headOid: `${number}`.padEnd(40, "0"),
      author: o.author ?? "khoa",
      checks: o.checks ?? "passing",
      review: o.review ?? "none",
      mergeable: o.mergeable ?? "mergeable",
      behindBy: o.behindBy ?? null,
      fetchedAt: now - (o.fetchedAgo ?? 30_000),
    },
    relation: o.relation ?? "owned",
    ownerSessionId:
      o.ownerSessionId === undefined ? SESSION : o.ownerSessionId,
    onLiveBranch: o.onLiveBranch ?? false,
    parent: o.parent ?? null,
    attention: o.attention ?? "none",
    attentionReason: o.attentionReason ?? null,
    dismissed: o.dismissed ?? false,
    error: null,
  };
}

function view(
  now: number,
  entries: PrEntry[],
  stacks: PrStackGroup[],
  extra: Partial<PrSetView> = {},
): PrSetView {
  return {
    sessionId: SESSION,
    entries,
    stacks,
    tracking: "full",
    status: "ok",
    refreshedAt: now - 30_000,
    ...extra,
  };
}

/** 3-stack (#478 base, #480 merged middle, #482 tip on HEAD) plus Other. */
function stackEntries(now: number, fetchedAgo?: number): PrEntry[] {
  return [
    pr(now, 478, {
      title: "Extract the PR tracker lease into its own module",
      headRef: "mc/tracker-lease",
      baseRef: "main",
      review: "approved",
      fetchedAgo,
    }),
    pr(now, 480, {
      title: "Batch aliased GraphQL queries per repository",
      state: "merged",
      headRef: "mc/batched-graphql",
      baseRef: "mc/tracker-lease",
      parent: 478,
      fetchedAgo,
    }),
    pr(now, 482, {
      title: "Tasks panel keyboard navigation and focus order",
      headRef: BRANCH,
      baseRef: "mc/batched-graphql",
      checks: "failing",
      review: "changesRequested",
      parent: 480,
      onLiveBranch: true,
      attention: "block",
      attentionReason: "Checks failing",
      fetchedAgo,
    }),
    pr(now, 470, {
      title: "Draft: composer chip container queries",
      isDraft: true,
      headRef: "mc/chip-cq",
      checks: "pending",
      attention: "pending",
      fetchedAgo,
    }),
    pr(now, 465, {
      title: "Sidebar glyph hit area",
      relation: "existing",
      headRef: "mc/sidebar-glyph",
      checks: "none",
      behindBy: 3,
      attention: "action",
      attentionReason: "Behind main by 3",
      fetchedAgo,
    }),
    pr(now, 459, {
      title: "Old approach to PR polling",
      state: "closed",
      headRef: "mc/pr-polling-v0",
      checks: "none",
      fetchedAgo,
    }),
    pr(now, 486, {
      title: "Rail fit measuring for the Inbox stack",
      relation: "other",
      ownerSessionId: NEIGHBOR_SESSION,
      headRef: "mc/rail-fit",
      mergeable: "conflicting",
      attention: "block",
      attentionReason: "Merge conflict",
      fetchedAgo,
    }),
  ];
}

const STACK: PrStackGroup = {
  repo: REPO,
  baseRef: "main",
  members: [478, 480, 482],
  mergedCount: 1,
};

function statusFixture(status: TrackerStatus) {
  return (now: number) =>
    view(now, stackEntries(now), [STACK], {
      status,
      refreshedAt: status === "ok" ? now - 30_000 : now - 4 * MINUTE,
    });
}

function many(now: number): PrSetView {
  const entries: PrEntry[] = [];
  const stacks: PrStackGroup[] = [];
  for (let s = 0; s < 2; s++) {
    const members: number[] = [];
    for (let i = 0; i < 5; i++) {
      const number = 500 + s * 5 + i;
      members.push(number);
      entries.push(
        pr(now, number, {
          title: `Stack ${s + 1} step ${i + 1}: split the tracker into reviewable pieces`,
          headRef: `mc/stack-${s + 1}-step-${i + 1}`,
          baseRef: i === 0 ? "main" : `mc/stack-${s + 1}-step-${i}`,
          state: i === 0 && s === 1 ? "merged" : "open",
          parent: i === 0 ? null : number - 1,
          onLiveBranch: s === 0 && i === 4,
          checks: i % 3 === 0 ? "pending" : "passing",
        }),
      );
    }
    stacks.push({
      repo: REPO,
      baseRef: "main",
      members,
      mergedCount: s === 1 ? 1 : 0,
    });
  }
  const states: PrState[] = ["open", "open", "merged", "closed"];
  for (let i = 0; i < 30; i++) {
    const number = 510 + i;
    entries.push(
      pr(now, number, {
        title: `Follow-up ${i + 1}: tidy pull request tracking edge case`,
        headRef: `mc/follow-up-${i + 1}`,
        state: states[i % 4],
        isDraft: i % 7 === 3,
        checks: i % 5 === 1 ? "failing" : "passing",
        attention: i % 5 === 1 ? "block" : "none",
        attentionReason: i % 5 === 1 ? "Checks failing" : null,
        relation: i % 9 === 4 ? "existing" : "owned",
      }),
    );
  }
  return view(now, entries, stacks);
}

const LONG_TITLE =
  "Make the pull request tracker resilient when the GitHub CLI is missing, signed out, rate limited or offline, keep the last snapshot with its fetch time, and never empty the set while the user is reading it ok";

function i18n(now: number): PrSetView {
  return view(
    now,
    [
      pr(now, 701, {
        title: "修复侧边栏在窄窗口下的键盘导航与焦点顺序问题，并补充无障碍标签",
        headRef: "mc/修复-侧边栏-焦点",
        onLiveBranch: true,
        checks: "pending",
      }),
      pr(now, 702, {
        title: "🚀 Ship the 🧪 browser harness ✅ with 🎨 tokens 🔥🔥🔥 and 👩‍💻 evidence",
        headRef: "mc/emoji-🚀-branch",
        review: "approved",
      }),
      pr(now, 703, {
        title: LONG_TITLE,
        headRef:
          "mc/a-very-long-branch-name-that-keeps-going-well-past-any-reasonable-width-for-a-ref",
        baseRef: "release/2026-10-very-long-release-branch-name",
        behindBy: 128,
        attention: "action",
        attentionReason: "Behind release/2026-10-very-long-release-branch-name by 128",
      }),
      pr(now, 704, {
        title: "日本語のタイトル：プルリクエストの状態を追跡する",
        relation: "other",
        ownerSessionId: null,
        author: "a-very-long-github-username-for-testing",
      }),
    ],
    [],
  );
}

function stale(now: number): PrSetView {
  return view(now, stackEntries(now, 20 * MINUTE), [STACK], {
    refreshedAt: now - 20 * MINUTE,
  });
}

function limited(now: number): PrSetView {
  return view(
    now,
    [
      pr(now, 482, {
        title: "Tasks panel keyboard navigation and focus order",
        headRef: BRANCH,
        onLiveBranch: true,
      }),
      pr(now, 470, {
        title: "Draft: composer chip container queries",
        isDraft: true,
        headRef: "mc/chip-cq",
      }),
    ],
    [],
    { tracking: "limited" },
  );
}

function allHidden(now: number): PrSetView {
  return view(
    now,
    stackEntries(now)
      .filter((e) => e.relation !== "other")
      .map((e) => ({ ...e, dismissed: true })),
    [STACK],
  );
}

function empty(now: number): PrSetView {
  return view(now, [], []);
}

/** The neighbor chat's PR sits inside this chat's stack (hairline bar, dashed node). */
function neighbor(now: number): PrSetView {
  return view(
    now,
    [
      pr(now, 478, { title: "Extract the PR tracker lease", headRef: "mc/tracker-lease" }),
      pr(now, 479, {
        title: "Rail fit measuring (other chat)",
        relation: "other",
        ownerSessionId: NEIGHBOR_SESSION,
        headRef: "mc/rail-fit",
        baseRef: "mc/tracker-lease",
        parent: 478,
      }),
      pr(now, 482, {
        title: "Tasks panel keyboard navigation and focus order",
        headRef: BRANCH,
        baseRef: "mc/rail-fit",
        parent: 479,
        onLiveBranch: true,
      }),
    ],
    [{ repo: REPO, baseRef: "main", members: [478, 479, 482], mergedCount: 0 }],
  );
}

export const FIXTURES = {
  stack: statusFixture("ok"),
  ok: statusFixture("ok"),
  ghMissing: statusFixture("ghMissing"),
  signedOut: statusFixture("signedOut"),
  offline: statusFixture("offline"),
  idle: statusFixture("idle"),
  rateLimited: (now: number) =>
    statusFixture({ rateLimited: { until: now + 15 * MINUTE } })(now),
  many,
  i18n,
  stale,
  limited,
  hidden: allHidden,
  empty,
  neighbor,
} satisfies Record<string, (now: number) => PrSetView>;

export type FixtureName = keyof typeof FIXTURES;

export const FIXTURE_NAMES = Object.keys(FIXTURES) as FixtureName[];

/** The neighbor chat in the sidebar: one stale PR that needs action. */
export function neighborView(now: number): PrSetView {
  return {
    ...view(
      now,
      [
        pr(now, 486, {
          title: "Rail fit measuring for the Inbox stack",
          ownerSessionId: NEIGHBOR_SESSION,
          headRef: "mc/rail-fit",
          onLiveBranch: true,
          mergeable: "conflicting",
          attention: "action",
          attentionReason: "Needs restack",
          fetchedAgo: 25 * MINUTE,
        }),
      ],
      [],
      { refreshedAt: now - 25 * MINUTE },
    ),
    sessionId: NEIGHBOR_SESSION,
  };
}

/** What `pr_summaries` reports for a view (mirrors `pr_store` summary rules). */
export function summaryOf(v: PrSetView, now: number): PrSummary | null {
  const own = v.entries.filter((e) => !e.dismissed && e.relation !== "other");
  if (own.length === 0) return null;
  const live = own.filter((e) => e.onLiveBranch);
  const pool = live.length > 0 ? live : own;
  const open = pool.filter((e) => e.snapshot.state === "open");
  const pick = (open.length > 0 ? open : pool).reduce((a, b) =>
    b.snapshot.number > a.snapshot.number ? b : a,
  );
  const attention: Attention = own.some((e) => e.attention === "block")
    ? "block"
    : own.some((e) => e.attention === "action")
      ? "action"
      : "none";
  return {
    count: own.length,
    primaryNumber: pick.snapshot.number,
    primaryState: pick.snapshot.state,
    primaryIsDraft: pick.snapshot.isDraft,
    attention,
    stale: own.some((e) => now - e.snapshot.fetchedAt > 10 * MINUTE),
    members: own.map(
      (e) => `${e.snapshot.repo.toLowerCase()}#${e.snapshot.number}`,
    ),
  };
}

// ------------------------------------------------------------ Inbox rails

const RAIL_TITLES = [
  "Extract the PR tracker lease",
  "Batch aliased GraphQL queries",
  "Stack derivation from base history",
  "Health reasons ranked by urgency",
  "Composer chip and PR card",
  "Sidebar glyph and hover card",
  "Changes panel list and Base",
  "Inbox stack rail and health line",
  "Restack prompt drafting",
  "Tracker notices for gh states",
  "Browser harness and evidence",
  "Follow-up polish for narrow panes",
];

function lite(
  number: number,
  index: number,
  base: string,
  o: Partial<PrEntryLite> = {},
): PrEntryLite {
  return {
    number,
    title: RAIL_TITLES[index % RAIL_TITLES.length],
    url: `https://github.com/${RAIL_REPO}/pull/${number}`,
    state: "open",
    isDraft: false,
    headRef: `mc/rail-${number}`,
    baseRef: index === 0 ? base : `mc/rail-${number - 1}`,
    checks: "passing",
    attention: "none",
    attentionReason: null,
    ownerSessionIds: [SESSION],
    isNeighbor: false,
    ...o,
  };
}

function rail(
  first: number,
  size: number,
  overrides: Record<number, Partial<PrEntryLite>>,
): PrStackView {
  const entries = Array.from({ length: size }, (_, i) =>
    lite(first + i, i, "main", overrides[first + i]),
  );
  return {
    group: {
      repo: RAIL_REPO,
      baseRef: "main",
      members: entries.map((e) => e.number),
      mergedCount: entries.filter((e) => e.state === "merged").length,
    },
    entries,
  };
}

export type RailFixture = { id: string; current: number; view: PrStackView };

export const RAILS: RailFixture[] = [
  {
    id: "rail-3",
    current: 602,
    view: rail(601, 3, {
      601: { state: "merged" },
      602: {
        attention: "action",
        attentionReason: "Needs restack",
        checks: "pending",
      },
    }),
  },
  {
    id: "rail-6",
    current: 613,
    view: rail(611, 6, {
      611: { state: "merged" },
      612: { isNeighbor: true, ownerSessionIds: [NEIGHBOR_SESSION] },
      613: {
        attention: "block",
        attentionReason: "Merge conflict",
        checks: "failing",
      },
      616: { isDraft: true, checks: "none" },
    }),
  },
  {
    id: "rail-12",
    current: 627,
    view: rail(621, 12, {
      621: { state: "merged" },
      622: { state: "merged" },
      625: { isNeighbor: true, ownerSessionIds: [NEIGHBOR_SESSION] },
      627: {
        attention: "action",
        attentionReason: "Behind main by 4",
      },
      632: { isDraft: true },
    }),
  },
];

/** `pr_stack_for(repo, number)`: the rail holding that PR. */
export function stackFor(repo: string, number: number): PrStackView | null {
  if (repo.toLowerCase() !== RAIL_REPO) return null;
  return (
    RAILS.find((r) => r.view.group.members.includes(number))?.view ?? null
  );
}
