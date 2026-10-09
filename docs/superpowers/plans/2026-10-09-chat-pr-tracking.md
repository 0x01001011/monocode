# Chat PR Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every chat remembers all pull requests it produced (across branch switches), renders GitHub stacks as stacks, and tracks live PR status, shown in the composer header, sidebar row, Changes panel and Inbox.

**Architecture:** Rust owns attribution and status. New additive SQLite tables record which branches/PRs each chat produced; one machine-wide tracker (SQLite lease) polls `gh api graphql` in batched aliased queries per repo, writes snapshots and emits `pr-set-changed`. Pure Rust derives stacks and health from snapshots + base-ref history. A new frontend feature folder `src/features/pr-tracking` consumes `pr_session_set` / `pr_summaries` through a `useSyncExternalStore` store and renders the chip, card, sidebar glyph, Changes-panel list and Inbox rail ported from the approved mockup.

**Tech Stack:** Rust (rusqlite, tauri 2, serde, `gh` CLI), React + TypeScript, Tailwind v4 (CSS vars in `src/styles/index.css`), vitest (`src/**/*.test.ts` only; component tests use `createElement`/`createRoot`/`act` with `// @vitest-environment happy-dom`, no testing-library).

**Spec:** `design/pr-tracking/brief.md` (+ `design/pr-tracking/mockup.html` as visual reference, `design/pr-tracking/reason/261009-pr-tracking/candidates.md` section "AB" for the full tracking design).

## Global Constraints

- Never open a PR against `origin` (`hardbeat920/monocode`). Push only to remote `fork`; PR target is `0x01001011/monocode` base `main`.
- Branch `mc/multi-pr-stack-status` is based on `fork/main` (9238499). New SQLite objects are `CREATE TABLE IF NOT EXISTS` **outside** the `current < N` version gates in `src-tauri/src/session_store.rs` (schema versions are shared with the installed app). Do not add a `schema_migrations` row.
- `sessions.branch` keeps meaning "live branch"; do not change its semantics or columns.
- All GitHub access goes through `gh` (`fs.rs` `gh_run`/`gh_with_backoff`, which share `GITHUB_RATE_LIMIT_BACKOFF`). Never add an HTTP client. New Rust code lives in new modules (`pr_store.rs`, `pr_stack.rs`, `pr_tracker.rs`, `pr_trace.rs`); do not grow `fs.rs` beyond making needed helpers `pub(crate)`.
- Remote (SSH) sessions are out of scope (phase 4): the chip, glyph and rail render nothing when the session is remote. Do not touch `remoteCommands.ts`.
- Zero PRs means no chip. Status is never color alone (icon shape + label + aria text). Stale data keeps full contrast (clock icon / dashed outline), never reduced opacity.
- Copy is verbatim from the brief/mockup: "N pull requests from this chat", "Stack · 3 into main · 1 merged", "Base", "Stacked", "Draft restack prompt in “<chat name>”", "GitHub CLI is signed out. Run gh auth login, then refresh.", "GitHub rate limit reached. Status refreshes again at HH:MM.", "Couldn't reach GitHub. Check your connection, then retry.", "No pull requests yet", "PRs opened from branches this chat creates or pushes appear here.", "Refresh pull request status", "Limited tracking". No em dashes in new UI copy.
- Accessibility: all targets at least 24×24, focus ring `outline: 2px solid var(--accent-ring)` equivalent to the app's existing ring (2px, offset 2px), popover is `role="dialog" aria-modal="false"` labelled by its title, Esc closes from anywhere, lists are one tab stop with ↑/↓/Home/End, hover delays 220ms (sidebar 400ms) open / 100ms close.
- Tokens: status colors and ink steps are added to `src/styles/index.css` with dark and light values exactly as in `design/pr-tracking/mockup.html` `:root` blocks (`--color-pr-open/merged/closed/warn` and `-text` variants; `--ink-muted`, `--ink-on-fill`, `--ink-faint`). New UI must not use bare `text-emerald-400`-style classes.
- Test commands (Node 23, Homebrew clang): `export PATH=~/.nvm/versions/node/v23.11.1/bin:$PATH`; Rust: `export SDKROOT=$(xcrun --show-sdk-path) CC=/opt/homebrew/opt/llvm@18/bin/clang CXX=/opt/homebrew/opt/llvm@18/bin/clang++` then `cd src-tauri && cargo test <name>`. Web: `npx vitest run <file>`, `npx tsc --noEmit`. Before each commit also run `cargo fmt` for Rust changes. Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Wire contract (shared by Tasks 1-12; serde `rename_all = "camelCase"`, TS mirrors in Task 7)

