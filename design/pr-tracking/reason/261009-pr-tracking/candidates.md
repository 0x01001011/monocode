# Final round candidates

## A

**PR tracking for chats: design**

---

### Codebase facts this design builds on (checked in the repo)
- `upsert_session` overwrites `sessions.branch` from live git. The table has `linked_work_item_json`, and new columns go in through additive `ALTER TABLE`/`ensure_column`. New tables are the safe route because several app versions share one DB.
- `git_pr_status_for` runs `gh pr list --head owner:branch --state all` for the one current branch. `git_pr_create_for` already accepts `--base` and `--head`, so stacked creation only needs UI.
- `monocode-git-changed` is a window event that fires only for git changes made through the UI. When an agent switches branches in its shell, nothing fires. So the observations must happen in Rust at turn boundaries.
- Transcript shell blocks look like `{role:"tool", tool:{kind:"shell"}, text}`. `monocodeToolCall.ts` already parses them, which shows a command classifier is practical.

---

## (a) Tracking model

### How a branch or PR gets attached to a chat
Each attachment has a **source**, listed strongest first:

| Source | Trigger | Attaches |
|---|---|---|
| `app_created` | Create PR in GitChangesPanel succeeds (URL returned) | PR, immediately |
| `agent_created` | A shell block in this chat matches `gh pr create` and its output has `github.com/o/r/pull/N` | PR, immediately (number known even with no network) |
| `agent_branch` | A shell block matches `git checkout -b`/`switch -c`/`push -u <remote> <b>`/`push origin <b>` | Branch |
| `turn_diff` | Branch at turn end differs from turn start, or HEAD gained commits during the turn | Branch at turn end |
| `worktree_observed` | Any `upsert_session` branch read for a chat that has its own `worktreeCwd` | That branch |
| `linked` | `linkedWorkItem.kind === 'pr'` | PR, tagged "Linked" |

Rules:
- **Never attach the repo's default branch.**
- **Shared-cwd chats** (no worktree) get no passive `worktree_observed` attachments. Several chats share the checkout, so passive reads would leak branches between them. `turn_diff` is still allowed because it is scoped to this chat's own turn.
- A merely viewed URL (`gh pr view 12`) never attaches. Looking at a PR is not producing it.
- **Resolving branches to PRs:** each attached branch is looked up by `headRefName` in the batched poll (below). Matches are filtered client-side on `headRepositoryOwner` to replace the old `owner:branch` filter.
- If the matched PR was created before the chat started, it attaches with `preexisting=1` and shows a small "Existing" tag.
- Branches still without a PR are re-checked at the warm cadence (catches PRs opened on github.com), at most 20 per chat. They are dropped after 14 days.

### Persistence (additive tables, `sessions.branch` unchanged)
`sessions.branch` stays as "the live branch".

```sql
CREATE TABLE session_branches (
  session_id TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL,
  source TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, repo, branch));
CREATE TABLE session_prs (
  session_id TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_ref TEXT NOT NULL, source TEXT NOT NULL, attached_at INTEGER NOT NULL,
  preexisting INTEGER NOT NULL DEFAULT 0, dismissed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, repo, number));
CREATE INDEX session_prs_repo_head ON session_prs (repo, head_ref);
CREATE TABLE pr_snapshots (            -- shared: one PR can matter to many chats
  repo TEXT NOT NULL, number INTEGER NOT NULL, json TEXT NOT NULL,
  first_base_ref TEXT NOT NULL,        -- stack edge survives GitHub's auto-retarget
  fetched_at INTEGER NOT NULL, terminal_at INTEGER,
  PRIMARY KEY (repo, number));
```

Frontend types:

```ts
type PrState = 'draft'|'open'|'merged'|'closed'|'unknown';
interface PrSnapshot { repo; number; url; title; state: PrState; createdAt;
  headRef; baseRef; firstBaseRef; headOid; author;
  checks: { rollup:'passing'|'failing'|'pending'|'none'; passed; failed; pending };
  review: 'approved'|'changes_requested'|'review_required'|null;
  mergeable: 'mergeable'|'conflicting'|'unknown';
  mergeState: 'clean'|'behind'|'blocked'|'dirty'|'unstable'|'draft'|'unknown';
  behindBy: number|null; fetchedAt: number }
interface ChatPr extends PrSnapshot { source; preexisting: boolean;
  owned: boolean;            // false = stack neighbour pulled in for context
  ownerSessionId?: string;   // another chat that owns it
  checkedOut: boolean }      // headRef === this chat's live branch
interface PrStack { id; trunk: string; members: ChatPr[] /* base→tip */ }
interface ChatPrSet { stacks: PrStack[]; standalone: ChatPr[]; current?: ChatPr;
  attention: Attention; freshness: 'fresh'|'stale'|'never';
  gh: 'ok'|'missing'|'unauthenticated'|'rate_limited'|'offline'; resumesAt?: number }
```

### How stacks are detected and ordered
1. Pull in neighbours of each owned PR, in the same batched query:
   - **Parents:** PRs whose `headRefName` equals my `baseRef`, walking up until the base is the default branch (at most 6 hops).
   - **Children:** open PRs whose `baseRefName` equals my `headRef`.
2. Build edges inside each repo: A → B when `B.firstBaseRef == A.headRef`.
   - Using `firstBaseRef` matters. When A merges and its branch is deleted, GitHub retargets B to `main`. B's live `baseRef` then hides the history, and the stack would fall apart the moment its bottom merges.
3. The trunk is the base that no PR in the set has as its head. Members are ordered base → tip by following edges.
4. Forks (two PRs on the same parent) are sorted by `createdAt` and rendered depth-first. A sibling subtree is indented one level (12px), and the connector line branches.
5. A connected component with one PR counts as standalone. Stacks sort by most recent activity, then standalone PRs by `attachedAt` descending.
6. Neighbours owned by another chat render with `owned:false` and link to that chat.

### Refresh without exhausting the gh rate limit
A single Rust `pr_tracker` scheduler makes **one GraphQL query per repo per tick** through `gh api graphql`, routed through the existing global backoff slot.
- The query uses aliases: `p482: pullRequest(number:482){…}` for known PRs, plus `pullRequests(headRefName:…)` and `pullRequests(baseRefName:…, states:OPEN, first:5)` for branch and child lookups.
- Each PR selects: `state isDraft mergeable mergeStateStatus reviewDecision headRefOid`, and `commits(last:1){…statusCheckRollup{state contexts{checkRunCountsByState{state count} statusContextCountsByState{state count}}}}`.
- `behindBy` comes from `baseRef.compare(headRef:)`. For a stack child this measures distance to the parent's head, which is exactly "needs restack".
- GraphQL cost scales with connection sizes, not with alias count. A 40-PR query costs roughly 1–2 points out of 5,000 per hour.

Interest tiers. Each window reports which surfaces are visible via `pr_tracker_set_interest`; Rust merges this across the main window and the floating Mono chat windows, so nothing polls twice.
- **Hot:** PRs of the focused chat while a surface is visible. Every 30s, the same cadence as `useGithubPrChecks`.
- **Warm:** open PRs of chats visible in the sidebar. Every 3 min.
- **Cold:** merged or closed PRs. Fetched once after they become terminal (sets `terminal_at`), then never again unless something is viewed in Inbox.
- **Event refreshes** (debounced 5s):
  - turn end whose transcript contains a `git push` or `gh pr` command
  - any `git_github_pr_action`
  - Create PR
  - window focus (at most once per 60s)
