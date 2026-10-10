import { describe, expect, it } from "vitest";
import {
  ariaLabel,
  freshnessLabel,
  primaryEntry,
  sections,
  statusIcon,
  stripBars,
  trackerNotice,
} from "./prSetModel";
import {
  trackerKind,
  type PrEntry,
  type PrSetView,
  type PrStackGroup,
} from "./types";

const REPO = "acme/web";

function entry(
  number: number,
  over: Partial<PrEntry> & {
    snapshot?: Partial<PrEntry["snapshot"]>;
  } = {},
): PrEntry {
  const { snapshot, ...rest } = over;
  return {
    snapshot: {
      repo: REPO,
      number,
      url: `https://github.com/${REPO}/pull/${number}`,
      title: `PR ${number}`,
      state: "open",
      isDraft: false,
      headRef: `feat/${number}`,
      baseRef: "main",
      originalBaseRef: "main",
      headOid: "abc",
      author: "maya",
      checks: "passing",
      review: "none",
      mergeable: "mergeable",
      behindBy: null,
      fetchedAt: 1_000,
      ...snapshot,
    },
    relation: "owned",
    ownerSessionId: "s1",
    onLiveBranch: false,
    parent: null,
    attention: "none",
    attentionReason: null,
    dismissed: false,
    error: null,
    ...rest,
  };
}

function view(
  entries: PrEntry[],
  stacks: PrStackGroup[] = [],
  over: Partial<PrSetView> = {},
): PrSetView {
  return {
    sessionId: "s1",
    entries,
    stacks,
    tracking: "full",
    status: "ok",
    refreshedAt: 1_000,
    ...over,
  };
}

const stack = (members: number[], mergedCount = 0): PrStackGroup => ({
  repo: REPO,
  baseRef: "main",
  members,
  mergedCount,
});

describe("trackerKind", () => {
  it("reads unit variants and the rate-limited object", () => {
    expect(trackerKind("ok")).toBe("ok");
    expect(trackerKind("ghMissing")).toBe("ghMissing");
    expect(trackerKind({ rateLimited: { until: 5 } })).toBe("rateLimited");
  });
});

describe("primaryEntry", () => {
  it("prefers the live branch, then newest open, then newest", () => {
    const liveMerged = entry(1, {
      onLiveBranch: true,
      snapshot: { state: "merged" },
    });
    const openOld = entry(2);
    const openNew = entry(3);
    const closed = entry(4, { snapshot: { state: "closed" } });
    const all = [liveMerged, openOld, openNew, closed];
    expect(primaryEntry(view(all))?.snapshot.number).toBe(1);
    expect(primaryEntry(view(all.slice(1)))?.snapshot.number).toBe(3);
    expect(primaryEntry(view(all.slice(3)))?.snapshot.number).toBe(4);
  });

  it("skips dismissed and foreign entries, and returns null when none", () => {
    const skipped = [
      entry(5, { onLiveBranch: true, dismissed: true }),
      entry(6, { onLiveBranch: true, relation: "other" }),
      entry(2),
    ];
    expect(primaryEntry(view(skipped))?.snapshot.number).toBe(2);
    expect(primaryEntry(view(skipped.slice(0, 2)))).toBeNull();
    expect(primaryEntry(view([]))).toBeNull();
  });
});

describe("statusIcon", () => {
  it("maps state and draft to one icon", () => {
    expect(statusIcon(entry(1))).toBe("open");
    expect(statusIcon(entry(1, { snapshot: { isDraft: true } }))).toBe("draft");
    expect(statusIcon(entry(1, { snapshot: { state: "merged" } }))).toBe(
      "merged",
    );
    expect(
      statusIcon(entry(1, { snapshot: { state: "closed", isDraft: true } })),
    ).toBe("closed");
  });
});