```rust
// pr_store.rs
pub enum PrState { Open, Merged, Closed }            // "open" | "merged" | "closed"
pub enum Checks { Passing, Failing, Pending, None }  // "passing" | "failing" | "pending" | "none"
pub enum Review { Approved, ChangesRequested, ReviewRequired, None } // "approved" | "changesRequested" | "reviewRequired" | "none"
pub enum Mergeable { Mergeable, Conflicting, Unknown }
pub enum Relation { Owned, Existing, Other }         // PR created by this chat | on its branch but not created by it | belongs to another chat/user
pub enum Attention { None, Pending, Action, Block }  // dot: Block = filled, Action = ring
pub struct PrSnapshot { repo: String, number: u32, url: String, title: String, state: PrState, is_draft: bool,
  head_ref: String, base_ref: String, original_base_ref: String, head_oid: String, author: Option<String>,
  checks: Checks, review: Review, mergeable: Mergeable, behind_by: Option<u32>, fetched_at: i64 /*ms*/ }
pub struct PrEntry { snapshot: PrSnapshot, relation: Relation, owner_session_id: Option<String>,
  on_live_branch: bool, parent: Option<u32> /*PR number in same repo*/, attention: Attention,
  attention_reason: Option<String> /* e.g. "Checks failing", "Merge conflict", "Changes requested", "Needs restack", "Behind main by 3" */,
  dismissed: bool, error: Option<String> }
pub struct PrStackGroup { repo: String, base_ref: String, members: Vec<u32> /* base first, tip last */, merged_count: u32 }
pub struct PrSetView { session_id: String, entries: Vec<PrEntry>, stacks: Vec<PrStackGroup>,
  tracking: Tracking /* "full" | "limited" */, status: TrackerStatus, refreshed_at: Option<i64> }
pub enum TrackerStatus { Ok, GhMissing, SignedOut, RateLimited{ until: i64 }, Offline, Idle }
pub struct PrSummary { count: u32, primary_number: u32, primary_state: PrState, primary_is_draft: bool,
  attention: Attention, stale: bool }
```
Tauri commands (registered in `lib.rs`): `pr_session_set(session_id) -> PrSetView`, `pr_summaries() -> HashMap<String, PrSummary>`,
`pr_record_url(session_id, url) -> ()`, `pr_record_hints(session_id, cwd, numbers: Vec<u32>) -> ()`,
`pr_set_interest(session_id, level: "hot"|"fleet"|"off") -> ()`, `pr_refresh(session_id) -> ()`, `pr_dismiss(session_id, repo, number, dismissed: bool) -> ()`.
Event `pr-set-changed` payload `{ sessionIds: string[] }` (empty array = everything).

## Review Focus

- Two chats share one checkout and each switches branches: each must see only PRs of branches it attributed (Task 2/3 tests).
- A chat that switched branches twice and whose first PR merged: the merged PR stays listed and the stack keeps its edge via base history (Task 5 test).
- `gh` missing / signed out / rate limited / offline must produce a `TrackerStatus` and keep last snapshots with `fetched_at`, never an empty set (Task 4 tests).
- Session with 0 PRs, session with 40 PRs, titles with emoji/CJK/very long text render without overflow or crash (Tasks 8-10 tests).
- A PR whose head repo is a fork, a PR with no checks, and a PR closed without merge produce valid attention values (Task 5/6 tests).

---

### Task 1: PR store (schema + queries)

**Files:**
- Create: `src-tauri/src/pr_store.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod pr_store;`), `src-tauri/src/session_store.rs` (call `crate::pr_store::ensure_schema(conn)` at the end of `migrate`, outside any `current < N` gate)

**Interfaces:**
- Produces (exact):
  `pub fn ensure_schema(conn: &Connection) -> rusqlite::Result<()>` creating tables `session_branches(session_id, repo TEXT, branch TEXT, source TEXT, first_seen INTEGER, last_seen INTEGER, PRIMARY KEY(session_id, repo, branch))`, `session_prs(session_id, repo, number INTEGER, relation TEXT, source TEXT, dismissed INTEGER DEFAULT 0, created_at INTEGER, PRIMARY KEY(session_id, repo, number))`, `pr_snapshots(repo, number, snapshot_json TEXT, fetched_at INTEGER, PRIMARY KEY(repo, number))`, `pr_base_history(repo, number, ref_name TEXT, at INTEGER)`, `pr_interest(session_id PRIMARY KEY, level TEXT, updated_at INTEGER)`, `pr_tracker_lease(id INTEGER PRIMARY KEY CHECK(id=1), holder TEXT, expires_at INTEGER)`, `pr_compare(repo, head_oid, base_oid, behind_by INTEGER, PRIMARY KEY(repo, head_oid, base_oid))`;
  `pub fn record_branch(conn, session_id: &str, repo: &str, branch: &str, source: &str, now: i64) -> rusqlite::Result<()>` (upsert: keeps `first_seen`, bumps `last_seen`);
  `pub fn session_branches(conn, session_id) -> rusqlite::Result<Vec<(String /*repo*/, String /*branch*/)>>`;
  `pub fn record_pr(conn, session_id, repo, number: u32, relation: Relation, source: &str, now) -> rusqlite::Result<()>` (never downgrades `Owned` to `Existing`);
  `pub fn session_pr_keys(conn, session_id) -> rusqlite::Result<Vec<(String, u32, Relation, bool /*dismissed*/)>>`;
  `pub fn set_dismissed(conn, session_id, repo, number, dismissed: bool)`; `pub fn upsert_snapshot(conn, &PrSnapshot)`; `pub fn load_snapshot(conn, repo, number) -> Option<PrSnapshot>`; `pub fn record_base_change(conn, repo, number, ref_name: &str, at: i64)`; `pub fn set_interest(conn, session_id, level: &str, now)`; `pub fn interest_levels(conn) -> Vec<(String, String)>`; `pub fn owners_of(conn, repo, number) -> Vec<String>` (session ids).
  The wire types in "Wire contract" are defined here (derive `Serialize, Deserialize, Clone, PartialEq, Debug`).

