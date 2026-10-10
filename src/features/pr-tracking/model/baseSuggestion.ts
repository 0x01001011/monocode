import type { PrEntry, PrSetView } from "./types";

export type BaseSuggestion = {
  /** Branch to open the new PR against. */
  ref: string;
  /** The PR whose head is `ref`, when stacking. */
  prNumber: number | null;
  stacked: boolean;
};

const key = (repo: string, number: number) => `${repo}#${number}`;

/**
 * How far an entry sits from its stack's trunk: its index in a stack group
 * (members are base first), or the length of its `parent` chain, whichever
 * is larger.
 */
function depthOf(view: PrSetView, entry: PrEntry): number {
  const { repo, number } = entry.snapshot;
  let depth = 0;
  for (const group of view.stacks) {
    if (group.repo !== repo) continue;
    const at = group.members.indexOf(number);
    if (at > depth) depth = at;
  }
  const byKey = new Map(
    view.entries.map((e) => [key(e.snapshot.repo, e.snapshot.number), e]),
  );
  const seen = new Set<number>([number]);
  let chain = 0;
  let parent = entry.parent;
  while (parent != null && !seen.has(parent)) {
    seen.add(parent);
    chain += 1;
    parent = byKey.get(key(repo, parent))?.parent ?? null;
  }
  return Math.max(depth, chain);
}

/**
 * PRs a new branch could stack on: this chat's own (not someone else's, not
 * hidden) open PRs on another branch, deepest in their stack first, then the
 * newer PR. Merged and closed PRs are never candidates.
 */
export function baseCandidates(view: PrSetView, headBranch: string): PrEntry[] {
  return view.entries
    .filter(
      (e) =>
        e.relation !== "other" &&
        !e.dismissed &&
        e.snapshot.state === "open" &&
        e.snapshot.headRef !== headBranch,
    )
    .map((e) => ({ e, depth: depthOf(view, e) }))
    .sort(
      (a, b) => b.depth - a.depth || b.e.snapshot.number - a.e.snapshot.number,
    )
    .map(({ e }) => e);
}

export type BaseOption = { ref: string; label: string; stacked: boolean };

/** `#482 · mc/tasks-panel-keyboard`, the Base field's value for a PR branch. */
export const prBaseLabel = (number: number, ref: string) =>
  `#${number} · ${ref}`;

/**
 * Choices for the Create PR "Base" field: the suggestion first, then the
 * default branch, then the chat's other open PR branches, then local
 * branches. Each ref appears once; the PR's own branch is never offered.
 */
export function baseOptions({
  view,
  headBranch,
  defaultBase,
  suggestion,
  localBranches,
}: {
  view: PrSetView | null;
  headBranch: string;
  defaultBase: string;
  suggestion: BaseSuggestion | null;
  localBranches: string[];
}): BaseOption[] {
  const out: BaseOption[] = [];
  const seen = new Set<string>([headBranch]);
  const add = (option: BaseOption) => {
    if (!option.ref || seen.has(option.ref)) return;
    seen.add(option.ref);
    out.push(option);
  };
  if (suggestion?.stacked && suggestion.prNumber != null)
    add({
      ref: suggestion.ref,
      label: prBaseLabel(suggestion.prNumber, suggestion.ref),
      stacked: true,
    });
  add({ ref: defaultBase, label: defaultBase, stacked: false });
  for (const e of view ? baseCandidates(view, headBranch) : [])
    add({
      ref: e.snapshot.headRef,
      label: prBaseLabel(e.snapshot.number, e.snapshot.headRef),
      stacked: false,
    });
  for (const name of localBranches)
    add({ ref: name, label: name, stacked: false });
  return out;
}

/**
 * The base a PR from `headBranch` should target. The nearest candidate whose
 * head is an ancestor of HEAD wins (stacked); with none, `defaultBase`. A
 * failed ancestry check (an unknown ref) counts as not an ancestor.
 */
export async function suggestBase(
  view: PrSetView,
  headBranch: string,
  defaultBase: string,
  isAncestor: (headRef: string) => Promise<boolean>,
): Promise<BaseSuggestion> {
  const candidates = baseCandidates(view, headBranch);
  const answers = await Promise.all(
    candidates.map((e) =>
      isAncestor(e.snapshot.headRef).then(
        (yes) => yes === true,
        () => false,
      ),
    ),
  );
  const at = answers.indexOf(true);
  if (at < 0) return { ref: defaultBase, prNumber: null, stacked: false };
  const pick = candidates[at].snapshot;
  return { ref: pick.headRef, prNumber: pick.number, stacked: true };
}
