# Tasks panel: task tree, checklist, and flow for agent work

Date: 2026-10-09
Status: draft for review (UI revised over 4 critique rounds)

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

Status rules: a task with `complete` is done. The first non-complete task is
running when the ledger has any `Task N` line or that task has a report (briefs
alone are not evidence: the controller may extract every brief up front), and
all later tasks are pending, because SDD runs tasks one at a time. With no
ledger line and no report, every task is pending. A task in fix round 3 or
higher is `attention`. If the report's `Status:` line is `BLOCKED` the task is
blocked. `DONE_WITH_CONCERNS` does not change the status (a concerned report is
the normal state while its review runs).

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

Design was iterated in `prototypes/tasks-panel/` (v1 → v2 → index.html = round 3)
and scored with impeccable critique by independent reviewers each round. The
prototype is the visual reference; this section is the contract.

### Status card (the glance)

The top of the panel is one card that answers "what is happening, and do you
need me?" It covers **every session in the project**, not just the active one:
the most severe state anywhere wins, and an alert from another session names
that session. Exactly one state shows, by priority:

| State | Color · glyph | Trigger | Card copy (example) | Actions |
|---|---|---|---|---|
| Needs you (run is stopped) | red · "?" square | a session has `pendingQuestion` set (plus any pending tool approval the harness exposes; confirm the field at plan time), or an SDD controller stopped to ask (round 5 failed, BLOCKED) | "ssh-hardening is waiting for your answer" / "Task 3 asks: “Keep password login as a fallback?” · 3m ago" | **Answer in ssh-hardening** (Enter when the card is focused), Remind me in 10m |
| Struggling (still self-correcting) | amber · "!" | an SDD task in fix round ≥ 3, or an orchestration worker failed and is retrying | "Task 6 is on fix round 3 of 5" / "The reviewer has sent it back 3 times. If round 5 fails, it stops and asks you." | See the N open issues |
| Quiet too long | amber · hollow ring | session `busy` with no harness event for `quietAfterMs` (default 5 min, setting) | "No activity on Task 6" (headline: the running task, else the session title; no minutes, since it is the live region) / "Quiet for 6m. Last activity at 15:02." | Open reviewer (when a review stage is the quiet part) or Open session, Keep waiting |
| Running | blue · dot (pulses on the card only) | anything running | "A reviewer is checking Task 6" / "Desktop remote wiring · 2m 14s so far" / "✓ Nothing needs you" | Stop after this task, Open session |
| Done | green · check | everything finished | "Plan finished in 1h 52m" / "9 decisions to look over" | Review decisions |