- [ ] **Step 1: Write failing tests** in `pr_store.rs` `#[cfg(test)]`, using `SessionStore::open_in_memory()` + `lock_conn()`: `ensure_schema_is_idempotent`, `record_branch_keeps_first_seen_and_updates_last_seen`, `two_sessions_same_branch_stay_independent`, `record_pr_never_downgrades_owned`, `snapshot_roundtrips_all_fields`, `dismiss_flag_persists`, `owners_of_returns_every_session_claiming_pr`.
- [ ] **Step 2: Run** `cargo test pr_store` → FAIL (module missing).
- [ ] **Step 3: Implement** the module per Interfaces; store snapshot as JSON text.
- [ ] **Step 4: Run** `cargo test pr_store` and `cargo clippy --all-targets -- -D warnings` for the new module → PASS (pre-existing upstream clippy failures in other files may be ignored; report them).
- [ ] **Step 5: Commit** `feat(pr): add PR store schema and queries`.

### Task 2: Branch attribution from session saves, hints and PR creation

**Files:**
- Create: `src-tauri/src/pr_attribution.rs`
- Modify: `src-tauri/src/session_store.rs` (`upsert_session`, after the live branch is computed near the `git_info_for` call: call `pr_attribution::note_branch(conn, session_id, cwd, branch)`), `src-tauri/src/harness.rs` (after `prepare_child(&mut cmd, &command)` in `harness_spawn`: `cmd.env("MONOCODE_SESSION_ID", &session_id)`), `src-tauri/src/fs.rs` (make `git_info_for`/repo-slug helper `pub(crate)` if not already), `src-tauri/src/lib.rs` (register `pr_record_url`, `pr_record_hints`, `pr_dismiss`)

**Interfaces:**
- Consumes: Task 1 `record_branch`, `record_pr`, `set_dismissed`.
- Produces: `pub fn repo_slug_for(cwd: &Path) -> Option<String>` ("owner/name" from the `origin`/resolved remote, cached per cwd for 60s); `pub fn note_branch(conn: &Connection, session_id: &str, cwd: &str, branch: Option<&str>)` (no-op when branch is None, detached, or the default branch `main`/`master`/repo default; source `"save"`); `pub fn parse_pr_url(url: &str) -> Option<(String, u32)>` (accepts `https://github.com/o/r/pull/12` with optional trailing path/query); commands `pr_record_url(session_id, url)` (relation Owned, source `"create"`), `pr_record_hints(session_id, cwd, numbers)` (relation Existing, source `"hint"`; repo from `repo_slug_for(cwd)`), `pr_dismiss`.

- [ ] **Step 1: Failing tests**: `parse_pr_url_accepts_pull_urls_and_rejects_others` (issues URL, non-github host, `pull/abc`), `note_branch_ignores_default_and_detached`, `note_branch_records_non_default_branch_once_per_branch_with_repo`, `switching_branches_keeps_both_branches_for_session`, `record_url_marks_owned`. Use an injectable repo resolver (`note_branch_with(conn, ..., resolve: impl Fn(&Path)->Option<String>)`) so tests need no git.
- [ ] **Step 2: Run** `cargo test pr_attribution` → FAIL.
- [ ] **Step 3: Implement** per Interfaces; the harness env line is the only change in `harness.rs`.
- [ ] **Step 4: Run** `cargo test pr_attribution` and `cargo test session_store` → PASS.
- [ ] **Step 5: Commit** `feat(pr): attribute branches and PRs to chats`.

### Task 3: Git trace2 listener (per-chat attribution beyond saves)