- `mergeable: UNKNOWN` means GitHub is still computing. The hot tier retries once after 5s; other tiers wait for the next tick.

Results are written to `pr_snapshots`, followed by a Tauri event `pr-snapshots-updated {repo, numbers}`. `useChatPrs(sessionId)` reads from SQLite first, so persisted snapshots render instantly on launch, then subscribes.

**Attention level** (worst signal wins, order fixed): conflicting/dirty > checks failing > changes requested > behind/needs restack > checks pending > approved and green > neutral.

---

## (b) Surfaces

### 1. Composer header chip
**Placement:** `PrChip` sits right after `BranchPicker`, with the same `h-6`, 12px text, `text-content/45` and hover fill as `GitPickerTrigger`. Max width 160px. It takes `ContextMeter`'s Popover side and align.

**At rest:**

| State | Chip shows |
|---|---|
| 0 PRs | Nothing. No empty chip. |
| 1 PR | Status icon in state colour, `#482`, then a 6px attention dot. The dot appears only for rose (blocking) or amber (pending/behind), not for green. |
| Several PRs | The "current" PR (head equals live branch, otherwise the most recent open one), plus a `+3` count in `text-content/35`. |
| Current PR is in a stack | `#482` then a **stack strip**: one 3×10px rounded bar per member, base on the left, each in its state colour. The current member's bar is full opacity; the others are at 55%. A 6-member strip is 26px wide. |

The stack strip is the core visual. It shows "3 of 4 merged, mine is next" with no text.

**Hover:** opens `PrSetCard` after 220ms (closes after 100ms). **Click:** opens the same card pinned, with `role="dialog"` and focus trapped.

### 2. Sidebar session row
- The PR glyph sits right-aligned next to the existing `linkedWorkItem` badge. If the linked PR is also in the set, the two merge into one glyph, never two.
- 1 PR: status icon only, 12px, no number, because row width is tight.
- Several PRs: a stack icon (two offset `GitPullRequest` outlines), then a count.
- An attention dot overlays the icon's top-right corner for rose or amber. Its job: across 12 parallel chats, "which one needs me" can be scanned without opening anything.
- Hover opens the card on `side="right"` with a 400ms delay; the longer delay avoids flicker while the pointer moves down the list.
- Archived chats show no PR glyph.

### 3. GitChangesPanel
The single button becomes a **Pull requests** section:
- Header: `Pull requests · 3`, with the freshness timestamp on the right.
- Then the same row list as the card (below), with the current-branch PR first and a 2px accent left bar.
- The primary button depends on the current branch:
  - No PR yet: **Create PR**, now with a base selector. The default stays the repo default branch. If another branch tracked by this chat has a head that is an ancestor of HEAD but not of the default branch, the selector preselects **Stack on #480 (feat/a)**. This is a local `git merge-base --is-ancestor` check, so it costs no API calls.
  - PR exists: **View #482**.
- Row overflow menu holds the existing actions: ready/draft, merge (squash/rebase), close/reopen. Merge is disabled with a tooltip on a stack member whose parent is not merged yet.

### 4. Inbox PR detail stack rail
- A horizontal stepper sits above `InboxPrOverview`: `main ← #480 ← [#482] ← #485`.
- Each node is a 28px pill: state icon, `#N`, title truncated to 18ch. The node being viewed gets a `selection-*` fill. Merged nodes are violet with the `GitMerge` icon.
- With 5–6 members, middle titles collapse to numbers before anything wraps. Clicking a node navigates the detail view.
- Under the rail is one health line, showing only the highest-priority message:
  - "Merge #480 first."
  - "#480 was squash-merged; #482 still contains its commits and needs a rebase onto main."
  - "#485 is 2 commits behind #482."
  - Each message offers an **Ask the owning chat** action, which drafts a restack prompt into that chat's composer.

---

## (c) The `PrSetCard` hover card
- **Size and frame:** 360px wide (matches `UserLinkPreview`), max height 440px with internal scroll, glass Popover frame, z-index 80.
- **Header:** `4 pull requests` · `from this chat`, then `Updated 12s ago` at 11px muted, then a refresh icon button.
- **Stack group:** label `Stack · 3 · into main`. Rows run **tip at the top, base at the bottom**, the convention Graphite and the GitHub CLI stack tools use, so merging reads bottom-up. A 1px `stroke` connector line joins the status icons.
- **Standalone group:** label `Other`, plain rows.
- **Row (40px):**
  - Line 1: status icon, `#482`, title (truncated), then right-aligned glyphs. Checks: ✓ emerald, × rose, or a ring for pending, with a count on failure (`2×`). Review: approved check, or changes-requested in rose. Merge: a conflict glyph or `↓3` for behind.
  - Line 2 (11px, `content/45`): `feat/b → feat/a` · `Not checked out` / `HEAD` · `Existing` / `Other chat ›`.
  - Only glyphs carrying a signal render. A green, approved, clean row shows just its check mark.
- **Footer:** errors and state messages (see (d)), plus `↵ open · ⌘↵ GitHub`.
- **Why not reuse the single-PR card as-is:** it spends about 200px of height per PR on summary and author. That fits a link preview and fails at 8 rows. Clicking a row instead opens the full detail in Inbox.

---

## (d) States

| State | Chip | Card / panel |
|---|---|---|
| None | hidden | Panel shows "No pull request" and Create PR |
| 1 PR | icon + `#N` (+ dot) | one row |
| Many | current PR + `+N` | grouped list |
| Stack | `#N` + strip | stack group with connector line |
| Stack + standalone | strip, plus `+N` for the standalone ones | Stack group, then Other |
| Loading, first fetch, number known from transcript | neutral `GitPullRequest` icon at `content/50` + `#N`, width reserved | row with skeleton glyphs |
| Loading, snapshot persisted | renders snapshot, no spinner | `Updating…` in header |
| Stale (hot tier, older than 5 min) | icon at 60% opacity | `Updated 7m ago` in amber, retry button |
| gh missing | last snapshot, muted | footer: "GitHub CLI not found" plus an install link |
| gh unauthenticated | last snapshot, muted | footer: "Sign in with `gh auth login`" with copy button |
| Rate limited | last snapshot | footer: "GitHub rate limit · resumes 14:32". Manual refresh disabled. |
| Offline | last snapshot | "Offline · showing last known status" |
| PR's branch no longer checked out | (not current, so not featured) | `Not checked out` tag. If the worktree was removed: `Worktree removed`, and checkout actions hidden. |
| Base auto-retargeted after parent merged | strip keeps the merged parent in violet | stays in the stack because of `firstBaseRef` |
| Cross-chat neighbour | strip includes it at 55% | `Other chat ›` link |
| Dismissed by user | gone | restore it via "Show hidden (1)" in the panel |

---

## (e) Interactions, keyboard and accessibility
- **Chip:**
  - A real `<button>` with `aria-haspopup="dialog"` and `aria-expanded`.
  - `aria-label` is written out in full, e.g. "Pull request 482 open, checks failing, stack 2 of 3, 4 pull requests total".
  - Enter or Space opens the pinned card and focuses the first row.
