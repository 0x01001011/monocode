import { describe, expect, it, vi } from "vitest";
import { baseCandidates, baseOptions, suggestBase } from "./baseSuggestion";
import type { PrEntry, PrSetView } from "./types";

const REPO = "acme/web";

function entry(
  number: number,
  over: Partial<PrEntry> & { snapshot?: Partial<PrEntry["snapshot"]> } = {},
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
      headRef: `mc/branch-${number}`,
      baseRef: "main",
      originalBaseRef: "main",
      headOid: "abc",
      author: "maya",
      checks: "none",
      review: "none",
      mergeable: "mergeable",
      behindBy: null,
      fetchedAt: 1_700_000_000_000,
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

function view(entries: PrEntry[], over: Partial<PrSetView> = {}): PrSetView {
  return {
    sessionId: "s1",
    entries,
    stacks: [],
    tracking: "full",
    status: "ok",
    refreshedAt: null,
    ...over,
  };
}

/** The mockup's stack: 478 merged, 480 on it, 482 on 480. */
const STACK = view(
  [
    entry(478, {
      snapshot: { state: "merged", headRef: "mc/tasks-row-model" },
    }),
    entry(480, {
      parent: 478,
      snapshot: {
        headRef: "mc/tasks-panel-virtual",
        baseRef: "mc/tasks-row-model",
      },
    }),
    entry(482, {
      parent: 480,
      snapshot: {
        headRef: "mc/tasks-panel-keyboard",
        baseRef: "mc/tasks-panel-virtual",
      },
    }),
  ],
  {
    stacks: [
      { repo: REPO, baseRef: "main", members: [478, 480, 482], mergedCount: 1 },
    ],
  },
);

const ancestors =
  (...refs: string[]) =>
  async (ref: string) =>
    refs.includes(ref);

describe("suggestBase", () => {
  it("stacks on an owned open PR whose head is an ancestor of HEAD", async () => {
    const one = view([
      entry(482, { snapshot: { headRef: "mc/tasks-panel-keyboard" } }),
    ]);
    await expect(
      suggestBase(one, "mc/next", "main", ancestors("mc/tasks-panel-keyboard")),
    ).resolves.toEqual({
      ref: "mc/tasks-panel-keyboard",
      prNumber: 482,
      stacked: true,
    });
  });

  it("falls back to the default branch when no candidate is an ancestor", async () => {
    await expect(
      suggestBase(STACK, "mc/next", "main", ancestors()),
    ).resolves.toEqual({ ref: "main", prNumber: null, stacked: false });
  });

  it("never suggests a merged or closed PR, and never asks about one", async () => {
    const isAncestor = vi.fn(async () => true);
    const v = view([
      entry(478, { snapshot: { state: "merged", headRef: "mc/merged" } }),
      entry(479, { snapshot: { state: "closed", headRef: "mc/closed" } }),
    ]);
    await expect(
      suggestBase(v, "mc/next", "main", isAncestor),
    ).resolves.toEqual({
      ref: "main",
      prNumber: null,
      stacked: false,
    });
    expect(isAncestor).not.toHaveBeenCalled();
  });

  it("never suggests another chat's PR or a hidden one", async () => {
    const isAncestor = vi.fn(async () => true);
    const v = view([
      entry(490, { relation: "other", ownerSessionId: "s2" }),
      entry(491, { dismissed: true }),
    ]);
    await expect(
      suggestBase(v, "mc/next", "main", isAncestor),
    ).resolves.toEqual({
      ref: "main",
      prNumber: null,
      stacked: false,
    });
    expect(isAncestor).not.toHaveBeenCalled();
  });

  it("picks the deepest ancestor in the stack", async () => {
    await expect(
      suggestBase(
        STACK,
        "mc/next",
        "main",
        ancestors("mc/tasks-panel-virtual", "mc/tasks-panel-keyboard"),
      ),
    ).resolves.toEqual({
      ref: "mc/tasks-panel-keyboard",
      prNumber: 482,
      stacked: true,
    });
  });

  it("uses parent links for depth when no stack group is known", async () => {
    const v = view([
      entry(482, { parent: 480, snapshot: { headRef: "mc/b" } }),
      entry(480, { snapshot: { headRef: "mc/a" } }),
    ]);
    await expect(
      suggestBase(v, "mc/next", "main", ancestors("mc/a", "mc/b")),
    ).resolves.toMatchObject({ ref: "mc/b", prNumber: 482 });
  });

  it("breaks a depth tie by the newer PR", async () => {
    const v = view([
      entry(470, { snapshot: { headRef: "mc/old" } }),
      entry(471, { snapshot: { headRef: "mc/new" } }),
    ]);
    await expect(
      suggestBase(v, "mc/next", "main", ancestors("mc/old", "mc/new")),
    ).resolves.toMatchObject({ ref: "mc/new", prNumber: 471 });
  });

  it("skips the live branch's own PR", async () => {
    const isAncestor = vi.fn(async () => true);
    const v = view([
      entry(482, { onLiveBranch: true, snapshot: { headRef: "mc/live" } }),
    ]);
    await expect(
      suggestBase(v, "mc/live", "main", isAncestor),
    ).resolves.toEqual({
      ref: "main",
      prNumber: null,
      stacked: false,
    });
    expect(isAncestor).not.toHaveBeenCalled();
  });

  it("treats a failed ancestry check as not an ancestor", async () => {
    const v = view([entry(482, { snapshot: { headRef: "mc/gone" } })]);
    await expect(
      suggestBase(v, "mc/next", "main", async () => {
        throw new Error("unknown revision");
      }),
    ).resolves.toEqual({ ref: "main", prNumber: null, stacked: false });
  });
});

describe("baseCandidates", () => {
  it("orders open own PRs deepest first", () => {
    expect(
      baseCandidates(STACK, "mc/next").map((e) => e.snapshot.number),
    ).toEqual([482, 480]);
  });
});

describe("baseOptions", () => {
  it("lists the suggestion, the default branch, other open PRs, then local branches", () => {
    const options = baseOptions({
      view: STACK,
      headBranch: "mc/next",
      defaultBase: "main",
      suggestion: {
        ref: "mc/tasks-panel-keyboard",
        prNumber: 482,
        stacked: true,
      },
      localBranches: ["main", "mc/next", "mc/tasks-panel-keyboard", "chore/x"],
    });
    expect(options).toEqual([
      {
        ref: "mc/tasks-panel-keyboard",
        label: "#482 · mc/tasks-panel-keyboard",
        stacked: true,
      },
      { ref: "main", label: "main", stacked: false },
      {
        ref: "mc/tasks-panel-virtual",
        label: "#480 · mc/tasks-panel-virtual",
        stacked: false,
      },
      { ref: "chore/x", label: "chore/x", stacked: false },
    ]);
  });

  it("starts with the default branch when nothing stacks", () => {
    const options = baseOptions({
      view: STACK,
      headBranch: "mc/next",
      defaultBase: "main",
      suggestion: { ref: "main", prNumber: null, stacked: false },
      localBranches: [],
    });
    expect(options.map((o) => o.ref)).toEqual([
      "main",
      "mc/tasks-panel-keyboard",
      "mc/tasks-panel-virtual",
    ]);
  });
});
