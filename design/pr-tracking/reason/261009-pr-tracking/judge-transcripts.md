# Judge transcripts (labels decoded)

## Judge 1 (order AB/A/B)

Winner: AB · Runner-up: B

All three share the same surface skeleton: a PrChip with a stack strip, a sidebar glyph merged with the linkedWorkItem badge, a "Pull requests · N" section in GitChangesPanel, an Inbox stepper, and a 360px PrSetCard with the tip at the top. So the deciding factors are how correct the tracking model is and how complete the edge cases are.

Y has the weakest tracking model, for three reasons.

1. **Attribution leaks between chats.** Its `turn_diff` source ("Branch at turn end differs from turn start") is allowed in shared-cwd chats because it is "scoped to this chat's own turn". Turns from different chats can run at the same time in one checkout, so this attributes one chat's branch to another, which is the exact leak Y says it is avoiding.
2. **The stack base can be wrong.** `first_base_ref` is filled in at first fetch, so it is wrong for any PR the app first sees after GitHub has already retargeted it. That breaks the "stack base merged" edge case.
3. **Ticks get expensive.** It puts parent and child neighbour lookups and `baseRef.compare(headRef:)` into every tick, and its "40-PR query costs roughly 1–2 points" claim ignores what compare and connection sizes cost.

Y's smaller faults:
- `role="listbox"` with `aria-activedescendant` on rows that also carry actions is an a11y anti-pattern.
- "Merge is disabled ... on a stack member whose parent is not merged" blocks a legitimate way to fold a stack.

Y's strengths are a full typed frontend contract and the useful codebase fact that `git_pr_create_for` already accepts `--base`/`--head`.

Z has the stronger model:
- It attributes a branch to the git process that touched it, via `GIT_TRACE2_EVENT` plus `MONOCODE_SESSION_ID`. Using `def_repo` means "`cd ../other && git push` attaches to *other*".
- Transcript `pull/N` URLs are "only a hint", confirmed by `headRefName`. This handles "already exists" errors and `gh pr view` output.
- It handles forks with `(base_repo, number)` keys plus a `headRepository.nameWithOwner == head_repo` filter.
- It reads stack history from `pr_base_history` built from `BaseRefChangedEvent`, and distinguishes auto-retargets from deliberate ones.
- Stack discovery is a bounded search kept separate from status ticks.
- Compare results are cached by immutable OID pair.
- A `gh_graphql` runner tolerates partial failures (keeps stdout, maps `errors[].path` to aliases, splits a timed-out batch).
- A SQLite lease stops two app instances from polling twice.
- The adaptive budget reads `rateLimit.remaining`, which also counts the agents' own gh use.
- Merging a stack child is labelled with its real target ("Squash into feat/a (not main)") instead of blocked.

Z's gaps:
- No frontend TypeScript contract.
- "Limited tracking" appears only in tradeoffs, not in the states table.
- The keyboard map omits ↵-to-Inbox in the key list and has no copy-URL action.

X keeps all of Z's model and fills those gaps:
- It adds the typed `ChatPrSet`/`ChatPr` contract, with `ghost`, `restack` and `error` fields and a `low_budget` gh state.
- The states table gains "Limited tracking (env stripped)" and "Ghost / cross-chat neighbour" rows.
- The keyboard spec is complete: roving tabindex, Tab to `⋯`, ↵ Inbox / ⌘↵ GitHub / ⌥↵ copy, and a list or tree structure instead of a listbox.
- It adds "copy URL" to the row menu and uses Y's `monocode-git-changed` and `git_pr_create_for` facts.

X's only blemish is a meta preamble paragraph explaining how it was synthesised. That does not affect the substance. On the domain checklist, X covers or improves on everything Z does:
- PR retargeted and stack base merged
- PR from a fork
- closed or merged PRs (terminal tier)
- rate limit and low budget
- gh missing or unauthenticated
- branch not checked out, or worktree removed

Force-push is handled implicitly in both by OID-keyed compare.

**Winning strength:** It pairs the most correct tracking model (trace2 process attribution, GitHub base history for stack edges, discovery kept separate from ticks, an OID-cached compare, partial-failure batching, a cross-instance lease) with the most complete states table, typed frontend contract and keyboard/a11y spec.

