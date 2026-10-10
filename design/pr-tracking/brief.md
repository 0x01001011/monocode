# Design brief: chat PRs, stacks and status

Source: `/impeccable shape` + one `/autoresearch reason` round (A, critic, B, synthesis, 3 blind judges; synthesis won 3-0). Full winning spec: `reason/261009-pr-tracking/candidates.md` (section "AB"). Mockup: `mockup.html`.

## 1. Feature summary
Every chat remembers the pull requests it produced, including PRs on branches the agent has since switched away from. The composer header, sidebar row, Changes panel and Inbox show that set, render GitHub stacks as stacks, and track live status without exhausting the user's `gh` quota.

## 2. Primary user action
Glance at a chat and know whether its PRs need you (failing, conflicting, changes requested, needs restack), then reach the right PR in one move.

## 3. Design direction
- Restrained. Neutral ink on the app's existing `content`/`selection` tokens; color appears only as GitHub's own status vocabulary (emerald open, violet merged, rose closed, neutral draft, amber needs action).
- New tokens for `src/styles/index.css`: `--color-pr-open/merged/closed/warn` (icons, at least 3:1) plus `-text` variants (at least 4.5:1), with light-theme values (the app's 44 bare `*-400` status classes fail in light), and theme-scaled ink steps (`--ink-muted` 58% dark / 70% light, `--ink-on-fill` 70% / 80%) so secondary text clears 4.5:1 in both themes. 35% ink is for decorative glyphs only.
- Scene: a developer at a desk with 4 to 8 agent chats open in a dark editor-like shell, glancing between panes mid-flow; the default is dark, and light must hold up equally well.
- References: GitHub's PR status icons and colors (familiarity), Graphite's stack view (bottom-up merge order), Linear's issue hover card (dense, quiet rows).

## 4. Scope
Mid-fi interactive HTML mockup now (no app code). Production build only after this brief is confirmed, in the 4 phases below.

## 5. Layout strategy
- **Composer chip** after the branch button, same 24px trigger style: status icon, `#482`, a stack strip (one bar per member, base on the left), `+N` for PRs outside that stack, and an attention mark. Strip shapes repeat the colors: tall = this chat's current PR, short = merged, hollow = draft, hairline = someone else's. Attention: filled dot = blocking, ring = needs action. Zero PRs means no chip.
- **Narrow composers** (container query on the header row): the branch button keeps at least `min(14ch, 45%)`; below 400px the chip drops its strip and `+N`; below 320px the "Worktree" label collapses to its icon.
- **PrSetCard** (360px, the same Popover frame): header "N pull requests from this chat" + freshness + refresh; "Stack · 3 into main · 1 merged" with the tip on top and base at the bottom, joined by a 1px connector; then "Other". Each row is 40px: line 1 is icon, number, title, and right-aligned signal glyphs only when they carry signal; line 2 is `head → base` plus one tag (HEAD, Not checked out, Existing, by @user, Other chat).
- **Sidebar**: one glyph per row, replacing the linked-item badge when it duplicates it (single status icon, or PR icon + count) with an attention dot. Hover opens the same card on the right after 400ms.
- **Changes panel**: "Pull requests · N" list using the same row component (live branch first, marked by the selected fill and `HEAD` tag, no accent stripe), split button "View #482 ▾". Rows switch to a narrow layout under 340px (container query): signals move to line 2 so the title keeps the line, and the full title is always available as a tooltip. Create PR gets a labelled **Base** field that preselects `#482 · mc/tasks-panel-keyboard` with a `Stacked` tag when an owned branch is an ancestor of HEAD.
- **Inbox**: a stack rail `main ← #478 ← [#480] ← #482` (an ordered list in a `nav`) above the existing overview. When it runs out of room, nodes farthest from the viewed PR drop their titles first; if numbers alone still overflow, it scrolls sideways with faded edges and centers the viewed PR. Plus one health line with the most urgent fact and a "Draft restack prompt in “<chat name>”" action that drafts and never sends.

## 6. Key states
None (hidden), confirming (agent-pushed PR found in the transcript, width reserved), first fetch (skeleton), persisted snapshot refreshing (no spinner), stale (full contrast kept; clock icon on the chip, dashed outline on the sidebar icon, amber timestamp and Retry in the card), per-row error, gh missing, gh signed out (copy `gh auth login`), rate limited (resume time, refresh disabled), low budget, offline (last known), branch not checked out / worktree removed, parent merged with child auto-retargeted (stays in the stack), ghost or other-chat neighbor, limited tracking (sandbox strips env), dismissed (Show hidden).

## 7. Interaction model
Hover opens after 220ms (400ms in the sidebar) and closes after 100ms; the hover card never takes focus. In both states the card is one non-modal dialog (`role="dialog" aria-modal="false"`, labelled by its title). Esc closes it from anywhere, including a hover preview with focus elsewhere (WCAG 1.4.13). Click / Enter / Space pins it and focuses the first row; Esc or tabbing past either end returns focus to the chip. Every PR list (card, Changes panel) is one tab stop with ↑/↓/Home/End inside it; Tab reaches each row's ⋯ menu. ↵ opens Inbox, ⌘↵ opens GitHub, ⌥↵ copies the link, ⌫ dismisses with undo. Everything is also in ⋯. Row links use the real PR URL as `href`. All targets are at least 24×24 (sidebar icon via a pseudo-element); the focus ring is 2px with a 2px offset and uses `Highlight` in forced-colors mode. Status is never color alone (icon shape + glyph + aria label such as "PR 482 open, checks failing, stack 3 of 3, 4 pull requests"). The only motion is the Popover's existing 170ms open; pending checks use a static ring.

## 8. Tracking model (the part that makes "even after switching branches" true)
- **Attribution by process, not time.** The harness sets `MONOCODE_SESSION_ID` and `GIT_TRACE2_EVENT=af_unix:dgram:<socket>` per chat. Rust receives every git the agent (or its `gh`, subagents and MCP servers) runs, and attaches branches it creates, works on, or pushes. Shared-checkout chats can't leak into each other. Fallback: worktree branch + transcript `pull/N` hints confirmed by `headRefName`, labelled "Limited tracking".
- **Persistence** in new additive tables (`session_branches`, `session_prs`, `pr_snapshots`, `pr_base_history`, `pr_compare`, `pr_tracker_lease`, `pr_interest`). `sessions.branch` keeps meaning "live branch".
- **Stacks.** Edge A→B when B's original base equals A's head, read from GitHub's `BaseRefChangedEvent` history, so a stack survives its bottom PR merging. Discovery is a bounded event-driven search, separate from polling.
- **Refresh.** One Rust tracker per machine (SQLite lease) sends one aliased `gh api graphql` per repo: hot every 30s for the focused chat, fleet every 3 to 10 minutes, terminal PRs once. Adaptive to `rateLimit.remaining`, which includes the agents' own `gh` use. `compare` is cached by immutable OID pair.

## 9. Phases
1. Attribution + persisted list: chip, card, sidebar glyph. Exit test: two chats in one checkout never see each other's PRs, and a chat that switched branches twice shows both PRs.
2. Stacks: base history, discovery, strip, stack groups, "Stack on #N" create.
3. Health: restack and squash-parent detection, Inbox rail + health line, ghosts, dismiss, labelled stack-child merge.
4. Remote hosts.

## 10. Recommended references for implementation
`interaction-design.md` (hover/pinned popover, roving focus), `harden.md` (gh failure states), `polish.md` before ship.

## Open questions
- Trace2 adds an env var to every agent spawn. Is that acceptable for every harness MonoCode runs, or should phase 1 start with the transcript-hint fallback only?
- Should the sidebar glyph replace the existing `linkedWorkItem` badge outright, or only when the linked PR is in the chat's set (the brief assumes the latter)?