**Files:**
- Create: `src-tauri/src/pr_trace.rs`
- Modify: `src-tauri/src/harness.rs` (`harness_spawn`: when the listener socket path is available set `GIT_TRACE2_EVENT=af_unix:dgram:<path>` and `GIT_TRACE2_PARENT_SID=monocode-<session_id>`), `src-tauri/src/pty.rs` (same two env vars in `spawn_unix` for terminals; skip Windows), `src-tauri/src/lib.rs` (`pr_trace::start(app)` in setup, `mod pr_trace;`)

**Interfaces:**
- Consumes: Task 2 `note_branch_with`, `repo_slug_for`.
- Produces: `pub fn socket_path() -> Option<PathBuf>` (short path under the OS temp dir, at most 100 bytes, unix only; `None` on Windows or when the listener failed to bind); `pub fn parse_event(line: &str) -> Option<TraceEvent>` where `TraceEvent { session_id: String, cmd: String, worktree: Option<String> }` is extracted from trace2 JSON events (`sid` starts with `monocode-<id>/`, `cmd_name` event gives `name`, `def_repo` event gives `worktree`); `pub fn start(app: &AppHandle)` binds a `UnixDatagram`, reads in a thread, and for cmds in `checkout|switch|branch|push|commit|worktree|rebase|merge` throttles per (session, worktree) to once per 2s, resolves the current branch with `git_info_for(worktree)` and calls `note_branch_with` with source `"trace2"`, then emits `pr-set-changed` for that session.
- Ruling baked in: trace2 env is set only when the socket bound successfully; failure degrades silently to save-time attribution (UI label "Limited tracking" is driven by whether any `trace2` row exists for the session, see Task 5 `tracking`).

- [ ] **Step 1: Failing tests**: `parse_event_extracts_session_cmd_and_worktree` (fixture lines for `cmd_name` and `def_repo`), `parse_event_ignores_foreign_sid`, `throttle_allows_one_event_per_window`, `socket_path_fits_sun_path_limit`, and an integration test that binds the socket under a temp path, sends a datagram from a second socket and asserts the handler callback receives the parsed event.
- [ ] **Step 2: Run** `cargo test pr_trace` → FAIL.
- [ ] **Step 3: Implement** per Interfaces; gate the whole module with `#[cfg(unix)]`, provide no-op stubs on other platforms.
- [ ] **Step 4: Run** `cargo test pr_trace` and manually verify with a shell: `GIT_TRACE2_EVENT=af_unix:dgram:/tmp/x.sock GIT_TRACE2_PARENT_SID=monocode-test git status` produces an event line carrying `monocode-test/` in `sid` (record the output in the report).
- [ ] **Step 5: Commit** `feat(pr): attribute git activity via trace2`.

### Task 4: GraphQL tracker (discovery, snapshots, tiers, lease, errors)

**Files:**
- Create: `src-tauri/src/pr_tracker.rs`
- Modify: `src-tauri/src/fs.rs` (`pub(crate)` on `gh_run`, `gh_with_backoff` rate-limit accessor), `src-tauri/src/lib.rs` (`mod pr_tracker;`, spawn loop in setup, register `pr_set_interest`, `pr_refresh`)

**Interfaces:**
- Consumes: Task 1 store functions.
- Produces: `pub fn build_query(targets: &[Target]) -> String` where `Target::Branch{alias, owner, name, branch}` (discovery: `pullRequests(headRefName:, first:5, states:[OPEN,MERGED,CLOSED], orderBy:{field:UPDATED_AT,direction:DESC})`) and `Target::Pr{alias, owner, name, number}` (refresh), both selecting number, url, title, state, isDraft, headRefName, baseRefName, headRefOid, author{login}, mergeable, reviewDecision, `commits(last:1){nodes{commit{statusCheckRollup{state}}}}`, `timelineItems(itemTypes:[BASE_REF_CHANGED_EVENT], first:10){nodes{... on BaseRefChangedEvent{previousRefName currentRefName createdAt}}}`, plus `rateLimit{remaining resetAt cost}`; `pub fn parse_response(json: &str) -> Result<ParsedBatch, TrackerError>` (maps to `PrSnapshot` + base-change events; `original_base_ref` = first event's `previousRefName`, else `baseRefName`); `pub enum TrackerError { GhMissing, SignedOut, RateLimited(i64), Offline, Other(String) }` + `fn classify_gh_error(stderr: &str) -> TrackerError`; `pub fn tier_for(interest: &str, state: PrState, age_ms: i64, remaining: Option<u32>) -> Option<Duration>` (hot 30s, fleet 3 min, 10 min when `remaining < 500`, terminal PRs only once: `None` after first fetch, `off` → `None`); `pub fn acquire_lease(conn, holder: &str, now: i64, ttl_ms: i64) -> bool`; `pub fn status() -> TrackerStatus` (process-wide, set by the loop); commands `pr_set_interest`, `pr_refresh` (force an immediate cycle for the session's PRs). The loop runs only while holding the lease (ttl 60s, renewed each cycle), batches at most 20 aliases per request, one `gh api graphql -f query=…` per repo per cycle, runs `gh` with cwd = the session cwd for that repo, writes snapshots and base changes, then emits `pr-set-changed`.