- **Rows:** `role="listbox"` with `aria-activedescendant`.
  - ↑/↓ move between rows; Home/End jump to the ends.
  - ↵ opens the PR in Inbox; ⌘↵ opens it on GitHub; ⌥↵ copies the URL.
  - ⌫ dismisses the PR from this chat, with an undo toast.
  - Esc closes the card and returns focus to the chip.
- **Without colour:** every status is shown by icon *shape* as well as colour (the four lucide PR icons; check, ×, and ring glyphs), which covers colour-blind users and light theme.
- **Stack strip:** `aria-hidden`; the stack is described in the label.
- **Announcements:** state changes go to a polite live region, only for the focused chat and only on transitions into rose or merged. Example: "PR 482 checks failed".
- **Motion:** none beyond the Popover fade. Pending checks use a static ring, not a spinner, so 12 sidebar rows don't animate.
- **Hover timing:** the hover card never steals focus; only the click-opened pinned card traps focus.

---

## (f) Phased delivery
1. **Model and single surface.**
   - The three tables, the attachment sources (`app_created`, `agent_created`, `turn_diff`, `worktree_observed`), the `pr_tracker` batched GraphQL poll with tiers, and `useChatPrs`.
   - Composer chip and card, without stack grouping yet.
   - Exit criterion: a chat that switched branches twice shows both PRs.
2. **Stacks.** `firstBaseRef`, parent/child neighbour lookups, stack ordering, the strip, stack groups in the card, and the GitChangesPanel list.
3. **Fleet surfaces.** Sidebar glyph and attention, the Inbox stack rail and health line, cross-chat neighbour links, dismiss/restore.
4. **Acting on stacks.** "Stack on #N" base suggestion in Create PR, "Ask the owning chat" restack prompts, merge buttons gated by parent order.

---