describe("ariaLabel", () => {
  it("describes a failing PR at the tip of a stack among 4", () => {
    const e = entry(482, {
      onLiveBranch: true,
      attention: "block",
      attentionReason: "Checks failing",
      snapshot: { checks: "failing" },
    });
    const v = view(
      [entry(480), entry(481), e, entry(300)],
      [stack([480, 481, 482])],
    );
    expect(ariaLabel(v, e)).toBe(
      "PR 482 open, checks failing, stack 3 of 3, 4 pull requests",
    );
  });

  it("says merged without check noise", () => {
    const e = entry(480, { snapshot: { state: "merged", checks: "failing" } });
    const v = view([e, entry(481)], [stack([480, 481], 1)]);
    expect(ariaLabel(v, e)).toBe("PR 480 merged, stack 1 of 2, 2 pull requests");
  });

  it("says draft, omits the stack clause, and uses the singular", () => {
    const e = entry(7, { snapshot: { isDraft: true, checks: "pending" } });
    expect(ariaLabel(view([e]), e)).toBe(
      "PR 7 draft, checks pending, 1 pull request",
    );
  });

  it("says closed", () => {
    const e = entry(8, { snapshot: { state: "closed", checks: "none" } });
    expect(ariaLabel(view([e]), e)).toBe("PR 8 closed, 1 pull request");
  });

  it("adds the attention reason lowercased unless checks already say it", () => {
    const restack = entry(9, {
      attention: "action",
      attentionReason: "Needs restack",
      snapshot: { checks: "none" },
    });
    expect(ariaLabel(view([restack]), restack)).toBe(
      "PR 9 open, needs restack, 1 pull request",
    );
    const running = entry(10, {
      attention: "pending",
      attentionReason: "Checks running",
      snapshot: { checks: "pending" },
    });
    expect(ariaLabel(view([running]), running)).toBe(
      "PR 10 open, checks pending, 1 pull request",
    );
  });

  it("does not count dismissed or foreign PRs", () => {
    const e = entry(1);
    const v = view([
      e,
      entry(2, { dismissed: true }),
      entry(3, { relation: "other" }),
    ]);
    expect(ariaLabel(v, e)).toContain("1 pull request");
  });

  it("leaves emoji and CJK titles out of the label entirely", () => {
    const e = entry(1, { snapshot: { title: "🚀 修复登录" } });
    expect(ariaLabel(view([e]), e)).not.toContain("🚀");
  });
});

describe("stripBars", () => {
  it("orders stack members base to tip, then the rest, with kinds", () => {
    const entries = [
      entry(500, { snapshot: { state: "merged" } }), // not in a stack
      entry(12, { onLiveBranch: true }),
      entry(10, { snapshot: { state: "merged" } }),
      entry(11, { snapshot: { isDraft: true } }),
      entry(77, { relation: "other" }),
      entry(78, { relation: "existing" }),
      entry(99, { dismissed: true }),
    ];
    expect(stripBars(view(entries, [stack([10, 11, 12], 1)]))).toEqual([
      { number: 10, kind: "merged" },
      { number: 11, kind: "draft" },
      { number: 12, kind: "current" },
      { number: 500, kind: "merged" },
      { number: 77, kind: "other" },
      { number: 78, kind: "normal" },
    ]);
  });

  it("marks nothing current when no PR is on the live branch", () => {
    const bars = stripBars(view([entry(1), entry(2)]));
    expect(bars.map((b) => b.kind)).toEqual(["normal", "normal"]);
  });

  it("returns an empty strip for an empty set", () => {
    expect(stripBars(view([]))).toEqual([]);
  });

  it("never draws a closed draft as a hollow draft bar", () => {
    const bars = stripBars(
      view([
        entry(1, { snapshot: { state: "closed", isDraft: true } }),
        entry(2, {
          relation: "other",
          snapshot: { state: "closed", isDraft: true },
        }),
      ]),
    );
    expect(bars).toEqual([
      { number: 1, kind: "normal" },
      { number: 2, kind: "other" },
    ]);
  });
});