- [ ] **Step 1: Failing tests** with fixture JSON files under `src-tauri/src/pr_tracker_fixtures/`: `parse_response_maps_open_pr_with_failing_checks`, `parse_response_uses_first_base_change_as_original_base`, `parse_response_handles_no_checks_and_null_author`, `parse_response_reports_partial_errors_per_alias`, `classify_gh_error_cases` (missing binary, "gh auth login", "rate limit", "could not resolve host"), `tier_for_table` (hot/fleet/low-budget/terminal/off), `lease_is_exclusive_until_expiry`, `build_query_batches_aliases_and_escapes_branch_names` (branch containing quotes/unicode), `discovery_creates_existing_relation_for_foreign_authored_pr`.
- [ ] **Step 2: Run** `cargo test pr_tracker` → FAIL.
- [ ] **Step 3: Implement**; the network call is behind `trait GhRunner { fn graphql(&self, cwd:&Path, query:&str)->Result<String,String>; }` so the cycle logic is tested with a fake runner (`cycle_persists_snapshots_and_sets_status_on_error` asserts last snapshots survive a `SignedOut` failure and `status()` becomes `SignedOut`).
- [ ] **Step 4: Run** `cargo test pr_tracker` → PASS; `cargo clippy` for new files.
- [ ] **Step 5: Commit** `feat(pr): batched GraphQL PR tracker`.

### Task 5: Stack, relation and tracking derivation + read commands

**Files:**
- Create: `src-tauri/src/pr_stack.rs`
- Modify: `src-tauri/src/pr_store.rs` (add `pub fn build_set_view(conn, session_id, live_branch: Option<(&str,&str)>, status: TrackerStatus, now: i64) -> PrSetView` and `pub fn build_summaries(conn, now) -> HashMap<String, PrSummary>`), `src-tauri/src/pr_tracker.rs` (commands `pr_session_set`, `pr_summaries` using the live branch from `session_store`), `src-tauri/src/lib.rs` (register)

**Interfaces:**
- Produces in `pr_stack.rs`: `pub fn derive_parents(prs: &[PrSnapshot]) -> HashMap<(String,u32), u32>` (edge A→B when same repo and `B.original_base_ref == A.head_ref`, A != B, picks the most recently updated A if several; a merged A still parents B), `pub fn group_stacks(prs: &[PrSnapshot], parents: &HashMap<..>) -> Vec<PrStackGroup>` (a group needs at least two members; members ordered base→tip; `merged_count`), `pub fn tracking_for(has_trace2_rows: bool, has_branches: bool) -> Tracking`.
- `build_set_view` sets `relation`, `on_live_branch` (snapshot.head_ref == live branch), `owner_session_id` for `Other`, sorts live-branch entry first, newest first otherwise, marks `dismissed`, leaves `attention` as `None` (Task 6 fills it).

- [ ] **Step 1: Failing tests**: `chain_of_three_orders_base_first`, `merged_parent_keeps_edge_after_child_retargeted_to_main` (child `base_ref=main`, `original_base_ref=feature-a`, A merged), `diamond_picks_one_parent`, `single_pr_has_no_group`, `fork_pr_same_branch_name_different_repo_not_linked`, `two_sessions_same_checkout_see_only_their_prs` (Review Focus 1), `branch_switch_twice_lists_both_prs_including_merged` (Review Focus 2), `tracking_is_limited_without_trace2`, `summaries_pick_live_or_newest_open_as_primary`.
- [ ] **Step 2: Run** `cargo test pr_stack pr_store` → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** the same tests → PASS.
- [ ] **Step 5: Commit** `feat(pr): derive stacks and per-chat PR sets`.

### Task 6: Health, attention and restack detection

**Files:**
- Modify: `src-tauri/src/pr_stack.rs`, `src-tauri/src/pr_tracker.rs` (add `compare` aliases for open PRs: `repository{ref(qualifiedName:"refs/heads/<base>"){compare(headRef:"<head>"){behindBy}}}` skipped when `pr_compare` has the `(head_oid, base_oid)` pair), `src-tauri/src/pr_store.rs`

