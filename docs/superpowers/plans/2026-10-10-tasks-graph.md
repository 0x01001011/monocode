# Tasks graph view Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sidebar Tasks tab the only Tasks view: a commit-graph tree with every state, gaps, defers, review states, commits and ship readiness; remove the full-pane board tab.

**Architecture:** Pure model modules (`graph`, `gaps`, `ship`, `summary`) turn the existing `BoardSection` into rows and facts; a new `TaskGraph` component renders those rows as an ARIA tree with an SVG lane gutter; `TasksPanel` is rebuilt around a pipeline header, a filter, the graph, a Ship node and three note groups. The board tab and every reference to it are deleted.

**Tech Stack:** React 19, TypeScript, Tailwind v4 theme tokens, Vitest + happy-dom, Playwright (Chromium + WebKit).

**Spec:** `docs/superpowers/specs/2026-10-10-tasks-graph-design.md`

## Global Constraints

- Node 23: `export PATH=~/.nvm/versions/node/v23.11.1/bin:$PATH` before every npm/npx command.
- Theme tokens only (`text-muted`, `text-success`, `text-warning`, `text-danger`, `text-focus`, `border-muted`, `stroke-muted` via `currentColor`, `bg-selection-subtle`, `bg-accent/22`); `src/app/shell/tokenAdoption.test.ts` must stay green.
- Focus: `focus-visible:focus-ring-inset` (never with `outline-none`); outset `focus-visible:focus-ring` only on solid fills.
- Targets ≥ 24 px (`min-h-6`), text ≥ 4.5:1, lines and nodes ≥ 3:1, no horizontal overflow at 240/340/480 px.
- Copy: sentence case, plain words, no em dashes (except the existing "—" unknown-time placeholder).
- Motion: 150 ms ease-out, only on state change, off under `prefers-reduced-motion` (`motion-safe:`).
- Status is never colour alone: every node also has a `TaskGlyph` label or words.
- Commits: explicit paths only (`git add <paths>`), never `git add -A`, `git stash`, `git reset`, or push.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A ledger with commit ranges (`a1b2c3d..e4f5a6b`) and bare SHAs both render as 7-char links; an empty or malformed `commits` string renders no link (Task 1 test `stage shas from ranges and bare shas`).
2. A plan with 0 tasks, or only a final review, renders no graph rows except Ship and never throws (Task 3 test `empty section`).
3. The `Left` filter on a fully done plan shows only the Ship node and the "6 done hidden" rail, not an empty list (Task 3 test `filter left on done plan`).
4. 200 tasks render without per-row O(n) scans (Task 4 test `renders 200 tasks under budget` asserts render < 200 ms in happy-dom).
5. A saved workspace with a `taskBoard` file restores without that file and without dropping its siblings (Task 6 test `drops saved board tabs`).

---

### Task 1: Board data for stages, ticks and parked counts

**Files:**
- Modify: `src/features/tasks/model/taskBoard.ts` (types)
- Modify: `src/features/tasks/model/sddBoard.ts` (`stagesFor`, `stepsFor`, node build ~l.353-380)
- Test: `src/features/tasks/model/sddBoard.test.ts`

