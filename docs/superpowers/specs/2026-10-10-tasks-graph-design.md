# Tasks tab: one view, a commit-graph tree, and ship readiness

Date: 2026-10-10
Status: draft for review ("audit, optimize, redesign the Tasks tab as one view with a git-graph-like
tree, every state, overview, remaining, gaps, defers, review states, commits, ship")
Builds on: `2026-10-09-tasks-flow-design.md`, `2026-10-09-tasks-overview-design.md`

## Decisions already made

| Question | Answer |
|---|---|
| Which view stays | The sidebar **Tasks tab**. The full-pane board tab is removed entirely. |
| Graph style | Multi-lane, like `git log --graph`. |
| Ship | Derived readiness from files already read. No git or GitHub calls. |
| Autoresearch | Composite browser score, 10 iterations, guard = tasks vitest + `tsc`. |

## Review of the first draft

The first draft (in chat) was checked against the code and against the devex tools users already
know (VS Code Git Graph and GitLens, GitHub Actions run view, Graphite stacks, Linear, Buildkite).

1. **Lanes carried no meaning.** SDD tasks run one at a time (`dependsOn` exists only for
   orchestration workers, `sections.ts:166`), so a second lane per task was decoration. Git graph
   users read a lane as "work that happened beside the main line". Fix: a lane opens only for work
   that really ran beside the plan: a review/fix loop, the final fix wave, and subagents or workers
   that run at the same time.
2. **The tree started below the fold.** At 240 px the status card, title, counts, segment strip,
   problems and flow strip stack six bands above the first task. Fix: one pipeline header that merges
   the flow strip, counts and segment strip, and a sticky bar once it scrolls away.
3. **Rows were too wide for a sidebar.** Gutter + glyph + title + SHA + duration does not fit at 240 px.
   Fix: progressive disclosure. The row shows one meta value; refs and commits appear on the expanded
   row and in row actions.
4. **One gap could not be computed.** `stepsFor` forces every step of a done task to `done`
   (`sddBoard.ts:270`), so "steps left unticked when the task finished" is invisible. Fix: keep the
   raw tick (`ticked`) next to `done`.
5. **No way to work the list.** A long plan needs filtering and a jump back to the current task,
   as in Linear and GitHub Actions. Fix: a filter and a "now" pointer.
6. **Colour per lane would break the vocabulary.** Git graphs colour lanes; PRODUCT.md spends colour
   only on state. Fix: lanes are neutral strokes; only nodes carry status colour, always with a glyph.

## Goal

One glance at the Tasks tab answers: where the plan is, what is left (tasks and steps), what went
wrong and where, what was deferred, which commits each task made, and whether the branch can ship.

## The view (sidebar Tasks tab, 240 to 480 px)

```
┌ status card (unchanged: what is happening, whether you are needed) ─────────┐
│ tasks-graph ▾                                    [All 9|Left 4|Problems 1] ⋯ │  plan picker, filter, menu
│ Spec ✓ › Plan ✓ › Build 3/6 › Check ○ › Ship 3 left                          │  pipeline header
│ ▮▮▮▮▮▯▯▯▯  3 of 6 tasks · 14 of 31 steps · 50m · about 30m left              │  strip + counts
│ Needs a look  [● Task 5 · fix 3 of 5]                                        │  problems (only when any)
├──────────────────────────────────────────────────────────────────────────────┤
│ ●  1  Parse ledger                                         3m               │
│ ●  2  Board model                     review clean         5m               │
│ ●  3  Overview UI                     fixed in 1 round     8m  ▸            │  collapsed: one ref
│ ├╮                                                                           │  expanded:
│ │◌ review: 2 issues                                                          │
│ │● fix 1 · 2 fixed                            44aa0b1                        │
│ ├╯ complete                                   9f8e7d6                        │
│ ◉  4  Graph view       NOW  2/5                                1m ▾          │  running, expanded
│ │   ✓ Write the failing test                                                 │
│ │   ✓ Build the lane model                                                   │
│ │   ○ Draw the rail                                                          │
│ ○  5  Ship node                       4 steps                                │
│ ○  Final review → final fixes                                                │
│ ◇  Ship · 3 things before ship                                         ▸     │  terminal node
├──────────────────────────────────────────────────────────────────────────────┤
│ Deferred · 4      Gaps · 1      Decisions made for you · 2                   │  collapsible groups
└──────────────────────────────────────────────────────────────────────────────┘
```

### Header: one pipeline instead of four bands

- **Pipeline row**: the flow strip gains a fifth phase, **Ship**, and Build carries its count
  ("Build 3/6"). Spec and Plan stay buttons that open their files.
- **Strip + counts row**: the segment strip and the counts line share one row at 340 px and above
  and wrap to two rows below. The counts line keeps today's words ("3 of 6 tasks · 4 left · 14 of 31
  steps", then time).
- **Problems row**: unchanged pills, only when there are problems.
- **Sticky bar**: when the header scrolls out, a 28 px bar pins to the top of the tab:
  glyph + "Task 4 · 2/5 · 3 left" + a **Jump to now** button (focuses the current row). It uses
  `position: sticky` inside the tab's scroller; no portal.

### Filter (Linear-style segmented control)

`All N · Left N · Problems N`, 24 px targets, `role="radiogroup"`, arrow keys move.
- **Left**: tasks not done and the final review when not done; each shows only its unticked steps.
- **Problems**: failed, blocked, fix round 3+, and rows with a gap.
- Hidden rows keep their place in the graph as a dashed rail segment with "3 done hidden", so the
  lane shape stays readable. The choice is kept per plan for the session.

### The graph tree

- **Main lane** holds the plan in order: tasks, then the final review, then the **Ship** node.
- **A side lane opens only for real work beside the line**:
  - A task's review and fix loop forks when the first review returns issues and merges at
    `complete`. A task whose first review was clean never forks: it stays one dot with "review
    clean".
  - The final fix wave forks from the final review and merges into Ship.
  - Subagents and orchestration workers that run while the plan runs get their own lane for as long
    as they run (`dependsOn` draws the fork from the task they depend on). At most 3 side lanes are
    drawn; more collapse into a "+2 lanes" marker on the last one.
- **Drawing**: each row has an SVG gutter (12 px per lane, at most 4 lanes = 48 px). Lines use
  `stroke-muted` at 1.5 px; fork and merge are quarter curves. Nodes: solid dot = done, ring = not
  started, ringed dot = running, hollow = review, diamond = Ship. Node fill is the status token;
  the row also carries the `TaskGlyph` label, so state is never colour alone.
- **Now pointer**: the running (or needs-a-look) row shows a small `NOW` ref pill (git-`HEAD` style,
  `bg-accent/22`, text `text-focus`). Only this node pulses, under `motion-safe`.
- **Refs (git-label style)**: up to two short pills per row, in this order:
  `fix 3 of 5`, `failed`, `blocked`, `no commit`, `2 deferred`, `review clean`, `fixed in N rounds`.
  More collapse into the expanded row. Refs reuse the status tokens on a tint.
- **Row meta (one value, right-aligned, tabular)**: done = duration; running = `k/N` steps then
  duration; not started = `N steps`.
- **Expanded row**: stages on the side lane (each with verdict and its commit SHA), then the steps.
  Steps are a checklist under the rail, not graph nodes.
- **Commits**: SHAs are 7-character mono links (`commits a1b2..c3d4` shows both ends). Activating one
  opens the existing commit view (`BoardTarget` kind `commit`).

### Row actions (hover, focus, keyboard)

On hover or focus a row shows icon buttons (24 px): **Open report/brief**, **Open commit**,
**Copy SHA**. Keyboard on a focused row: arrows/Home/End/Enter as today, `o` opens the target,
`c` copies the SHA, `n` jumps to now. Shortcuts are listed in the `?` legend.

### Ship node (terminal)

- Collapsed: `◇ Ship · Ready to ship` or `◇ Ship · 3 things before ship`.
- Expanded: a checklist, each unmet item a button that reveals its row:
  - every task done (`2 tasks left`);
  - final review clean, or its fix wave complete;
  - last test run passed (from `lastTestRun`; unknown when piped or never run, and then says so);
  - no gaps.
- Deferred items are listed under the checklist but never block.
- When ready: `Ready to ship · 6 tasks · 31 steps · 14 commits` and a **Copy summary** button.

### Copy summary (menu `⋯` and the Ship node)

Copies a short Markdown status for a PR body or standup: plan title, counts, per-task line with
review state and SHA, deferred items and gaps. Plain text, no links that leave the machine.

### Groups at the bottom

Three collapsible groups with counts: **Deferred** (parked + small issues saved for the end, each with
its task), **Gaps**, **Decisions made for you** (with **Change this**, moved from the board tab).
"See the open issues" and "Review decisions" on the status card now open and scroll to these groups
instead of opening a tab.

## States (all derived from data already read; no new I/O)

| State | Source |
|---|---|
| Task status | `BoardNode.status` (unchanged) |
| Review state | `stages`: clean, issues, fix round N of 5, fixed in N rounds, failed |
| Deferred | `parked` + `minors` notes, grouped per task |
| Gap: no commit | task `done` with no `commits` and no stage SHA |
| Gap: closed with parked items | `complete` line with `parked > 0` |
| Gap: steps unticked at finish | task `done` and plan steps with `ticked === false` |
| Gap: no final review | all tasks done and `finalReview` absent or pending |
| Ship | the checklist above |
| Commits | `implemented (sha)`, fix `implementedSha`/`commits`, `complete commits` |

## Model changes

- `BoardStep` gains `ticked: boolean` (the plan file's own tick); `done` keeps today's meaning.
- New pure modules, each with its own test file:
  - `model/graph.ts`: `buildGraph(section, extras) → GraphRow[]`, where
    `GraphRow = { id, kind: "task" | "stage" | "step" | "final" | "ship" | "lane"; lane; lanes: LaneCell[];
    fork?: number; merge?: number; status; refs: Ref[]; sha?: string }`. Pure, no React.
  - `model/gaps.ts`: `gapsFor(section) → Gap[]`.
  - `model/ship.ts`: `shipReadiness(section, testRun) → { ready, items, deferred, commits }`.
  - `model/summary.ts`: `planSummaryMarkdown(section, ship) → string`.
- `flow.ts` adds the Ship phase from `shipReadiness`.

## Removed

`TaskBoardView`, `TaskBoardSurface`, `TaskBoardRows`, `TaskBoardNotes` (its decision list moves into
the sidebar groups), the board branch in `FilePane` and `SurfaceTabs`, `isTaskBoardTab` and the
`taskBoard` tab source, `onOpenTasksTab`, the **Open as tab** button, and their tests. A saved
layout that still holds a board tab drops it on load. The browser fixture `tests/browser/task-board.*`
is removed; its checks move to `tasks-panel.spec.ts`.

## Not doing

- Reading git or GitHub (pushed, PR open). Ship stays derived.
- Per-lane colours, a separate timeline or waterfall view, drag or reorder.
- Ticking steps from the UI (read-only, as today).

## Accessibility and motion

- The tree stays `role="tree"`; the SVG gutter is `aria-hidden`; each row's accessible name reads the
  status, title, refs and meta ("Task 3, done, fixed in 1 round, 8 minutes").
- Text 4.5:1, lines and nodes 3:1, targets 24 px, no horizontal overflow at 240, 340 and 480 px, in
  all six theme and palette combinations.
- Motion: expand/collapse 150 ms ease-out on height via `grid-template-rows`; the now node pulse;
  both off under `prefers-reduced-motion`.

## Tests

- Unit: `graph.test.ts` (forks only on issues, merge at complete, final fix wave, worker lanes,
  lane cap, filter keeps the rail), `gaps.test.ts`, `ship.test.ts`, `summary.test.ts`,
  `sddBoard.test.ts` (`ticked`), `flow.test.ts` (Ship phase).
- happy-dom: tree with gutters, keyboard (`o`, `c`, `n`), filter, sticky bar, Ship reveal,
  groups, status-card buttons scroll to groups, no "Open as tab".
- Layout: saved board tabs are dropped.
- Browser (Chromium + WebKit): the measurements above, plus the rail lines and nodes at 3:1.

## Autoresearch loop (after the build)

- **Metric** (higher is better): `rubric_points - 5 × a11y_failures`. Rubric: 1 point for each
  state in the States table visible in the fixture, each keyboard action working, the sticky bar,
  and each filter. a11y failures come from the browser measurements.
- **Verify**: `npx playwright test -c preview-ux/pw-tasks.config.ts tasks-score` prints the score.
- **Guard**: `npx vitest run src/features/tasks src/app/shell && npx tsc --noEmit`.
- **Bound**: 10 iterations, each an `experiment:` commit, reverted with `git revert` when it does
  not improve the score or breaks the guard.