**Interfaces:**
- Produces: `pub fn attention_for(entry: &PrEntryInputs) -> (Attention, Option<String>)` with order conflict > checks failing > changes requested > restack > behind > pending; reason strings exactly "Merge conflict", "Checks failing", "Changes requested", "Needs restack", "Behind <base> by N", "Checks running"; `Needs restack` when the parent PR is merged (child still open) or the parent's head moved (`behind_by > 0` against a base that is a parent's head ref). Merged/closed PRs are always `Attention::None`. `Block` = conflict/checks failing/changes requested, `Action` = restack/behind, `Pending` = checks running. `PrSummary.attention` is the max over non-dismissed entries.

- [ ] **Step 1: Failing tests**: `order_conflict_beats_failing_checks`, `merged_pr_has_no_attention`, `restack_when_parent_merged`, `behind_reason_includes_base_and_count`, `dismissed_entries_do_not_raise_summary_attention`, `closed_without_merge_is_none`, `compare_cache_skips_known_oid_pair`.
- [ ] **Step 2: Run** `cargo test pr_stack pr_tracker` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS; also `cargo test` (whole crate) must stay green.
- [ ] **Step 5: Commit** `feat(pr): attention and restack detection`.

### Task 7: Frontend data layer and view-model

**Files:**
- Create: `src/features/pr-tracking/model/types.ts`, `src/features/pr-tracking/model/prSetModel.ts`, `src/features/pr-tracking/model/prSetModel.test.ts`, `src/features/pr-tracking/data/prTracking.ts`, `src/features/pr-tracking/data/prTracking.test.ts`
- Modify: `src/platform/tauri/fs.ts` only if a shared helper is needed (prefer none)

**Interfaces:**
- Produces: TS mirrors of the Wire contract (camelCase, string unions); in `prSetModel.ts`: `ariaLabel(view: PrSetView, primary: PrEntry): string` (e.g. "PR 482 open, checks failing, stack 3 of 3, 4 pull requests"), `stripBars(view): {number:number; kind:"current"|"normal"|"merged"|"draft"|"other"}[]`, `primaryEntry(view): PrEntry | null` (live-branch entry, else newest open, else newest), `statusIcon(entry): "open"|"draft"|"merged"|"closed"`, `freshnessLabel(refreshedAt, now): string` ("Updated 12s ago"), `trackerNotice(status, now): {tone:"info"|"warn"; text: string; action: "retry"|"none"} | null` using the verbatim copy from Global Constraints, `sections(view): {stack: PrStackGroup[]; other: PrEntry[]; hiddenCount:number}`; in `prTracking.ts`: `getPrSet(sessionId)`, `usePrSet(sessionId?: string): PrSetView | null` and `usePrSummaries(): Record<string, PrSummary>` built on `useSyncExternalStore`, a module cache fed by `listen("pr-set-changed")` and invalidated per session, `setPrInterest(sessionId, level)`, `refreshPrSet(sessionId)`, `dismissPr(...)`, `recordPrUrl(...)`, `recordPrHints(...)`. All functions return null/empty when `invoke` rejects (no throw into render).

- [ ] **Step 1: Failing tests**: view-model pure tests for every function above including `ariaLabel` snapshots for failing/merged/draft/stack cases, `sections` with 40 entries, emoji/CJK titles untouched; store tests mocking `@tauri-apps/api/core` and `@tauri-apps/api/event` asserting `usePrSet` refetches on `pr-set-changed` for its session only and returns the cached value synchronously.
- [ ] **Step 2: Run** `npx vitest run src/features/pr-tracking` → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npx vitest run src/features/pr-tracking && npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit** `feat(pr-ui): data layer and view model`.

### Task 8: Tokens, status icon, strip, row

**Files:**
- Modify: `src/styles/index.css` (tokens, dark default + `html.theme-light`)
- Create: `src/features/pr-tracking/ui/PrStatusIcon.tsx`, `PrStrip.tsx`, `PrRow.tsx`, `PrRow.test.ts`

**Interfaces:**
- Consumes: Task 7 model.
- Produces: `PrStatusIcon({state, isDraft, checks?, size?})`, `PrStrip({bars})` (3×10 bars, current 12px, merged 6px, draft hollow, other 1px), `PrRow({entry, selected, narrowAware, onOpenInbox, onOpenGithub, onCopyLink, onDismiss})` implementing the 40px two-line row of the mockup, container-query narrow layout under 340px (`container: prlist / inline-size` set by the parent list), `title` attribute with the full title, real `href` to the PR URL, tag one of HEAD / Not checked out / Existing / by @user / Other chat, ⋯ menu button 24×24, attention dot/ring with `aria-label`.