**Interfaces:**
- Produces: `BoardStage.sha?: string` (implement: `implemented.sha`; fix: `implementedSha ?? endSha(commits)`), `BoardStep.ticked: boolean` (plan file's own tick; `false` for brief steps), `BoardNode.parkedAtClose?: number` (from `complete.parked` when > 0), `shortSha(ref: string): string[]` exported from `taskBoard.ts` (range `a..b` → `[a7, b7]`, bare → `[a7]`, anything not `[0-9a-f]{4,40}` → `[]`).

- [ ] **Step 1: Write failing tests** in `sddBoard.test.ts`: `stage shas from ranges and bare shas` (implement stage `sha === "a1b2c3d"`, fix stage sha from `implementedSha`, then from `commits` end), `ticked keeps the plan tick when the task is done` (done task, plan step `[ ]` → `done: true, ticked: false`), `brief steps are never ticked`, `parkedAtClose from the complete line`; and in a new `taskBoard.test.ts`: `shortSha` cases `"a1b2c3d4e5..f6a7b8c9"→["a1b2c3d","f6a7b8c"]`, `"abc1234"→["abc1234"]`, `"main"→[]`, `""→[]`.
- [ ] **Step 2: Run** `npx vitest run src/features/tasks/model/sddBoard.test.ts src/features/tasks/model/taskBoard.test.ts` → FAIL.
- [ ] **Step 3: Implement** the fields; `stepsFor` sets `ticked: step.done` (plan) / `false` (brief) and keeps `done: taskDone || step.done`.
- [ ] **Step 4: Run** the same command → PASS; also `npx vitest run src/features/tasks` → PASS (fix any test that deep-equals steps by adding `ticked`).
- [ ] **Step 5: Commit** `git add src/features/tasks/model/taskBoard.ts src/features/tasks/model/taskBoard.test.ts src/features/tasks/model/sddBoard.ts src/features/tasks/model/sddBoard.test.ts` + any touched tests; message "Keep stage SHAs, plan ticks and parked counts on the task board".

### Task 2: Gaps, ship readiness, summary and the Ship phase

**Files:**
- Create: `src/features/tasks/model/gaps.ts`, `gaps.test.ts`, `ship.ts`, `ship.test.ts`, `summary.ts`, `summary.test.ts`
- Modify: `src/features/tasks/model/flow.ts`, `flow.test.ts`; `src/features/tasks/hooks/useTaskBoard.ts` (expose `testRun` and `ship`)

**Interfaces:**
- Consumes: Task 1 fields.
- Produces:
  - `type GapKind = "no-commit" | "closed-with-parked" | "unticked-at-finish" | "no-final-review"`; `type Gap = { kind: GapKind; nodeId: string; label: string; text: string }`; `gapsFor(section: BoardSection): Gap[]` in plan order. Texts: `"no commit recorded"`, `"closed with 2 parked"`, `"3 steps not ticked"`, `"final review not run"`. `no-commit`: done task with no `commits` and no stage `sha`. `no-final-review`: every task done and `finalReview` missing or `pending` (nodeId `"final-review"`).
  - `type ShipItem = { id: "tasks" | "final" | "tests" | "gaps"; met: boolean | "unknown"; text: string; nodeId?: string }`; `type Ship = { ready: boolean; items: ShipItem[]; left: number; deferred: number; commits: number }`; `shipReadiness(section: BoardSection, testRun: TestRun | undefined): Ship`. Item texts when unmet: `"2 tasks left"`, `"final review not done"`, `"tests failed"` / `"no test run yet"` (`met: "unknown"`) / `"test result unknown"` (piped, `"unknown"`), `"1 gap"`. Met texts: `"every task done"`, `"final review clean"`, `"tests passed"`, `"no gaps"`. `ready` = every item `met === true`. `left` = items not met (unknown counts). `deferred` = parked + minors count. `commits` = distinct short SHAs across nodes and stages.
  - `planSummaryMarkdown(section: BoardSection, ship: Ship, gaps: Gap[]): string` — `# <title>`, a counts line, one `- [x]/[ ] Task N: title · <review state> · <sha>` line per task, then `Deferred` and `Gaps` lists when non-empty, then `Ship: Ready to ship` or `Ship: N things before ship`.
  - `FlowPhaseId` gains `"ship"`; `deriveFlow` input gains `ship?: Ship`; the Ship phase is appended when `plan.total > 0`: status `done` when ready, `failed` when a tests item is `false`, `pending` when nothing started, else `attention`; detail `"ready"` or `"3 left"`.
  - `TaskBoard` gains `testRun?: TestRun`, `ship?: Ship`, `gaps: Gap[]`.
- [ ] **Step 1: Write failing tests** for each function with the exact texts above (one `it` per gap kind and per ship item state, `summary` snapshot of a 3-task fixture, `flow` Ship phase statuses `done`/`failed`/`pending`/`attention`).
- [ ] **Step 2: Run** `npx vitest run src/features/tasks/model` → FAIL.
- [ ] **Step 3: Implement** the three modules and the flow/hook changes (hook builds `gaps` and `ship` with `useStable` like `flow`).
- [ ] **Step 4: Run** `npx vitest run src/features/tasks` → PASS.
- [ ] **Step 5: Commit** "Derive gaps, ship readiness and a copyable plan summary".

### Task 3: Graph rows model

**Files:**
- Create: `src/features/tasks/model/graph.ts`, `graph.test.ts`

**Interfaces:**
- Consumes: `BoardSection`, `BoardNode`, `Gap[]`, `Ship`, `shortSha`.
- Produces:
  ```ts
  export type GraphFilter = "all" | "left" | "problems";
  export type RefTone = "warn" | "danger" | "ok" | "muted" | "now";
  export type GraphRef = { text: string; tone: RefTone };
  export type LaneCell = "none" | "line" | "node" | "fork" | "merge" | "dashed";
  export type GraphRow = {
    id: string; parentId?: string;
    kind: "task" | "stage" | "step" | "final" | "ship" | "lane" | "hidden";
    lane: number;              // 0 = main
    cells: LaneCell[];         // one per lane drawn in this row, length = graph width
    status: BoardStatus; title: string; index?: number;
    refs: GraphRef[];          // at most 2, priority order from the spec
    meta?: string;             // "8m", "2/5", "4 steps"
    shas: string[];            // short shas for links
    node?: BoardNode; expandable: boolean; now: boolean;
  };
  export type Graph = { rows: GraphRow[]; width: number; counts: Record<GraphFilter, number> };
  export function buildGraph(input: { section: BoardSection; gaps: Gap[]; ship: Ship; expanded: ReadonlySet<string>; filter: GraphFilter; now: number; workers?: BoardNode[] }): Graph;
  ```
  Rules (from the spec): main lane tasks → final review → ship; a task forks to lane 1 only when its first review stage is `attention` or it has fix stages; fork cell on the first stage row, merge cell on the closing row (`complete`, with the task's `commits` shas) when the task is done; expanded tasks list stage rows (lane 1 when forked, else lane 0) then step rows (`kind: "step"`, cells all `line`); final review forks its `final-fix` stage to lane 1 and merges into ship; `workers` (running agents/orchestration nodes) each get lanes 2..3, extras fold into one `lane` row titled `"+N lanes"`; width = max lanes used + 1, capped at 4. Filters: `left` keeps not-done tasks and final review (steps: only `ticked === false`), `problems` keeps failed, blocked, fix round ≥ 3, and nodes with a gap; consecutive hidden tasks collapse to one `hidden` row titled `"3 done hidden"` with `dashed` main cell; ship always shown. `counts` counts tasks (+final) per filter. Meta: done → duration (`durationLabel`), running/attention → `k/N` then duration, pending → `N steps`. Refs order: `fix 3 of 5`(warn), `failed`(danger), `blocked`(danger), `no commit`(warn), `N deferred`(muted), `review clean`(ok), `fixed in N rounds`(muted). `now` is true for the first running-or-attention task (`NOW` ref is rendered by the UI from this flag).
- [ ] **Step 1: Write failing tests** `clean task stays one dot`, `review issues fork and merge at complete`, `final fixes fork into ship`, `worker lanes cap at 3 plus a fold row`, `filter left on done plan` (only `hidden` + `ship` rows, hidden title `"6 done hidden"`), `problems filter keeps gap rows`, `refs priority and cap of 2`, `meta per status`, `empty section` (rows = `[ship]`), `counts per filter`.
- [ ] **Step 2: Run** `npx vitest run src/features/tasks/model/graph.test.ts` → FAIL.
- [ ] **Step 3: Implement** `buildGraph` (pure; `durationLabel`/`glyphFor` move from `ui/TaskTree.tsx` to `model/nodeLabels.ts` and are re-exported from `TaskTree.tsx` so its callers keep working).
- [ ] **Step 4: Run** `npx vitest run src/features/tasks` → PASS.
- [ ] **Step 5: Commit** "Build commit-graph rows for the plan with lanes, refs and filters".

### Task 4: TaskGraph component

**Files:**
- Create: `src/features/tasks/ui/GraphGutter.tsx`, `src/features/tasks/ui/TaskGraph.tsx`, `TaskGraph.test.ts`

**Interfaces:**
- Consumes: `Graph`, `GraphRow` (Task 3).
- Produces: `GraphGutter({ cells, status, kind, now }: { cells: LaneCell[]; status: BoardStatus; kind: GraphRow["kind"]; now: boolean })` — `aria-hidden` SVG, 12 px per lane, height 100% of row; lines `stroke="currentColor"` in a `text-muted` wrapper at 1.5 px; node fill by status token class (`fill-success`, `fill-focus`, `fill-warning`, `fill-danger`, ring for pending, diamond for ship, hollow circle for stage `review`); the `now` node pulses with `motion-safe:animate-pulse`.
  `TaskGraph({ graph, label, onToggle, onOpen, onOpenCommit, onCopySha, reveal }: { graph: Graph; label: string; onToggle(id: string): void; onOpen(row: GraphRow): void; onOpenCommit(row: GraphRow, sha: string): void; onCopySha(sha: string): void; reveal?: { id: string; token: number } })` — `role="tree"`; each row `role="treeitem"` with `aria-level`, `aria-expanded` when expandable, accessible name `"Task 3, done, fixed in 1 round, 8m"`; roving tabindex; keys: ArrowUp/Down/Home/End/ArrowLeft/ArrowRight/Enter as `TaskTree`, `o` → `onOpen`, `c` → `onCopySha(row.shas.at(-1))` when any, `n` → focus the `now` row. Row layout: gutter, glyph (`TaskGlyph`), index, title (truncate; steps `line-clamp-2`), refs (≤2 pills `rounded-full px-1.5 text-[11px]`, tone → `bg-warning/12 text-warning` etc., `now` → `bg-accent/22 text-focus` text `NOW`), meta (right, tabular, `text-muted`). Row actions appear on `:hover` and `:focus-within` (`opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`, still in tab order only when visible via `focus-within`): `Open report`/`Open brief` (when `node.target`), and per sha a mono link button `a1b2c3d` (`onOpenCommit`) plus a `Copy SHA` icon button (`aria-label="Copy a1b2c3d"`). Expanded stage rows always show their sha links (not only on hover). Hidden rows are plain `treeitem`s with muted text. Reveal behaves like `TaskTree`'s (scroll nearest, focus, reduced motion jumps). Expanded children animate open with `grid-template-rows` 0fr→1fr over 150 ms ease-out under `motion-safe:` only.
- [ ] **Step 1: Write failing tests** (happy-dom, like `TaskTree.test.ts`): tree roles and levels, accessible name, keyboard nav, `o`/`c`/`n`, sha link calls `onOpenCommit` with the full row and sha, copy calls `onCopySha`, refs render at most 2, `NOW` pill only on the now row, gutter has `aria-hidden`, reveal focuses the row, `renders 200 tasks under budget`.
- [ ] **Step 2: Run** `npx vitest run src/features/tasks/ui/TaskGraph.test.ts` → FAIL.
- [ ] **Step 3: Implement** both components.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** "Draw the plan as a keyboard-friendly commit graph with refs and row actions".

### Task 5: Rebuild the Tasks tab around the graph

**Files:**
- Modify: `src/features/tasks/ui/TasksPanel.tsx`, `TasksPanel.test.ts`, `PlanOverview.tsx` (+test), `FlowStrip.tsx` (+test: Ship phase glyph and detail)
- Create: `src/features/tasks/ui/ShipNode.tsx`, `src/features/tasks/ui/NoteGroups.tsx`, `src/features/tasks/ui/GraphFilter.tsx` (+ tests in `TasksPanel.test.ts`)
- Modify: `src/app/shell/Sidebar.tsx` (drop `onOpenTasksTab` prop use; add `onChangeTaskDecision?: (note: BoardNote) => void` and `onOpenTaskCommit` passthrough), `src/app/App.tsx` (pass `taskActions.onChangeDecision` with the active session id)

**Interfaces:**
- Consumes: Tasks 2-4.
- Produces: `TasksPanel` props become `{ board; now; onAction?; onOpenNode?; onOpenFile?; onChangeDecision?(note: BoardNote): void; onCopy?(text: string): void }` (`onOpenAsTab` removed; `onCopy` defaults to `navigator.clipboard.writeText`). Commit links call `onOpenNode({ ...node, target: { kind: "commit", ref: sha } }, plan)`.
  Layout (spec "The view"): status card → header row (plan title or picker, `GraphFilter` radiogroup `All N · Left N · Problems N`, `⋯` menu button with `Copy summary`, `?` legend) → `FlowStrip` (with Ship) → `PlanOverview` strip + counts on one row ≥ 340 px (container query `@container` + `@[340px]:flex-row`) → problems pills → sticky bar (`sticky top-0 z-[1] h-7` shown when the header's sentinel leaves view via `IntersectionObserver`; glyph + `Task 4 · 2/5 · 3 left` + `Jump to now` button) → `TaskGraph` → `ShipNode` (expandable; unmet items are buttons that call reveal for `nodeId`; `Copy summary` when ready) → `NoteGroups` (`Deferred · N`, `Gaps · N`, `Decisions made for you · N` with `Change this` buttons; headings carry `data-notes="deferred|gaps|decisions"`). Filter state is kept per plan slug in a `Map` ref for the session. Status-card `see-issues` reveals the struggling task when one exists, else opens and scrolls to the `deferred` group; `review-decisions` opens and scrolls to `decisions`. Legend lists `o`, `c`, `n` shortcuts. Other sections (agents, todos, orchestration) keep `TaskTree`.
- [ ] **Step 1: Write failing tests** in `TasksPanel.test.ts`: no `Open as tab` button; filter radios with counts and switching rows; sticky bar appears when the sentinel is not intersecting (mock `IntersectionObserver`) and `Jump to now` focuses the now row; Ship node text `Ready to ship` / `3 things before ship`, unmet item reveals its row; `Copy summary` calls `onCopy` with `planSummaryMarkdown` output; groups render counts and `Change this` calls `onChangeDecision`; `see-issues` scrolls to deferred when no struggling task; commit link calls `onOpenNode` with `target.kind === "commit"`; flow strip shows Ship.
- [ ] **Step 2: Run** `npx vitest run src/features/tasks/ui` → FAIL.
- [ ] **Step 3: Implement** the panel, the three small components, and the Sidebar/App wiring.
- [ ] **Step 4: Run** `npx vitest run src/features/tasks src/app/shell && npx tsc --noEmit -p .` → PASS.
- [ ] **Step 5: Commit** "Make the Tasks tab one view: pipeline header, filter, graph, ship node and note groups".

### Task 6: Remove the board tab

**Files:**
- Delete: `src/features/tasks/ui/TaskBoardView.tsx`, `TaskBoardView.test.ts`, `TaskBoardSurface.tsx`, `TaskBoardSurface.test.ts`, `TaskBoardSurface.hidden.test.ts`, `TaskBoardRows.tsx`, `TaskBoardNotes.tsx`, `src/features/files/ui/FilePane.taskBoard.test.ts`, `tests/browser/task-board.{html,tsx,spec.ts}`
- Modify: `src/features/workspace/model/layout.ts` (remove `TaskBoardSource`, `taskBoard` field, `newTaskBoardTab`, `isTaskBoardTab`, `openTaskBoardTab`, key/branch uses), `workspaceSnapshot.ts` (a file with a `taskBoard` key returns `null`; remove `sanitizeTaskBoard`), `src/features/workspace/ui/SurfaceTabs.tsx`, `src/features/sessions/model/sessionWorkspaceLifecycle.ts`, `src/features/files/ui/FilePane.tsx`, `src/app/App.tsx` (`onOpenTasksTab`, `openTaskBoardTab` import, title-key branches at ~13370), `src/app/shell/Sidebar.tsx` (`onOpenTasksTab` prop), and their tests that mention task boards.
- Test: `src/features/workspace/model/workspaceSnapshot.test.ts`

**Interfaces:**
- Consumes: Task 5 (panel no longer needs `onOpenAsTab`).
- Produces: no `taskBoard` anywhere in `src/` (`grep -rn "taskBoard\|TaskBoard" src` returns only `useTaskBoard`/`TaskBoard` hook type names).
- [ ] **Step 1: Write failing test** `drops saved board tabs`: a snapshot with three files, the middle one `{ taskBoard: { sessionId: "s1" } }`, restores the other two and keeps `activeFileId` valid (falls back to the first remaining file when it pointed at the board).
- [ ] **Step 2: Run** `npx vitest run src/features/workspace/model/workspaceSnapshot.test.ts` → FAIL.
- [ ] **Step 3: Delete and edit** the files above.
- [ ] **Step 4: Run** `npx vitest run src && npx tsc --noEmit -p .` → PASS.
- [ ] **Step 5: Commit** "Remove the full-pane Tasks board tab; the sidebar Tasks tab is the one view".

### Task 7: Browser fixture, measurements and the score

**Files:**
- Modify: `tests/browser/tasks-panel.tsx`, `tasks-panel.spec.ts`, `tasks-focus.spec.ts`
- Create: `tests/browser/tasks-score.spec.ts`

**Interfaces:**
- Consumes: Task 5 UI.
- Produces: fixture states (query `?state=`): `running` (fork + fix + NOW + steps), `problems` (failed, blocked, fix 3 of 5, gaps), `ready` (all done, final clean, tests passed), `deferred` (parked + minors), `workers` (2 worker lanes). `tasks-score.spec.ts` prints one line `TASKS_SCORE <n>` where `n = rubric - 5 * failures`. Rubric, 1 point each: every GapKind visible in `problems`; each ref tone visible; NOW pill; fork and merge cells; worker lanes; Ship ready text; Ship unmet buttons; each filter; sticky bar; `o`, `c`, `n` keys; copy summary; each note group; commit link opens. Failures: contrast (text 4.5, non-text 3), targets < 24 px, horizontal overflow, at 240/340/480 px × 6 theme/palette combos × the 5 states (Chromium only for speed).
- [ ] **Step 1: Update** the fixture and existing specs to the new UI (remove "Open as tab" checks; add gutter line and node non-text contrast at 3:1).
- [ ] **Step 2: Run** `npx playwright test -c preview-ux/pw-tasks.config.ts tasks-panel tasks-focus tasks-score` → PASS, and record the printed score.
- [ ] **Step 3: Commit** "Measure the graph view across themes and widths and score its coverage".

### After the tasks

1. Whole-branch review (subagent) against the spec; fix findings.
2. Autoresearch loop: metric `TASKS_SCORE` (higher), guard `npx vitest run src/features/tasks src/app/shell && npx tsc --noEmit -p .`, 10 iterations, `experiment:` commits, `git revert` on no gain.
3. Full verification: `npx vitest run`, `npx tsc --noEmit -p .`, Playwright set, `cargo` untouched (no Rust changes).
4. Evidence screenshots (dark and light, 240 and 340 px) into `docs/superpowers/evidence/tasks-graph/`; push `mc/tasks-panel-audit` to `fork`; PR into `0x01001011/monocode` `main`.