describe("sections", () => {
  it("splits stacked, loose and hidden PRs", () => {
    const entries = [
      entry(1),
      entry(2),
      entry(3),
      entry(4, { dismissed: true }),
      entry(5, { dismissed: true }),
    ];
    const out = sections(view(entries, [stack([1, 2])]));
    expect(out.stack).toEqual([stack([1, 2])]);
    expect(out.other.map((e) => e.snapshot.number)).toEqual([3]);
    expect(out.hiddenCount).toBe(2);
  });

  it("drops dismissed members from a stack and empty stacks entirely", () => {
    const entries = [
      entry(1, { dismissed: true }),
      entry(2),
      entry(3, { dismissed: true }),
    ];
    const out = sections(
      view(entries, [
        { ...stack([1, 2]), repo: REPO },
        stack([3]),
      ]),
    );
    expect(out.stack).toHaveLength(1);
    expect(out.stack[0].members).toEqual([2]);
    expect(out.other).toEqual([]);
    expect(out.hiddenCount).toBe(2);
  });

  it("keeps same-numbered PRs in different repos apart", () => {
    const a = entry(1);
    const b = entry(1, { snapshot: { repo: "acme/api" } });
    const out = sections(view([a, b], [stack([1])]));
    expect(out.other).toEqual([b]);
  });

  it("handles 40 entries and leaves emoji/CJK titles untouched", () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      entry(i + 1, {
        snapshot: { title: i % 2 ? "🚀 修复登录 ".repeat(30) : `plain ${i}` },
      }),
    );
    const out = sections(view(entries, [stack([1, 2, 3, 4, 5])]));
    expect(out.stack[0].members).toHaveLength(5);
    expect(out.other).toHaveLength(35);
    expect(out.hiddenCount).toBe(0);
    expect(out.other[0]).toBe(entries[5]);
    expect(out.other[0].snapshot.title).toBe("🚀 修复登录 ".repeat(30));
  });
});

describe("freshnessLabel", () => {
  const now = 10_000_000;
  it("formats seconds, minutes and hours", () => {
    expect(freshnessLabel(now - 12_000, now)).toBe("Updated 12s ago");
    expect(freshnessLabel(now - 59_999, now)).toBe("Updated 59s ago");
    expect(freshnessLabel(now - 3 * 60_000, now)).toBe("Updated 3m ago");
    expect(freshnessLabel(now - 2 * 3_600_000, now)).toBe("Updated 2h ago");
  });
  it("handles null and a clock slightly behind", () => {
    expect(freshnessLabel(null, now)).toBe("Not checked yet");
    expect(freshnessLabel(now + 5_000, now)).toBe("Updated 0s ago");
  });
});

describe("trackerNotice", () => {
  const now = new Date(2026, 9, 10, 8, 0).getTime();
  it("is silent when healthy", () => {
    expect(trackerNotice("ok", now)).toBeNull();
    expect(trackerNotice("idle", now)).toBeNull();
  });
  it("uses the verbatim copy", () => {
    expect(trackerNotice("signedOut", now)).toEqual({
      tone: "warn",
      text: "GitHub CLI is signed out. Run gh auth login, then refresh.",
      action: "retry",
    });
    expect(trackerNotice("offline", now)).toEqual({
      tone: "warn",
      text: "Couldn't reach GitHub. Check your connection, then retry.",
      action: "retry",
    });
    expect(trackerNotice("ghMissing", now)).toEqual({
      tone: "warn",
      text: "GitHub CLI isn't installed. Install it from cli.github.com, then refresh.",
      action: "none",
    });
  });
  it("shows the local reset time for a rate limit and hides it once lifted", () => {
    const until = new Date(2026, 9, 10, 9, 5).getTime();
    expect(trackerNotice({ rateLimited: { until } }, now)).toEqual({
      tone: "info",
      text: "GitHub rate limit reached. Status refreshes again at 09:05.",
      action: "none",
    });
    expect(trackerNotice({ rateLimited: { until: now - 1 } }, now)).toBeNull();
  });
  it("uses no em dashes", () => {
    for (const s of ["signedOut", "offline", "ghMissing"] as const) {
      expect(trackerNotice(s, now)?.text).not.toContain("—");
    }
  });
});
