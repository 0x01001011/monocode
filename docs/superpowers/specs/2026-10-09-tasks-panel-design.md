# Tasks panel: task tree, checklist, and flow for agent work

Date: 2026-10-09
Status: draft for review

## Goal

Show, for the active session, what the agent is working on and how far it got:
task tree, step checklist, per-task status, elapsed times, and the
implement → review → fix flow. It lives in a new **Tasks** tab in the Workspace
sidebar (next to Sessions / Explorer / Changes) and can open as a wide tab in
the main editor area.

## Sources (all four, merged into one board)

| Section | Source | Read through |
|---|---|---|
| Plan | superpowers SDD / executing-plans workspace: `<cwd>/.superpowers/sdd/<plan>/` (`progress.md` ledger, `plan-path`, `task-N-brief.md`, `task-N-report.md`, `review-<a>..<b>.diff`) | `listDir`, `statFiles`, `readTextFile` (existing, remote-aware; no new Rust) |
| Orchestration | MonoCode lead/worker run for the session | `orchestrator` store via `useSyncExternalStore` |
| Subagents | `Agent`/`Task` tool blocks in the session transcript (`agentRun`) | active `Session` blocks |
| Todos | `TodoWrite` / `TaskCreate`/`TaskUpdate` lists (`taskList` blocks) | active `Session` blocks; latest list per key |

Sections with no data are hidden. If none have data, show the empty state.

## Unified model (`src/features/tasks/model/taskBoard.ts`)

```ts
type BoardStatus = "pending" | "running" | "done" | "attention" | "failed" | "blocked" | "cancelled";

type BoardStage = {
  kind: "implement" | "review" | "fix" | "final-review" | "final-fix";
  label: string;            // "Implement", "Review", "R1", ...
  status: BoardStatus;
  verdict?: string;         // "spec ✅", "spec ❌ · 2 Important"
  startedAt?: number;
  endedAt?: number;
};

type BoardNode = {
  id: string;
  title: string;
  status: BoardStatus;
  startedAt?: number;
  endedAt?: number;
  badge?: string;           // "R1", "2 parked", model name
  stages?: BoardStage[];    // SDD only
  steps?: { text: string; done: boolean | null }[]; // null = unknown
  children?: BoardNode[];   // subagent steps, orchestration workers
  dependsOn?: string[];     // orchestration
  commits?: string;         // "129e9e2..e704fdd"
};

type BoardSection = {
  source: "sdd" | "orchestration" | "agents" | "todos";
  id: string;
  title: string;
  done: number;
  total: number;
  startedAt?: number;
  current?: { nodeId: string; stage?: string; since?: number }; // drives "Now: ..."
  nodes: BoardNode[];
  notes?: { rulings: string[]; minors: string[]; parked: string[] }; // SDD
};
```

Builders are pure functions and unit-tested in isolation:
`buildSddSection(workspace)`, `buildOrchestrationSection(run)`,
`buildAgentSection(blocks)`, `buildTodoSection(blocks)`.

## SDD ledger parsing (`sddLedger.ts`)

The grammar comes from the skill and from a real ledger (the 8-task kcode run in
`mc-0e12ce2e`). The parser is line-based and tolerant: it ignores lines it does
not recognise.

| Ledger line | Effect |
|---|---|
| `# SDD ledger — plan: <path>` | plan path / title |
| `Task N: implemented (<sha>); review: spec ✅/❌ …` | implement done; review stage with verdict |
| `Task N: fix round R/5 dispatched …` | fix stage R running |
| `Task N: fix round R/5 (X addressed, Y open …; commits a..b)` | fix stage R done/attention |
| `Task N: minor (deferred): …` | notes.minors |
| `Task N: parked — …` | notes.parked, badge |
| `… Ruling: …` (any line) | notes.rulings |
| `Task N: complete (commits a..b, …)` | task done, commits |
| `FINAL REVIEW …` / `Final fix wave: …` | final-review / final-fix stages on a synthetic "Final review" node |

Task titles and steps come from `task-N-brief.md` (`### Task N: <title>`; each
`- [ ] **Step k: …**` is one step). Briefs do not record which steps finished,
so steps show as done when the task is complete and as unknown (`null`, an
empty box) otherwise. The panel never invents step progress.

Status rules: a task with `complete` is done. A task whose last line is a fix
round, or that has a brief or report but no `complete`, is running. That is
true only for the first such task, because SDD runs tasks one at a time; any
later ones count as pending. A task with neither is pending. If the report's
`Status:` line is `BLOCKED` the task is blocked; `DONE_WITH_CONCERNS` sets
`attention`.

Times come from artifact mtimes, since the ledger records none:
- a task ends at the mtime of the review package that preceded its `complete` line;
- a task starts at the previous task's end (task 1 starts at the earliest brief);
- the implement stage ends at the `task-N-report.md` mtime;
- each review or fix stage starts at the mtime of its `review-a..b.diff`.

When an mtime is missing the time shows as "—". The panel refreshes every 3 s
while it is visible, and immediately when a tool call in the session completes.

If the session cwd has several plan workspaces, a picker in the header switches
between them. The default is the one whose `progress.md` changed most recently.

## Live tool timing (transcript change)