**Runner-up gap:** Z has the same strong model but no typed frontend contract. "Limited tracking" appears only in its tradeoffs, not in the states table, and its keyboard spec is thinner: no copy-URL action and no ↵-to-Inbox in the key list. These are small completeness gaps compared with X.

## Judge 2 (order B/AB/A)

Winner: AB · Runner-up: B

Y and X share the same core tracking model, which is much stronger than Z's.

**Attribution.** X and Y attribute a branch to the git process that touched it, using trace2: "a branch belongs to a chat only when a git process started by that chat's agent created it, switched to it and wrote to it, or pushed it". The `def_repo` event means "`cd ../other && git push` attaches to *other*". Z depends on `turn_diff` ("Branch at turn end differs from turn start"). In a shared checkout with parallel turns, that credits one chat's work to another. Z admits the narrower switch-and-back gap but never admits this cross-chat leak.

**Stack base.** Z stores `first_base_ref` at first fetch. That is wrong for any PR first seen after a retarget. X and Y take the base from `BaseRefChangedEvent` history and separate auto-retargets from deliberate ones ("the change happened at or after the parent's `mergedAt`, and the parent's branch is gone").

**Forks and partial failures.** X and Y match on `headRepository.nameWithOwner == head_repo` across `git_github_repositories_for`, which handles forks correctly. They keep stdout when gh fails, map `errors[].path` per alias, quarantine an alias that fails twice, and split a batch that times out. Z has no partial-failure design.

**Polling cost.** Z puts parent/child lookups and `baseRef.compare` into every tick. X and Y run discovery only on events, poll a closed set of PR numbers, and cache compare results by OID pair forever. Their SQLite lease stops a dev build and the installed app from both polling. Their adaptive budget reads `rateLimit.remaining`, which includes the agents' own gh use. Together these protect the rate limit better than Z.

**Product and accessibility.** Z blocks merge on stack children ("Merge is disabled with a tooltip on a stack member whose parent is not merged yet"). X and Y allow it but label the real target ("Squash into feat/a (not main)"), which is the more honest choice. Z uses `role="listbox"` for rows that contain actions, which is an accessibility mistake. Y explicitly says "Rows with actions are not a listbox" and uses roving tabindex with a list or tree. Z's warm tier covers only "chats visible in the sidebar", so attention dots on rows scrolled off-screen go stale. X and Y add a fleet tier for every open PR.

**Y over X.** Y contains everything in X, plus:
- the typed frontend contract (`ChatPrSet`, with `gh` states including `low_budget`);
- the codebase fact that `git_pr_create_for` already accepts `--base`/`--head`;
- the fact that `monocode-git-changed` doesn't fire for agent shell actions, which is the reason observation must happen in Rust;
- transcript hints as a fallback when a sandbox strips env vars, and a "Limited tracking" row in the states table;
- a copy-URL action and the ⌥↵ shortcut;
- more rejected alternatives: frontend-scheduled polling, per-PR `gh pr view`, the horizontal stack inside the card, the always-visible chip, and "all my PRs since the chat started".

**Gaps all three share.** None handles a closed PR being reopened: the Terminal tier refreshes only "once on transition", so a reopen goes unnoticed. None covers branch renames explicitly. Y also opens with a meta preamble about "A" and "B", which is a stylistic flaw but costs no substance.

**Winning strength:** Y has the most accurate tracking model: trace2 process attribution, base history taken from GitHub's `BaseRefChangedEvent`, repo matching that handles forks, and per-alias handling of partial failures. Stack discovery is separate from a closed-set batched tick, with a lease and an adaptive budget. On top of that it adds Z's typed frontend contract and codebase facts, a fallback for chats whose env vars are stripped, and the fullest states table and list of rejected alternatives.

**Runner-up gap:** X has nearly the same model and surface specs, but it lacks the frontend type contract and the `git_pr_create_for`/`monocode-git-changed` facts. Its "Limited tracking" fallback appears only as a closing note, not in the states table, and it has no copy-URL action. It also rejects fewer alternatives (it never covers frontend-scheduled polling, per-PR `gh pr view`, or the noise of an always-visible chip).

## Judge 3 (order A/B/AB)

Winner: AB · Runner-up: B