## (g) Tradeoffs and rejected alternatives
- **Transcript parsing only:** rejected. It misses branches changed manually and PRs opened on GitHub. Turn-diff and worktree observation fill those gaps; the transcript adds precision (the PR number, with no network).
- **"All my PRs since the chat started" from GitHub:** rejected. With several parallel chats in one repo, that attaches other chats' PRs. Branch-scoped attachment is what makes the per-chat set correct.
- **Passive observation in shared-cwd chats:** rejected for the same leakage reason. The cost is that a manual branch switch in the main checkout does not attach; accepted.
- **Per-PR `gh pr view` polling (today's pattern):** rejected. N PRs × M chats calls scale linearly; one aliased GraphQL query per repo is flat.
- **Frontend module-level scheduler (current cache style):** rejected for this feature. Floating chat windows would duplicate polls, and Rust already owns backoff and the DB. Cost: a new Rust module and an event bridge.
- **Storing PR status in `sessions` JSON:** rejected. PRs and stacks span chats, so status has one shared row in `pr_snapshots`.
- **Webhooks:** unavailable to a local desktop app with no server.
- **Horizontal stack inside the 360px card:** rejected; 6 members don't fit with titles. The horizontal stepper is used only in the wide Inbox view.
- **Always showing a chip, even "No PR":** rejected as permanent noise in a dense header. Create PR stays in GitChangesPanel.
- **Accepted limit:** `turn_diff` misses a branch switched to and back within one turn when no matching shell command appears in the transcript. That is rare, and the transcript classifier covers the common `checkout -b`/`push` cases.

No repo files were changed.

## B

# Candidate B: per-chat pull request tracking, stack rendering and live status

## Codebase facts this design builds on
- `harness.rs` already sets env vars on every agent process it spawns (`MONOCODE_HARNESS_PARENT`), so adding a per-chat env var is an existing pattern.
- `fs.rs` already has `git_github_repositories_for` (the repo plus its fork parent), `gh_run`/`gh_run_raw`, and `GITHUB_RATE_LIMIT_BACKOFF`.
- Remote projects run through `remote.rs` and `remote_ssh.rs`, which talk to a host daemon.
- `upsert_session` overwrites `sessions.branch`. Several app versions share one SQLite DB, so every schema change must be additive.

---

## (a) Tracking model

### A.1 Branches are attributed by which process ran git, not by time
A time window cannot tell chats apart in a shared checkout. So the rule is: **a branch belongs to a chat only when a git process started by that chat's agent created, switched to, committed on, or pushed it.**

**How it works:** when the harness spawns an agent it sets
`GIT_TRACE2_EVENT=af_unix:dgram:<app-sock>` and `MONOCODE_SESSION_ID=<id>`.
- Every `git` the agent runs inherits these, including git called by subagents, by `gh` (which calls `git push`), and by MCP servers launched from the agent.
- Each such git sends a trace2 `start` event (its argv) and a `def_repo` event (its worktree path) to a Rust listener. The listener knows which chat each socket peer belongs to through a per-session socket path.
- **If the socket is missing, git silently skips tracing.** Nothing breaks.
- The user's own `GIT_TRACE2_*` settings are respected: when one is already set, the app falls back to a per-session file target.

**Classifier.** The listener parses argv. Because each event has its repo from `def_repo`, `cd ../other && git push` attaches to *other*, which is correct.

| Observation | Attaches |
|---|---|
| `checkout -b/-B`, `switch -c/-C`, `branch <new>` then a checkout of it | branch, `created` |
| `checkout/switch <b>` followed by `commit`/`rebase`/`merge`/`cherry-pick` in that repo, by this chat | branch, `worked` |
| `push` whose refspec destination is `refs/heads/X`. Ignores `--delete`, `:X` and `--tags`; `HEAD:X` attaches X. | branch, `pushed` |
| Create PR in GitChangesPanel succeeds | PR, `app_created` |
| `linkedWorkItem.kind==='pr'` | PR, `linked` |
| Live branch of a worktree that **only this chat** uses (one non-archived session with that `worktreeCwd`) | branch, `worktree` |

- Merely checking out a branch to look at it does not attach it. Attaching needs a write.
- The repo's default branch never attaches.
- **Shared-cwd chats get only process-attributed and app-created attachments.** The user's manual branch switches in a shared checkout belong to no chat, which is correct.
- **Transcript `pull/N` URLs are only a hint.** They render a placeholder row at once. The PR is *confirmed* only if its `headRefName` resolves to a branch this chat already owns. "already exists" errors and `gh pr view` output therefore never attach anything. A PR whose `createdAt` is earlier than the chat's first claim on its branch is marked `preexisting`.
- **Remote projects:** the host daemon sets the same env vars and writes events to a file on the remote host. The daemon streams new lines on each turn end. `gh` still runs locally, keyed by the repo identity read from the remote's `git remote -v`. Until Phase 4, remote chats get only `app_created`, `linked` and `worktree`, and the UI says so (see (d)).

### A.2 Repo identity
- **A PR's key is `(base_repo, number)`**, where `base_repo` is the repository the PR lives in (`baseRepository.nameWithOwner`).
- A branch's key is `(worktree_root, branch)`. Its push target is `(head_repo, branch)`, where `head_repo` comes from the push's remote URL, or from `branch.<b>.remote`.
- **Resolving a branch to PRs:**
  - Query each repo in `git_github_repositories_for` (the repo and its parent) with `pullRequests(headRefName:$b, first:5)`.
  - Keep only PRs whose `headRepository.nameWithOwner == head_repo`.
  - This handles fork → upstream PRs (this repo's own `fork`/`origin` setup) and rejects other people's PRs that use the same branch name.

### A.3 Persistence (additive tables; `sessions.branch` keeps meaning "live branch")
```sql
session_branches(session_id, worktree_root, branch, head_repo, source, first_claim_at, last_seen_at,
                 next_lookup_at, PRIMARY KEY(session_id, worktree_root, branch))
session_prs(session_id, base_repo, number, source, attached_at, preexisting, dismissed,
            PRIMARY KEY(session_id, base_repo, number))
pr_snapshots(base_repo, number, head_repo, head_ref, base_ref, head_oid, base_oid, json,
             fetched_at, terminal_at, error_count, PRIMARY KEY(base_repo, number))
pr_base_history(base_repo, number, seq, previous_ref, current_ref, changed_at,
                PRIMARY KEY(base_repo, number, seq))      -- from GitHub, not first observation
pr_compare(repo, base_oid, head_oid, ahead, behind, merge_base_oid,
           PRIMARY KEY(repo, base_oid, head_oid))         -- immutable, never expires
pr_tracker_lease(id=1, holder, expires_at)
pr_interest(holder, session_id, tier, updated_at)
```
- Snapshot rows hold only facts GitHub returned. No column is filled in from the app's first sighting.
- Branches without a PR are never deleted. `next_lookup_at` backs off instead: 30s while the chat is active, then 1h, then daily for 30 days. After that they are looked up only when the chat is opened.

### A.4 Stack detection
**Edges.** An edge A → B exists when B's *original base* equals A's head branch, both in the same `base_repo`. The original base comes from `pr_base_history`:
- GitHub's `BaseRefChangedEvent` timeline items carry `previousRefName` and `currentRefName`.
- **Auto-retarget** (the change happens at or after the parent's `mergedAt`, and the parent's head branch is gone): the edge to the old base is kept, with a "Merged parent" state.
- **Deliberate retarget** (the change happens before the parent merged, or targets some other open PR's head): the current base wins, and the old edge is dropped.
- This works the same for PRs first seen years after they were retargeted.

**Discovery runs separately from status polling.** Finding stack topology is a bounded breadth-first search:
- Round k queries the whole frontier in one aliased query: parents through `headRefName == myBase`, children through `baseRefName == myHead, states:OPEN, first:5`. Parent and child candidates are both filtered to head repos the user pushes to.
- An unowned PR is admitted only when it lies *between* two owned PRs, or is the root parent needed to explain the chain. It is shown as a ghost node with its author.
- Depth is capped at 6, so at most 6 rounds. Usually 1–2 rounds are needed, because local branch ancestry already predicts the parents.
- Discovery runs only when:
  - a PR is newly attached;
  - a status tick shows a changed `baseRefName`;
  - an owned PR's child count changes (the tick includes `totalCount` for children);
  - otherwise at most once per 10 min per stack.
- **Status ticks never traverse.** They poll a known, closed set of PR numbers.

**Ordering.**
- A stack's trunk is the base that no member has as its head.
- Members run base → tip.
- When two PRs share a parent, siblings sort by `createdAt` and render depth-first, indented 12px.
- A component with one PR counts as standalone.
- Stacks sort by latest activity; standalone PRs sort by `attached_at` descending.

### A.5 Status refresh and gh budget
**One Rust `pr_tracker`.**
- It holds a SQLite lease, renewed every 20s. Only the lease holder polls, so a dev build and the installed app never double-poll.
- Other instances write their visibility interest into `pr_interest` and re-read `pr_snapshots` from SQLite every 10s, which costs no network.

**Tick query.**
- **Shape:** one `gh api graphql` per `base_repo`, with at most 25 `pullRequest(number:)` aliases. Each alias selects `state isDraft mergeable mergeStateStatus reviewDecision headRefName headRefOid baseRefName baseRefOid`. It also selects `commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:1){checkRunCountsByState{state count} statusContextCountsByState{state count}}}}}}` and a `rateLimit{cost remaining resetAt}` block.
- **Fetched once per PR, not on every tick:** `createdAt`, `mergedAt`, and `mergeCommit{parents{totalCount}}` (only when merged).
- **No `compare` in the tick.**

**Partial-failure safety.**
- A new `gh_graphql` runner keeps stdout even when gh exits non-zero. It parses `data` and `errors[].path` per alias, so only the failing alias is marked.
- An alias that fails twice is quarantined: it is polled on its own at the cold cadence, with a row error state.
- A timeout bisects the batch.
- Transcript hint numbers are never put in a batch until confirmed (A.1).

**Ahead/behind and restack.**
- Computed through REST `repos/{repo}/compare/{base_oid}...{head_oid}` only when the OID pair changes and the PR is on a visible surface.
- Results go into `pr_compare` forever, because OID pairs are immutable.
- "Needs restack" for child B on parent A: compare(A.head_oid, B.head_oid) has behind > 0.
- "Contains squash-merged parent": A is merged, A's `mergeCommit` has one parent (squash or rebase), and compare(A.head_oid, B.head_oid) has behind == 0. That means A's original commits are still in B.

**Tiers.**

| Tier | Members | Cadence |
|---|---|---|
| Hot | focused chat's open PRs while any surface is visible | 30s |
| Fleet | every open PR of every non-archived chat, scrolled off-screen or not | 3 min while the window is visible, 10 min while hidden |
| Terminal | merged/closed | once on transition, then only when opened in Inbox |
| Mergeable retry | aliases returning `UNKNOWN`, any tier | one mini-query after 5s, then 20s, then the normal tier |
| Events (debounced 5s) | trace2 `push`, a `gh`-spawned git, `git_github_pr_action`, Create PR | affected repo only |
| Focus | window focus, at most once per 60s | one fleet query per repo |

**Adaptive budget.**
- The tracker targets about 300 points/hour for itself.
- `rateLimit.remaining` reflects the agents' own `gh` usage too, so the tracker reacts to the whole account:
  - below 1500: fleet polling slows to 15 min;
  - below 500: only the hot tier runs;
  - on a rate-limit error: the existing global backoff applies to everything.

**Delivery to the UI.**
- Results are written to `pr_snapshots`, then Rust emits `pr-snapshots-updated`.
- `useChatPrs(sessionId)` renders from SQLite first, then subscribes.
- Staleness is uniform across tiers: a snapshot is *stale* when its age is more than 2× its tier interval.

**Attention order** (worst wins):
1. conflicting
2. checks failing
3. changes requested
4. contains a merged parent / needs restack
5. behind base
6. checks pending
7. ready (approved, green, clean)
8. neutral

Draft, merged and closed are always neutral.

---

## (b) Surfaces

### 1. Composer header chip (`PrChip`)
**Placement:** after `BranchPicker`. Same `h-6`, 12px text, `text-content/45` and hover fill as `GitPickerTrigger`. Max width 168px.

**Featured PR,** in priority order:
1. the PR whose head is the live branch;
2. otherwise the open PR with the worst attention;
3. otherwise the most recent PR, in which case it shows with the violet merged or rose closed icon.

**At rest:**
- Status icon, then `#482`.
- If the featured PR is in a stack: a strip of 3×10px bars, one per member, base on the left, each in its state colour. The featured member is at full opacity, the others at 50%. Ghost nodes are hollow outlines.
- `+N` for PRs outside the featured stack.
- A 6px dot for rose (blocking) or amber (needs action). No dot when everything is green.
- **No chip at all with zero PRs.**

**Hover:** after 220ms, opens `PrSetCard` (closes after 100ms). **Click:** opens the same card pinned.

### 2. Sidebar row
- One glyph, right-aligned. If the linked PR is part of the set, it merges with the existing `linkedWorkItem` badge so there are never two.
- 1 PR: status icon only. Several: a stacked-PR icon plus a count. The attention dot sits on the icon's corner.
- Stale glyphs drop to 50% opacity, so a dot nobody has refreshed never reads as current.
- Hover opens the card on `side="right"` after 400ms.

### 3. GitChangesPanel
The single button becomes a **Pull requests · N** section, with `Updated 40s ago` on the right.
- **Rows:** the same component as in the card. The live-branch PR comes first, with a 2px accent bar.
- **Primary action:**
  - **Create PR**, with a base selector. If a branch this chat owns is an ancestor of HEAD but not of the default branch, the selector preselects **Stack on #480 (feat/a)**. This is a local `merge-base --is-ancestor` check for local projects and the compare API for remote ones.
  - **View #482** once a PR exists.
- **Row menu:** ready/draft, merge, close/reopen.
- **Merging a stack child is not blocked.** The menu labels the real target, e.g. "Squash into feat/a (not main)", and asks for confirmation. Merging a child into its parent's branch is a legitimate way to fold a stack.

### 4. Inbox stack rail
- A horizontal stepper above `InboxPrOverview`: `main ← #480 ← [#482] ← #485`.
- Each node is a 28px pill: state icon, `#N`, title up to 18ch. The node being viewed gets a `selection-*` fill. Merged parents stay in place, in violet.
- With 5–6 nodes, the middle titles collapse to numbers first.
- **Health line** under the rail shows one message, the highest attention (A.5). Each message comes straight from data:
  - "#480 was squash-merged. #482 still carries its 4 commits, so rebase onto main."
  - "#485 is 2 commits behind #482."
  - "Merge order: #480 first."
- **Draft restack prompt in owning chat** puts an editable prompt in that chat's composer. It never sends on its own.

---

## (c) `PrSetCard`
- **Frame:** 360px wide, max height 440px with internal scroll, glass Popover frame, z-index 80.
- **Header:** `4 pull requests from this chat` · `Updated 12s ago` · refresh button.
- **Stack group:** label `Stack · 3 into main`. Rows run **tip at the top, base at the bottom**, joined by a 1px `stroke` connector through the status icons. Sibling branches are indented.
- **Other group:** standalone PRs.
- **Row (40px):**
  - Line 1: status icon, `#482`, truncated title, then right-aligned glyphs. Only glyphs carrying a signal render:
    - checks: ✓ green, `2×` red, or a static ring for pending;
    - review: approved or changes requested;
    - merge: conflict glyph, `↓3` behind, or `restack`.
  - Line 2 (11px, `content/45`): `feat/b → feat/a`, then a tag such as `HEAD`, `Not checked out`, `Existing`, `by @alice` (ghost) or `Other chat`.
- **Footer:** gh state messages, plus the keyboard hints `↵ Inbox · ⌘↵ GitHub · ⋯ actions`.
- **Why not the single-PR card from `UserLinkPreview`:** its summary and author block costs about 200px per PR. That is fine for one link preview and useless at 8 rows. A row click opens the full detail in Inbox instead.

---

## (d) States

| State | Chip / sidebar | Card / panel |
|---|---|---|
| None | hidden | panel: "No pull request yet" + Create PR |
| 1 PR / many | icon `#N` (+`+N`) | rows |
| Stack | `#N` + strip | stack group with connector |
| Stack + standalone | strip + `+N` | Stack, then Other |
| Hint only (number from transcript, not yet confirmed) | neutral icon `#N` | row "Confirming…" with skeleton glyphs |
| First fetch, nothing persisted | width reserved, neutral icon | skeleton rows |
| Persisted snapshot, refreshing | snapshot shown, no spinner | "Updating…" |
| Stale (age > 2× tier interval) | 50% opacity | amber `Updated 9m ago`, Retry |
| One PR errored or quarantined | unchanged | that row: "Couldn't load · retrying 14:40" |
| gh missing | last snapshot, muted | "GitHub CLI not found" + install link |
| gh unauthenticated | muted | "Run `gh auth login`" + copy button |
| Rate limited | last snapshot | "GitHub limit · resumes 14:32"; Refresh disabled |
| Low budget | normal | "Refreshing less often to save GitHub quota" |
| Offline | last snapshot | "Offline · last known status" |
| Branch not checked out | not featured | `Not checked out`, or `Worktree removed` with checkout actions hidden |
| Parent auto-retargeted, merged | strip keeps a violet bar | "Merged parent" in the stack |
| Ghost node (someone else's PR between mine) | hollow bar | `by @alice` and no actions |
| Remote project before Phase 4 | normal | "Agent-made branches aren't tracked on remote hosts yet" |
| Dismissed | gone | panel: "Show hidden (1)" |

---

## (e) Interaction and accessibility
- **Chip:** a `<button>` with `aria-haspopup="dialog"` and `aria-expanded`. Its full label reads like "PR 482 open, checks failing, stack 2 of 3, 4 pull requests".
- **Hover vs click:** the hover card never takes focus. Enter, Space or click opens the pinned `role="dialog"`, which traps focus and returns it to the chip on Esc.
- **Card structure:** `role="list"` (a `tree` for stacks with siblings).
  - Each item holds a primary link (`#482 title`) and a visible `⋯` menu button.
  - Keys: ↑/↓ and Home/End use roving tabindex across the primary links. Tab moves to the row's menu button. In the tree, ←/→ collapse and expand siblings.
  - Shortcuts: ⌘↵ opens GitHub; ⌫ dismisses, with an undo toast. Every shortcut is also listed in the `⋯` menu, so none is hidden-only.
- **No meaning by colour alone:** the four lucide PR icon shapes, plus check, ×, ring, ↓ and conflict glyphs.
- **Stack strip:** `aria-hidden`; the stack is described in the chip's label.
- **Live region:** polite. Only for the focused chat, and only on transitions into blocking or merged.
- **Motion:** pending checks use a static ring, so 12 sidebar rows never animate at once.

---

## (f) Phased delivery
1. **Attribution and single list.**
   - Scope: trace2 env and listener, `session_branches`/`session_prs`/`pr_snapshots`, repo identity, the lease, hot and fleet ticks with partial-error handling and the adaptive budget, the chip and card without stack grouping, and the sidebar glyph.
   - Exit tests:
     - Two chats in one checkout, each running `checkout -b` and push, never see each other's PRs.
     - A chat that switched branches twice shows both PRs.
2. **Stacks.** `pr_base_history`, the BFS discovery, ordering, the strip, stack groups, and the GitChangesPanel list with "Stack on #N".
3. **Health.** `pr_compare`, restack and squash-parent detection, the Inbox rail and health line, ghost nodes, cross-chat links, dismiss/restore, and labelled stack merges.
4. **Remote.** Trace2 events forwarded by the host daemon, and compare-API ancestry for remote checkouts.

---

## (g) Tradeoffs and rejected alternatives
- **Time-window attribution** (comparing the branch at turn start and turn end) is rejected. Parallel turns in a shared checkout make it attribute one chat's work to another. Trace2 ties every git action to the process that ran it.
- **Installing git hooks or setting `core.hooksPath`** is rejected. It changes user repos and fights husky and similar hook managers. Trace2 is an env var, and git skips it without error when the target is unavailable.
- **A `gh`/`git` shim on PATH** is rejected. It is fragile across harnesses, and trace2 already sees the git that `gh` runs.
- **Transcript parsing as the source of truth** is rejected. It misses MCP and subagent paths and misreads "already exists" errors. It is kept only as an instant-render hint.
- **Recording the stack base at first fetch** is rejected. It is wrong for any PR first seen after a retarget. GitHub's own `BaseRefChangedEvent` history is used instead.
- **Traversing stacks on every tick** is rejected. It makes cost proportional to stack depth. Topology is discovered on events and cached, and ticks poll a closed set.
- **`compare` in every tick** is rejected as expensive and prone to timeouts. Compare results are keyed by OID pair and cached forever.
- **Disabling merge on stack children** is rejected. Folding a child into its parent is valid; the merge target is labelled instead.
- **Tiers driven only by what is visible** are rejected, because the sidebar's "which chat needs me" must stay true for rows scrolled off-screen. Polling the whole fleet in one batched query per repo is cheap enough to do.
- **Accepted limits:**
  - **Agent harnesses that drop inherited env vars.** Agents running inside sandboxes that strip env vars lose trace2. Those chats fall back to `worktree` attribution, and the panel shows "Limited tracking".
  - **Commits made in a terminal.** A user's own terminal commits in a chat's private worktree attach to that chat. That is intended, because the worktree is the chat's.

No repository files were modified.

## AB (winner)

[A has the leaner surface specs, the typed frontend contract, the turn-boundary insight and the useful codebase facts about `git_pr_create_for` and `monocode-git-changed`. B has the stronger tracking model: it attributes branches to the git process that touched them rather than to a time window, takes the stack base from GitHub's base history rather than the first value the app saw, runs stack discovery apart from status polling, handles forks and partial failures, and labels a stack-child merge instead of blocking it. The synthesis below uses B's model, adds A's types and copy-URL action, and resolves each conflict for whichever design misattributes less and needs fewer API calls.]

# PR tracking for chats: design

## Codebase facts this design builds on
- `upsert_session` overwrites `sessions.branch` from live git. Several app versions share one SQLite DB, so every schema change goes in as new tables or `ensure_column`.
- `monocode-git-changed` only fires for git actions the UI itself performs. If an agent switches branches from its shell, nothing fires, so agent activity has to be observed from Rust.
- `harness.rs` already sets env vars on the agents it spawns (`MONOCODE_HARNESS_PARENT`). Adding one per chat follows an existing pattern.
- `fs.rs` has `gh_run`/`gh_run_raw`, `GITHUB_RATE_LIMIT_BACKOFF` and `git_github_repositories_for` (the repo plus its fork parent).
- `git_pr_create_for` already accepts `--base`/`--head`, so creating a stacked PR only needs UI.
- `monocodeToolCall.ts` already parses shell blocks, so a command classifier over the transcript is practical.

---

## (a) Tracking model

### Attribution: by the process that ran git, not by time
A time window cannot separate chats that share a checkout. So **a branch belongs to a chat only when a git process started by that chat's agent created it, switched to it and wrote to it, or pushed it.**

When the harness spawns an agent, it sets `MONOCODE_SESSION_ID=<id>` and `GIT_TRACE2_EVENT=af_unix:dgram:<per-session-socket>`.
- Every git the agent runs inherits these: git started by subagents, git started by `gh` (including the push inside `gh pr create`), and git started by MCP servers.
- A Rust listener receives each git's `start` event (argv) and `def_repo` event (the worktree). So `cd ../other && git push` attaches to *other*.
- If the socket is gone, git skips tracing and nothing breaks. If the user already sets `GIT_TRACE2_*`, the app uses a per-session file target instead.

| Source | Trigger | Attaches |
|---|---|---|
| `app_created` | Create PR in GitChangesPanel succeeds | PR |
| `created` | `checkout -b/-B`, `switch -c/-C` | branch |
| `worked` | checkout/switch, then `commit`/`rebase`/`merge`/`cherry-pick` by this chat | branch |
| `pushed` | push to `refs/heads/X`, including `HEAD:X`. Ignores `--delete`, `:X` and `--tags` | branch |
| `worktree` | live branch of a worktree that only this one non-archived chat uses | branch |
| `linked` | `linkedWorkItem.kind==='pr'` | PR, tagged "Linked" |
| transcript hint | a `gh pr create` shell block whose output has `pull/N` | placeholder only |

Rules:
- **The default branch never attaches. Checking out a branch to read it never attaches.**
- **Shared-cwd chats get only process-attributed and `app_created` attachments.** If the user switches branches by hand in a shared checkout, that branch belongs to no chat.
- **Transcript hints render instantly but are never authoritative.** A hinted PR is confirmed only when its `headRefName` resolves to a branch this chat owns. This way "already exists" errors and `gh pr view` output never attach anything.
- **Preexisting PRs:** a PR whose `createdAt` is earlier than the chat's first claim on its branch gets `preexisting` and an "Existing" tag.
- **Fallback when trace2 is unavailable:** agents in sandboxes that strip env vars lose trace2. Those chats fall back to `worktree` plus confirmed transcript hints, and the panel shows "Limited tracking".

### Repo identity
- A PR's key is `(base_repo, number)`.
- A branch's push target is `(head_repo, branch)`. `head_repo` comes from the push's remote URL, or from `branch.<b>.remote`.
- To resolve a branch to its PRs, query each repo from `git_github_repositories_for` with `pullRequests(headRefName:$b, first:5)`. Keep only PRs whose `headRepository.nameWithOwner == head_repo`.
- This handles fork-to-upstream PRs (this repo's own `fork`/`origin` setup) and rejects strangers' PRs that reuse the same branch name.

### Persistence (additive; `sessions.branch` still means "live branch")
```sql
session_branches(session_id, worktree_root, branch, head_repo, source,
  first_claim_at, last_seen_at, next_lookup_at, PRIMARY KEY(session_id, worktree_root, branch))
session_prs(session_id, base_repo, number, source, attached_at, preexisting, dismissed,
  PRIMARY KEY(session_id, base_repo, number))
pr_snapshots(base_repo, number, head_repo, head_ref, base_ref, head_oid, base_oid, json,
  fetched_at, terminal_at, error_count, PRIMARY KEY(base_repo, number))  -- shared across chats
pr_base_history(base_repo, number, seq, previous_ref, current_ref, changed_at,
  PRIMARY KEY(base_repo, number, seq))
pr_compare(repo, base_oid, head_oid, ahead, behind, merge_base_oid,
  PRIMARY KEY(repo, base_oid, head_oid))                                -- immutable
pr_tracker_lease(id=1, holder, expires_at)
pr_interest(holder, session_id, tier, updated_at)
```
- Snapshots store only facts GitHub returned.
- Branches with no PR yet are never deleted. `next_lookup_at` backs off instead: 30s while the chat is active, then 1h, then daily for 30 days, then only when the chat is opened.

Frontend contract:
```ts
type PrState = 'draft'|'open'|'merged'|'closed'|'unknown';
interface ChatPr extends PrSnapshot { source; preexisting: boolean;
  owned: boolean; ghost: boolean; ownerSessionId?: string; checkedOut: boolean;
  checks; review; mergeable; mergeState; restack?: 'behind'|'contains_merged_parent'; error?: string }
interface PrStack { id; trunk: string; members: ChatPr[] /* base→tip */ }
interface ChatPrSet { stacks: PrStack[]; standalone: ChatPr[]; featured?: ChatPr;
  attention; freshness: 'fresh'|'stale'|'never';
  gh: 'ok'|'missing'|'unauthenticated'|'rate_limited'|'offline'|'low_budget'; resumesAt?: number }
```

### Stack detection
**Edges.** A → B exists when B's *original base* equals A's head branch, in the same `base_repo`. The original base comes from `pr_base_history`, filled from GitHub's `BaseRefChangedEvent` timeline items:
- **Auto-retarget:** the change happened at or after the parent's `mergedAt`, and the parent's branch is gone. The edge is kept and shows as "Merged parent".
- **Deliberate retarget:** the change happened before the parent merged. The current base wins.

This stays correct for PRs first seen long after they were retargeted.

**Discovery is separate from status polling.** It is a bounded breadth-first search, with one aliased query per round over the whole frontier:
- parents: `headRefName == myBase`
- children: `baseRefName == myHead, states:OPEN, first:5`

Rules for discovery:
- Depth is capped at 6. Local ancestry usually means 1–2 rounds are enough.
- An unowned PR is admitted only when it sits between two owned PRs, or when it is the root parent. It shows as a ghost with its author.
- Neighbours owned by another chat appear with `ownerSessionId`.
- **Discovery runs only:** when a PR is newly attached, when a tick shows a changed `baseRefName` or child `totalCount`, or otherwise at most once per 10 min per stack.

**Ordering.**
- The trunk is the base that no member has as its head. Members are ordered base → tip.
- Siblings on one parent sort by `createdAt`, render depth-first and indent 12px.
- A component with a single PR is standalone.
- Stacks sort by latest activity, then standalone PRs by `attached_at` descending.

### Refresh and gh budget
**One Rust `pr_tracker` per machine.**
- It holds a SQLite lease renewed every 20s, so a dev build and the installed app never poll twice.
- Every window and app instance writes its visibility into `pr_interest`. This covers the main window and the floating Mono chats. Instances that are not the lease holder re-read `pr_snapshots` every 10s, which costs no network.

**Tick query.**
- One `gh api graphql` per `base_repo`, with up to 25 `pullRequest(number:)` aliases.
- Each alias selects `state isDraft mergeable mergeStateStatus reviewDecision headRefName headRefOid baseRefName baseRefOid` plus the `commits(last:1)` `statusCheckRollup` counts. The query also includes a `rateLimit{cost remaining resetAt}` block.
- `createdAt`, `mergedAt` and `mergeCommit{parents{totalCount}}` are fetched once per PR.
- Ticks never traverse stacks and never call `compare`. GraphQL cost scales with connection sizes, not with how many aliases there are.

**Partial failures.**
- A `gh_graphql` runner keeps stdout even when gh exits non-zero, and maps `errors[].path` to the alias that failed.
- An alias that fails twice is quarantined: polled alone at the cold cadence, with a row error.
- A timeout splits the batch in half and retries.
- Unconfirmed hint numbers never enter a batch.

**Restack facts.**
- REST `compare/{base_oid}...{head_oid}` is called only when the OID pair changes and the PR is on a visible surface. Results are cached in `pr_compare` forever.
- **Needs restack:** compare(A.head, B.head) has behind > 0.
- **Contains squash-merged parent:** A merged with a single-parent merge commit, and compare(A.head, B.head) has behind == 0.

| Tier | Members | Cadence |
|---|---|---|
| Hot | open PRs of the focused chat, any surface visible | 30s |
| Fleet | every open PR of every non-archived chat | 3 min while visible, 10 min while hidden |
| Terminal | merged/closed | once on transition, then only when viewed in Inbox |
| Mergeable retry | `UNKNOWN` aliases | after 5s, then 20s, then normal tier |
| Events (5s debounce) | trace2 push, git spawned by `gh`, `git_github_pr_action`, Create PR | affected repo |
| Focus | window focus, at most once per 60s | one fleet query per repo |

**Adaptive budget.** The tracker targets about 300 points/hour. `remaining` also reflects the agents' own `gh` use, so the tracker throttles on the whole account:
- below 1500 remaining: fleet slows to 15 min;
- below 500: hot tier only;
- on a rate-limit error: the existing global backoff.

**Stale** means the snapshot is older than 2× its tier interval.

**Delivery.** Results go to `pr_snapshots`, then Rust emits `pr-snapshots-updated`. `useChatPrs(sessionId)` renders from SQLite first, then subscribes.

**Attention, worst first:**
1. conflicting
2. checks failing
3. changes requested
4. needs restack / contains merged parent
5. behind base
6. checks pending
7. ready
8. neutral

Draft, merged and closed are always neutral.

---

## (b) Surfaces

### 1. Composer chip (`PrChip`)
**Placement:** after `BranchPicker`. Same `h-6`, 12px text, `text-content/45` and hover fill as `GitPickerTrigger`. Max width 168px.

**Featured PR,** in priority order:
1. the PR whose head is the live branch;
2. otherwise the open PR with the worst attention;
3. otherwise the most recent PR.

**At rest:**
- Status icon, then `#482`.
- If the featured PR is in a stack, a **stack strip**: one 3×10px bar per member, base on the left, each in its state colour. The featured member is at full opacity, the others at 50%, and ghosts are hollow. A 6-member strip is 26px wide and shows "3 of 4 merged, mine is next" without text.
- `+N` in `content/35` for PRs outside the featured stack.
- A 6px dot only for rose (blocking) or amber (needs action).
- **Zero PRs: no chip.**

**Hover:** opens `PrSetCard` after 220ms, closes after 100ms. **Click:** opens the same card pinned.

### 2. Sidebar row
- One right-aligned glyph. It merges with the `linkedWorkItem` badge when the linked PR is part of the set, so there are never two.
- 1 PR: status icon, 12px, no number. Several PRs: a stacked-PR icon plus a count.
- An attention dot sits on the icon's corner. The fleet tier keeps it accurate even for rows scrolled out of view.
- A stale glyph drops to 50% opacity. Archived chats show no glyph.
- Hover opens the card on `side="right"` after 400ms, so moving the pointer down the list doesn't cause flicker.

### 3. GitChangesPanel
The button becomes a **Pull requests · N** section, with `Updated 40s ago` on the right.
- **Rows:** the same component as the card. The live-branch PR comes first, with a 2px accent bar.
- **Primary action:**
  - **Create PR**, with a base selector. If a branch this chat owns is an ancestor of HEAD but not of the default branch, the selector preselects **Stack on #480 (feat/a)**. The check is a local `merge-base --is-ancestor`, or the compare API for remote projects.
  - **View #482** once a PR exists.
- **Row `⋯` menu:** ready/draft, merge, close/reopen, copy URL.
- **Merging a stack child is allowed but labelled with its real target,** e.g. "Squash into feat/a (not main)", and confirmed first.
- "Show hidden (1)" restores dismissed PRs.

### 4. Inbox stack rail
- A stepper above `InboxPrOverview`: `main ← #480 ← [#482] ← #485`.
- Each node is a 28px pill: icon, `#N`, title up to 18ch. The node being viewed gets a `selection-*` fill. Merged parents stay in place, in violet with `GitMerge`.
- With 5–6 nodes, middle titles collapse to numbers before anything wraps. Clicking a node navigates.
- **Health line:** one message, the highest-attention one, each drawn straight from data:
  - "#480 was squash-merged. #482 still carries its 4 commits, so rebase onto main."
  - "#485 is 2 commits behind #482."
  - "Merge order: #480 first."
- **Draft restack prompt in owning chat** puts an editable prompt in that chat's composer and never sends it.

---

## (c) `PrSetCard`
- **Frame:** 360px wide, max height 440px with internal scroll, glass Popover, z-index 80.
- **Header:** `4 pull requests from this chat` · `Updated 12s ago` (11px, muted) · refresh button.
- **Stack group:** label `Stack · 3 into main`. Rows run **tip at the top, base at the bottom**, so merging reads bottom-up. A 1px `stroke` connector joins the status icons, and siblings are indented.
- **Other group:** standalone PRs.
- **Row (40px):**
  - Line 1: icon, `#482`, truncated title, then right-aligned glyphs. Only glyphs carrying a signal render:
    - checks: ✓, `2×`, or a static pending ring;
    - review: approved, or changes requested;
    - merge: conflict, `↓3`, or `restack`.
  - Line 2 (11px, `content/45`): `feat/b → feat/a`, then a tag: `HEAD`, `Not checked out`, `Existing`, `by @alice` (ghost) or `Other chat ›`.
- **Footer:** gh state messages, plus `↵ Inbox · ⌘↵ GitHub · ⋯ actions`.
- **Why not reuse the `UserLinkPreview` card:** its summary and author block costs about 200px per PR. That fits a single link preview and breaks down at 8 rows. A row click opens the full detail in Inbox instead.

---

## (d) States

| State | Chip / sidebar | Card / panel |
|---|---|---|
| None | hidden | "No pull request yet" + Create PR |
| 1 PR / many | icon `#N` (+`+N`) | rows |
| Stack | `#N` + strip | stack group with connector |
| Stack + standalone | strip + `+N` | Stack, then Other |
| Hint only, not confirmed | neutral icon `#N`, width reserved | "Confirming…" with skeleton glyphs |
| First fetch | neutral icon, width reserved | skeleton rows |
| Snapshot persisted, refreshing | snapshot, no spinner | "Updating…" |
| Stale | 50% opacity | amber `Updated 9m ago` + Retry |
| One PR errored / quarantined | unchanged | row: "Couldn't load · retrying 14:40" |
| gh missing | last snapshot, muted | "GitHub CLI not found" + install link |
| gh unauthenticated | muted | "Run `gh auth login`" + copy button |
| Rate limited | last snapshot | "GitHub limit · resumes 14:32"; Refresh disabled |
| Low budget | normal | "Refreshing less often to save GitHub quota" |
| Offline | last snapshot | "Offline · last known status" |
| Branch not checked out | not featured | `Not checked out`; `Worktree removed` hides checkout actions |
| Parent merged, child auto-retargeted | violet bar stays | "Merged parent" in the stack |
| Ghost / cross-chat neighbour | hollow / 50% bar | `by @alice`, no actions / `Other chat ›` |
| Limited tracking (env stripped) | normal | "Limited tracking" note |
| Remote project before Phase 4 | normal | "Agent-made branches aren't tracked on remote hosts yet" |
| Dismissed | gone | "Show hidden (1)" |

---

## (e) Interaction and accessibility
- **Chip:** a `<button>` with `aria-haspopup="dialog"` and `aria-expanded`. Its full label reads like "PR 482 open, checks failing, stack 2 of 3, 4 pull requests".
- **Hover card vs pinned card:** the hover card never takes focus. Enter, Space or click opens the pinned `role="dialog"`, which traps focus. Esc returns focus to the chip.
- **List structure:** `role="list"`, or a `tree` for stacks with siblings. Each item has a primary link plus a visible `⋯` button. Rows with actions are not a listbox.
- **Keys:**
  - ↑/↓ and Home/End use roving tabindex across the primary links.
  - Tab moves to the row's `⋯` button. ←/→ collapse and expand siblings in the tree.
  - ↵ opens Inbox, ⌘↵ opens GitHub, ⌥↵ copies the URL, ⌫ dismisses with an undo toast.
  - Every shortcut is also in `⋯`.
- **Not colour alone:** the four lucide PR icon shapes plus ✓, ×, ring, ↓ and conflict glyphs.
- **Stack strip:** `aria-hidden`; the chip's label describes the stack.
- **Live region:** polite, focused chat only, and only on transitions into blocking or merged.
- **Motion:** only the Popover fade. Pending checks use a static ring, so 12 sidebar rows never animate at once.

---

## (f) Phased delivery
1. **Attribution and single list.**
   - Scope: trace2 env and listener, transcript hints, `session_branches`/`session_prs`/`pr_snapshots`, repo identity, the lease and interest tables, hot and fleet ticks with partial-error handling and the adaptive budget, `useChatPrs`, the chip and card without grouping, and the sidebar glyph.
   - Exit tests:
     - Two chats in one checkout, each running `checkout -b` and push, never see each other's PRs.
     - A chat that switched branches twice shows both PRs.
2. **Stacks.** `pr_base_history`, discovery BFS, ordering, the strip, stack groups, and the GitChangesPanel list with "Stack on #N".
3. **Health and fleet.** `pr_compare`, restack and squash-parent detection, the Inbox rail and health line, ghost and cross-chat nodes, dismiss/restore, labelled stack merges, and restack prompt drafts.
4. **Remote.** The host daemon sets the same env vars, writes trace2 events to a file and streams them on turn end. Ancestry checks use the compare API.

---

## (g) Tradeoffs and rejected alternatives
- **Turn-diff / time-window attribution:** rejected. Parallel turns in a shared checkout attribute one chat's work to another. Trace2 ties every action to the process that ran it.
- **Git hooks / `core.hooksPath`:** rejected. They change user repos and fight husky. Trace2 is just an env var that git ignores when the target is missing.
- **A `gh`/`git` shim on PATH:** rejected as fragile across harnesses. Trace2 already sees the git that `gh` runs.
- **Transcript parsing as the source of truth:** rejected. It misses subagent and MCP paths and misreads "already exists" errors. It stays as an instant-render hint and as the fallback for chats with stripped env vars.
- **"All my PRs since the chat started":** rejected. It leaks other chats' PRs in the same repo.
- **Recording the stack base at first fetch:** rejected. It is wrong for any PR first seen after a retarget, so GitHub's base history is used.
- **Traversing stacks or running `compare` on every tick:** rejected. Cost would grow with depth and risk timeouts. Topology is event-driven, and compare results are cached by immutable OID pair.
- **Polling scheduled from the frontend, or one `gh pr view` per PR:** rejected. Windows would poll twice, and cost would scale with PRs × chats. One Rust tracker sends one batched query per repo. The cost is a new Rust module and an event bridge.
- **Visible-only tiers:** rejected. The sidebar's "which chat needs me" has to stay true for rows scrolled off-screen.
- **Disabling merge on stack children:** rejected. Folding a child into its parent is valid, so the target is labelled instead.
- **Horizontal stack inside the 360px card:** rejected; 6 members with titles don't fit. The stepper appears only in Inbox.
- **An always-visible "No PR" chip:** rejected as noise. Create PR stays in GitChangesPanel.
- **Accepted limits:**
  - Commits a user makes by hand in a chat's private worktree attach to that chat, which is intended.
  - Chats whose sandbox strips env vars get "Limited tracking".

No repository files were modified.