Tool blocks have no timestamps today. In `core/apply.ts`, stamp
`toolStartedAt = Date.now()` on `tool.started`, and stamp `toolEndedAt` the
first time the status becomes terminal (`toolCallState` ≠ pending). Both are
optional fields on `Block`. They persist with the blocks and are ignored by
older readers. Sessions restored from provider history before this change have
no times and show "—". Parsing Claude JSONL `timestamp` on restore is out of
scope (follow-up).

## UI

### Sidebar tab

- New `SidebarTabId` value `"tasks"`, label "Tasks", with a checklist icon in
  compact mode. Add it to `appearance.ts` (type, default order, guard),
  `projectSidebarTab.ts` (guard), and `Sidebar.tsx` (`TAB_LABELS`,
  `COMPACT_TAB_ICONS`, panel mount). The panel mounts only while the tab is
  selected, as Changes does.
- While anything is running, the tab label shows a small accent dot. There is
  no count.
- `Sidebar` gets a new prop `activeSession?: Session`.

```
Sessions  Explorer  Changes  Tasks•
─────────────────────────────────────
PLAN  skills-index-remote-ranking   ⤢
▓▓▓▓▓▓▓▓▓▓▓▓░░░░░  5/8 · 1h 52m
Now  Task 6 · Review · 2m 14s
  ✓ 1  Rust memoized scan          2m
  ▾ 2  Watcher, event, invalid…  14m  R1
       Implement 6m · Review ✗ · R1 4m · ✓
       ☑ Write the failing test
       ☑ Run test to verify it fails
       ☑ Implement watcher
       ☑ Run test to verify it passes
       ☑ Commit
  ◌ 6  Remote picker          2m 14s
  ○ 7  Real verification
  ○ 8  Build, install, ship
  ○    Final review
  ▸ Rulings 9  ▸ Minors 14  ▸ Parked 0

SUBAGENTS  2 running · 5 done
  ◌ code-reviewer   sonnet      1m 02s
  ✓ Explore         haiku          48s

TODOS  3/7
  ☑ Read plan
  ◐ Task 2
  ☐ Task 3
```

### Row anatomy (all sections)

A row contains, in order: a status glyph, an optional index, the title
(truncated to one line, with the full text in a tooltip), an optional badge,
and a duration aligned to the right in tabular numerals. While a row is running
its duration ticks every second. Clicking the chevron expands the stage strip
and the checklist, or the children. Clicking a row:
- SDD task: opens `task-N-report.md`, or the brief if there is no report.
- Subagent: scrolls the transcript to its tool block.
- Orchestration worker: opens the existing agent tab.
- Todo: does nothing.

Glyphs:
- `○` pending
- `◌` running (the existing `TerminalSpinner`)
- `✓` done
- `!` attention or failed, in the error color for failed
- `⏸` blocked
- `–` cancelled

### Full tab ("Open as tab", ⤢)

This is a virtual editor tab, `FilePaneTab.taskBoard = { sessionId }`. It
follows the `sessionChanges` precedent: a factory in `layout.ts`, sanitising in
`workspaceSnapshot.ts`, and a render branch in `SurfaceTabs`/`FilePane`. The
wide view shows each section as a table:

```
Task                          Implement  Review   Fix        Done    Time
1 Rust memoized scan          ●──────────●────────────────────●      2m
2 Watcher, event, invalid…    ●──────────✗────────R1 ✓─────────●     14m
6 Remote picker               ●──────────◌                           2m
7 Real verification           ○
```

Under the table is a thin timeline that draws each task's span across the
plan's total elapsed time, as a horizontal bar per task. The rulings, minors
and parked lists are always expanded in this view.

### Visual rules

- Use existing tokens only: `text-content/…`, `border-stroke`, `bg-selection`,
  `--color-accent` for running and progress, and the diff red/green tokens for
  failed and done.
- Use the restrained product register: no cards, no side-stripe borders. Group
  with spacing and section headers rather than lines.
- The section header is a 11px uppercase label. It is the only uppercase in
  the panel.
- Durations use `font-variant-numeric: tabular-nums`. Format: `48s`, `2m 14s`
  under 10 minutes, `14m`, `1h 52m`.
- Motion: the running spinner, plus a 150 ms opacity/height ease-out on
  expand. Respect `prefers-reduced-motion`.
- Rows are at least 24 px tall. Every expandable row is reachable by keyboard:
  arrow keys move between rows, Enter or Space toggles.
- Empty state: "Nothing to track yet. Plans run with superpowers, todo lists,
  subagents, and orchestration runs in this session appear here."

## Testing

- Parser tests use a sanitised copy of the real ledger and briefs as the fixture
  `test-fixtures/sdd/skills-index/`. Cover every line kind, unknown lines, a
  missing brief, a blocked report, and mtime-derived times.
- Builder tests for todos, subagents (with and without timestamps), and
  orchestration (`dependsOn`, dispatch times).
- `apply.ts` tests for `toolStartedAt`/`toolEndedAt` stamping, which happens
  once and is not overwritten by later updates.
- Render tests (`happy-dom`, `createRoot` + `act`): the sidebar shows the Tasks
  tab and persists the selection; the panel renders the sections, expand works,
  and the empty state appears.
- Tab persistence: `projectSidebarTab` accepts `"tasks"`; the snapshot
  round-trips `taskBoard` tabs.

## Out of scope

- Editing tasks or checking steps from the panel (it is read-only).
- Parsing timestamps from restored provider history.
- Projects that are not git (the SDD workspace needs a repo root; other sources
  still work).