- [ ] **Step 1: Failing tests** (happy-dom): row renders title/number/tag; `href` equals PR URL; attention dot is `aria-label="Checks failing"`; stale snapshot renders a clock icon and no `opacity` style; 200-char CJK/emoji title keeps `title` attribute full text.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (port tokens verbatim from `design/pr-tracking/mockup.html`). **Step 4: Run** tests + `npx tsc --noEmit` → PASS. **Step 5: Commit** `feat(pr-ui): tokens and row components`.

### Task 9: PrSetCard and composer chip

**Files:**
- Create: `src/features/pr-tracking/ui/PrSetCard.tsx`, `PrChip.tsx`, `usePrHoverCard.ts`, `PrChip.test.ts`
- Modify: `src/features/sessions/ui/Composer.tsx` (insert `<PrChip sessionId={sessionId} cwd={executionCwd} sessionName=… />` right after `BranchPicker`, guarded by `sessionId && !remoteSession`)

**Interfaces:**
- Consumes: Tasks 7-8; `Popover` from `src/shared/ui/Popover.tsx`.
- Produces: `PrChip` (24px trigger: status icon, `#N`, strip, `+N`, attention mark; hides strip/+N under 400px container width; hidden when `view` has no entries); `PrSetCard` (360px, header "N pull requests from this chat", freshness, "Refresh pull request status" button, "Stack · …" group with tip on top, "Other" group, empty/notice states, 8+ rows scroll inside max-height 440px); `usePrHoverCard()` (open 220ms, close 100ms, pinned on click/Enter/Space focusing first row, Esc anywhere closes, Tab past either end returns focus to trigger, roving ↑/↓/Home/End, `role="dialog" aria-modal="false" aria-labelledby`); the chip calls `setPrInterest(sessionId,"hot")` while mounted and `"fleet"` on unmount; the Composer passes `onOpenInbox` using the existing `LinkedWorkItem` open path (`onOpenWorkItem`-style callback already available in `SessionPane`; wire through props rather than importing App).

- [ ] **Step 1: Failing tests**: chip hidden with no entries; `aria-label` matches `ariaLabel()`; hover opens after 220ms (fake timers) and Esc closes; click pins and focuses first row; Tab past last row returns focus to chip; ArrowDown/End roving; card with 8 long-title rows has a scrollable list.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**. **Step 4: Run** tests + `npx tsc --noEmit` + `npx vitest run src/features/sessions` → PASS. **Step 5: Commit** `feat(pr-ui): composer chip and PR card`.

### Task 10: Sidebar glyph and transcript hints / PR-create hook

**Files:**
- Create: `src/features/pr-tracking/ui/PrSidebarGlyph.tsx`, `PrSidebarGlyph.test.ts`
- Modify: `src/app/shell/Sidebar.tsx` (`SessionCard` badge region ~L3395-3436), `src/features/source-control/ui/GitChangesPanel.tsx` (~L658-668 after `gitPrCreate` succeeds call `recordPrUrl(sessionId, url)`; pass `sessionId` prop if absent), `src/app/App.tsx` (on session load/finish-turn scan new assistant text for `github.com/<o>/<r>/pull/N` URLs and call `recordPrHints`/`recordPrUrl`, de-duplicated per session in memory)

**Interfaces:**
- Produces: `PrSidebarGlyph({sessionId, linkedWorkItem?})` using `usePrSummaries()`; renders one status icon (or PR icon + count when `count>1`) with attention dot, hit area 24×24 via pseudo-element, 400ms hover opens the same `PrSetCard` on the right; replaces the existing `linkedWorkItem` badge **only when the linked PR number is in the chat's set**, otherwise both render. Pure helper `extractPrUrls(text: string): string[]` in `src/features/pr-tracking/model/transcriptHints.ts` with tests (trailing punctuation, markdown links, issues URLs ignored, dedupe).

- [ ] **Step 1: Failing tests**: `extractPrUrls` cases; glyph replaces badge only when linked PR in set; glyph hidden with 0 PRs and badge unchanged.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**. **Step 4: Run** `npx vitest run src/features/pr-tracking src/app && npx tsc --noEmit` → PASS. **Step 5: Commit** `feat(pr-ui): sidebar glyph, hints and create hook`.

### Task 11: Changes panel list and Base field

**Files:**
- Create: `src/features/pr-tracking/ui/PrSection.tsx`, `PrSection.test.ts`, `src/features/pr-tracking/model/baseSuggestion.ts`, `baseSuggestion.test.ts`
- Modify: `src/features/source-control/ui/GitChangesPanel.tsx` (render `PrSection` under the sync actions; "View #N ▾" split button; Create PR dialog gets a labelled "Base" field)