"Stop after this task" queues a message to the session ("Stop after the
current task and summarize where you are"); it never kills a turn mid-task.

Directly under the card, one line summarizes the other running sessions,
carrying the worst of their states: "2 other runs · ssh-hardening quiet 6m ›".
It expands to one row per session; Enter switches to it.

Copy is plain and present-tense ("A reviewer is checking", "Code written",
"Small issues saved for the end"); SDD jargon (fix round, ledger, rulings,
brief) appears only where a number needs a unit ("fix 3 of 5").

Accessibility: only the card's headline is a `role="status"` live region, and
it announces state changes only; ticking timers sit outside any live region.

### Sidebar tab

- New `SidebarTabId` value `"tasks"`, label "Tasks". Wire it through
  `appearance.ts` (type, default order, guard), `projectSidebarTab.ts` (guard)
  and `Sidebar.tsx` (`TAB_LABELS`, `COMPACT_TAB_ICONS`, panel mount). Mount the
  panel only while the tab is selected; `Sidebar` gets `activeSession?: Session`.
- Tab badge: **none while merely running** (calm until it matters). Needs you:
  red square "?"; struggling: amber circle "!"; quiet too long: hollow amber
  ring. Shape and color both differ. The tab button's `aria-label` carries the
  state ("Tasks, needs you").
- Tabs are `role="tab"` buttons (fixes the existing div-based strip for all tabs).

### Panel layout (top to bottom)

1. Status card.
2. Plan header: plan title (from the plan file's `# Title`, else the slug,
   full text in a tooltip), a **?** button that opens the symbol legend, an
   **Open as tab** button (24 px target), and one muted line
   "5 of 8 done · 1h 01m so far · about 35m left". The ETA appears only after
   3 tasks are done: mean finished-task duration × remaining tasks, always
   prefixed "about".
3. Task tree (`role="tree"`, roving tabindex on the `treeitem` elements
   themselves: one Tab stop; ↑/↓ move, ←/→ collapse/expand, Enter opens).
   Links such as **Open review** are child tree items, not buttons nested
   inside a row. Rows: glyph, index, title, duration.
   - Only rows with history worth opening get a chevron (a review that found
     issues, a fix round, a decision, a blocked report). Expanded:
     "Review found 3 issues. Fixed in 1 round, then passed." + **Open review**.
   - The running task is expanded and shows its stages as children:
     "Code written 5m", "Review in progress 2m 14s". Models (sonnet/opus) are
     tooltips, not text.
   - Exception tags only: "fix 3 of 5" (red), "blocked" (amber). No "fixed once" tags.
   - After the last task, one muted line: "Then one last review of the whole branch."
     It becomes a real row once the final review starts.
4. "Decisions made for you · 9" (a real button with `aria-expanded`): first 3 shown with their source task
   ("Task 4"), **Show all 9**; collapsed by default once the plan is done.
5. "Small issues saved for the end · 14": collapsed by default; on first expand
   a one-line explainer. "Parked" is merged here with a "parked" tag; nothing
   renders for zero.
6. "Other agents here": subagents in this session that are not part of an SDD
   stage. Todo lists show as a checklist section only when they do not mirror
   the plan's tasks (same count and titles → hidden).

Step checklists from the briefs are shown in the full tab's task detail, not in
the sidebar (they cannot be ticked mid-task and read as stalled).

### Glyphs and durations (one vocabulary)

Color ladder, everywhere: red = stopped and needs you; amber = needs a look
(struggling, quiet, review found issues); blue = running; green = done; hollow
gray ring = not started. Each meaning has exactly one glyph, and every glyph
has an `aria-label` and an entry in the legend:

| Meaning | Glyph |
|---|---|
| Done | green check disc (as in `TaskListPreview`) |
| Not started | hollow gray ring |
| Running | blue dot in a tinted disc; only the status card's dot pulses (at most one moving thing on screen) |
| Needs you | red square "?" |
| Struggling | amber disc "!" |
| Quiet too long | hollow amber ring (used for nothing else) |
| Review found issues (full tab) | filled amber dot plus the count in words |

Durations: seconds only while running ("2m 14s"); minutes once finished
("19m", "1h 52m"); tabular numerals.

### Full tab ("Open as tab")

Virtual editor tab `FilePaneTab.taskBoard = { sessionId }`, following the
`sessionChanges` precedent (factory in `layout.ts`, sanitising in
`workspaceSnapshot.ts`, render branch in `SurfaceTabs`/`FilePane`).

- Header line 1 = the status card sentence ("A reviewer is checking Task 6 ·
  ✓ Nothing needs you"); line 2 muted = plan title · progress · elapsed · ETA;
  **Open plan** button (path in tooltip).
- Table: every task row, including pending ones and the final review
  (never skip rows). Columns: glyph, Task, What happened, Time.
- "What happened" is one phrase for ordinary tasks ("passed first review",
  "passed after 1 fix") and a short chain only for the running task and
  unusual paths (2+ fix rounds, parked, blocked): "written → review: 3 issues →
  fixed in 1 round, passed". Connectors are fixed-size, not time-scaled.
- Each row has an explicit expand control (chevron button) that opens a detail row: commits (opens the commit tab), models,
  plan steps checklist, **Open review** (the review package diff),
  **Open transcript** (scrolls the session to the dispatch).
- Header menu: Stop after this task, Tell me when the plan finishes.
- Below the table: decisions (each with "If wrong: …" and **Change this**, which
  pre-fills the composer with "About your decision on Task 4: …") and small
  issues, each with a one-line explainer.

### Notifications

OS notification (existing notification path) only for exceptions: needs you,
struggling, quiet too long, plan finished. Never for routine task completions.
Per-plan "Tell me when the plan finishes" toggle in the full tab header menu.

### Visual rules

- Existing tokens only (`text-content/…`, `border-stroke`, `bg-selection`,
  `--color-accent`, diff green/red, `--color-skill`-like amber for warnings).
  Restrained product register: no cards except the status card, no side
  stripes, no uppercase eyebrows; sentence-case section titles.
- Type: three sizes, 11.5 (meta), 12.5 (body), 14 (status headline).
- Contrast: faint text ≥ 55% content (≈5:1); glyph borders ≥ 45% (≥3:1).
- Motion: the status card spinner and a 150 ms ease-out on expand; nothing
  else animates. `prefers-reduced-motion` stops the spinner.
- Targets ≥ 24 px; visible 2 px accent focus ring.
- Empty state: "Nothing to track yet" / "When the agent works through a plan
  or hands work to other agents, each task shows up here with its status and
  time." plus the three source bullets.

### Design review history

Scored with impeccable critique (Nielsen heuristics, /40) by a fresh,
independent reviewer each round; prototypes in `prototypes/tasks-panel/`.

| Round | File | Sidebar | Full tab | Main changes |
|---|---|---|---|---|
| 1 | v1.html | 24 (best of A 16 / B 24 / C 19) | 21 | picked B: glance card, subagents nested in stages |
| 2 | v2.html | 25 | 22 | needs-you / quiet / struggling / empty states, AA contrast, no eyebrows |
| 3 | v3.html | 26 | 25 | one spinner, no badge while running, every row in the full tab |
| 4 | index.html | not re-scored | not re-scored | severity ladder, one glyph per meaning, other runs under the card, stop control, legend |

Scores plateaued (+1 per round on the sidebar); round 4 applies the round-3
reviewer's "must change before building" list.

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