All three share almost the same surface designs: PrChip after BranchPicker, a stack strip of "3x10px bars", a 360px PrSetCard with rows ordered "tip at the top, base at the bottom", a Pull requests section in GitChangesPanel, and an Inbox stepper with a health line. The tracking model is where they differ.

Weaknesses in X:
- Attribution leaks between chats. X uses `turn_diff` ("Branch at turn end differs from turn start"). In a shared checkout with parallel turns, that attributes one chat's branch switch to another chat, even though X's own rule says passive reads leak branches in shared checkouts.
- The stack edge can be wrong. X takes `firstBaseRef` from the first time the app sees a PR, so any PR first seen after GitHub retargeted it gets the wrong parent.
- Cost grows with stack depth. X fetches parents and children "in the same batched query" on every poll.
- Forks are not handled. X filters only on `headRepositoryOwner`, with no base/head repo split.
- Merge is gated badly. "Merge is disabled ... on a stack member whose parent is not merged yet" blocks folding a child into its parent, which is a legitimate move.
- Smaller gaps: no way to recover when one alias in a batched query fails, and the listbox role on rows that contain actions is a weak a11y choice.

Strengths of X: a concrete typed frontend contract, and grounding facts about `monocode-git-changed` and `git_pr_create_for --base`.

Y fixes each of those gaps:
- Attribution comes from the process that ran git: `GIT_TRACE2_EVENT=af_unix:dgram:<app-sock>` plus `def_repo`, so "`cd ../other && git push` attaches to *other*".
- A `pr_base_history` table records "BaseRefChangedEvent" history, with a rule that tells auto-retargets from deliberate ones.
- "Discovery runs separately from status polling. ... Status ticks never traverse."
- PRs are keyed by `(base_repo, number)`, with a `headRepository.nameWithOwner == head_repo` filter for forks.
- A `gh_graphql` runner maps `errors[].path` to the failing alias, quarantines aliases that fail twice, and splits a batch on timeout.
- Compare results are cached in `pr_compare` by immutable OID pair, which also covers force-pushes.
- An adaptive budget reads `rateLimit.remaining`, so it accounts for the agents' own gh usage.
- A SQLite lease stops two app versions sharing one DB from polling twice.
- A stack-child merge is labelled ("Squash into feat/a (not main)") rather than blocked.
- A fleet tier keeps sidebar attention dots accurate for rows scrolled off-screen.

Z is Y's model plus the useful parts of X:
- X's typed contract, with fields Y lacks: `ghost`, `restack?: 'behind'|'contains_merged_parent'`, `error?`, and `gh: ...'low_budget'`.
- X's copy URL action, kept in both the `⋯` menu and the shortcut list.
- A real fallback path: "Those chats fall back to `worktree` plus confirmed transcript hints". Y only mentions this under tradeoffs.
- An explicit "Limited tracking (env stripped)" row in the states table.
- Listbox replaced with "Rows with actions are not a listbox", using roving tabindex and a tree for stacks with siblings, while keeping the ↵ / ⌘↵ / ⌥↵ / ⌫ shortcuts.

Gaps that none of them cover: a closed PR being reopened (the terminal tier is "once on transition"), and a renamed branch.

Z's one flaw is its opening synthesis paragraph, which talks about the other candidates as "A" and "B". That is meta-commentary and does not change the design. Z is the most correct and complete, and the most feasible in this codebase.

**Winning strength:** Z keeps Y's tracking model: git-process attribution through trace2 and `def_repo`, the stack edge taken from GitHub's BaseRefChangedEvent history, stack discovery kept out of the status polls, fork-aware repo keys, per-alias partial-failure handling, compare results cached by OID pair, and a lease plus an adaptive budget. It adds X's typed ChatPrSet/ChatPr contract (with ghost, restack and error fields), copy URL, a transcript-hint fallback for stripped environments shown as an explicit "Limited tracking" state, and list/tree a11y semantics that fit rows with actions.

**Runner-up gap:** Y has nearly the same model as Z. It lacks the frontend type contract, puts the stripped-env fallback only under tradeoffs (no state-table row and no transcript-hint fallback), and drops copy URL. The gap is small. X is clearly last: it has turn-diff leakage between chats, firstBaseRef taken from the app's first sighting, stack traversal on every poll, no fork handling, and merge blocked on stack children.