**Interfaces:**
- Produces: `PrSection({sessionId, cwd, pr?})` ("Pull requests · N", same `PrRow`, one roving tab stop, narrow container query); `suggestBase(view: PrSetView, headBranch: string, ancestry: (a: string) => boolean): {ref: string; prNumber: number | null; stacked: boolean}` returns an owned open PR's head ref as base with `stacked: true` when `ancestry(headRef)` is true, else the default branch; "Stacked" tag shown beside the value `#482 · mc/tasks-panel-keyboard`. Ancestry check uses a new small Rust command `git_is_ancestor(cwd, ancestor, descendant) -> bool` in `fs.rs` (tested in Rust with a temp repo).

- [ ] **Step 1: Failing tests**: `suggestBase` cases (owned ancestor → stacked, non-ancestor → default, merged PR never suggested); `PrSection` renders N rows and one tab stop; Rust `git_is_ancestor_true_and_false` using a temp git repo.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**. **Step 4: Run** `npx vitest run src/features/pr-tracking src/features/source-control`, `cargo test git_is_ancestor`, `npx tsc --noEmit` → PASS. **Step 5: Commit** `feat(pr-ui): changes panel list and stacked base`.

### Task 12: Inbox stack rail and health line

**Files:**
- Create: `src/features/pr-tracking/ui/PrStackRail.tsx`, `PrHealthLine.tsx`, `src/features/pr-tracking/model/railFit.ts`, `railFit.test.ts`, `PrStackRail.test.ts`
- Modify: `src/features/inbox/ui/InboxView.tsx` (insert above the overview block in `InboxDetail`, ~L3030, gated by `tab === "summary" && isPr`; derive the set from the viewed PR's repo/number via a new command `pr_stack_for(repo, number) -> PrStackGroup | null` implemented in `pr_tracker.rs` over stored snapshots, registered in `lib.rs`)

**Interfaces:**
- Produces: `fitRail(widths: {number:number; full:number; compact:number}[], available:number, current:number): {mode:"full"|"compact"|"scroll"; compactNumbers:number[]}` (compacts nodes farthest from current first, then scroll); `PrStackRail` (`<nav aria-label="Stack, base to tip"><ol>`, ResizeObserver driven, scroll mode with faded edges centering current); `PrHealthLine({entry, sessionName, onDraftRestack})` showing the most urgent `attention_reason` and the action "Draft restack prompt in “<chat name>”" which only inserts a draft into that chat's composer (never sends) through the existing composer-draft API (`getComposerDraft`/setter used in `Composer.tsx`).

- [ ] **Step 1: Failing tests**: `fitRail` table (fits, compacts farthest first, falls to scroll); rail renders `ol` with current marked `aria-current="step"`; health line hidden when attention is None; restack action calls the draft setter and not send.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (+ Rust `pr_stack_for` test `stack_for_returns_group_containing_pr`). **Step 4: Run** `npx vitest run src/features/pr-tracking src/features/inbox`, `cargo test pr_stack`, `npx tsc --noEmit` → PASS. **Step 5: Commit** `feat(pr-ui): inbox stack rail and health line`.

### Task 13: Browser harness, audit and evidence

**Files:**
- Create: `tests/browser/pr-tracking.html`, `tests/browser/pr-tracking.tsx` (renders chip, card pinned, sidebar glyph, panel section, rail with mocked `PrSetView` fixtures: 3-stack, 40 PRs, CJK/emoji titles, every `TrackerStatus`, stale, dark and light via `?theme=light`), `tests/browser/pr-tracking.spec.ts` (Playwright, follows `transcript-scroll.spec.ts` conventions: 24×24 targets, no horizontal overflow at 900px and 360px container widths, Esc closes, focus ring 2px), `docs/superpowers/evidence/2026-10-09-pr-tracking/` (screenshots + `report.md`)

- [ ] **Step 1: Write the spec** with the assertions above and an axe-style contrast check reusing `/tmp/mc-audit/contrast.js` logic if present (else port its WCAG ratio function into the spec).
- [ ] **Step 2: Run** the spec per `tests/browser` convention (see existing spec header) → record failures.
- [ ] **Step 3: Fix** any harness-found defects in the UI components (no new features).
- [ ] **Step 4: Run** spec → PASS; capture dark/light screenshots via the gstack browse binary against the Vite dev server for the harness page into the evidence dir.
- [ ] **Step 5: Commit** `test(pr-ui): browser harness and evidence`.

---

## Self-review

- Spec coverage: attribution (T2, T3), persistence (T1), polling/lease/rate limit (T4), stacks (T5), health/restack (T6), chip/card (T9), sidebar (T10), Changes panel + Base (T11), Inbox rail + health line (T12), states (T7 notices, T9 card, T13 fixtures), a11y/responsive (T8-T13). Phase 4 remote is explicitly out of scope (Global Constraints).
- Open questions from the brief are ruled: trace2 is enabled only when the listener bound, with save-time attribution as fallback; sidebar glyph replaces the badge only when the linked PR is in the set.
