# Tasks panel: every task and step, and a plan overview

Date: 2026-10-09
Status: approved by request ("tree like tasks list, show all tasks including not yet run, tracking state, how many steps, current state, failed where, how many remaining")
Builds on: `2026-10-09-tasks-panel-design.md`, `2026-10-09-tasks-flow-design.md`

## Problem

Measured against the code, not guessed:

1. **Tasks that have not run are missing.** `buildSddSection` sets `total` to the
   highest task number seen in briefs, reports or the ledger. A task whose brief
   has not been extracted yet does not exist on the board, so "6 of 6 done" can
   be shown for a plan with 9 tasks. The plan file (`plan:` line of the ledger)
   lists every task and step and is never read.
2. **Steps are invisible, and when shown they are unknown.** Steps come from
   briefs and are marked done only when the whole task is done. The plan file's
   own checkboxes (`- [ ]` / `- [x]`, ticked by the executing agent) are the only
   step-level evidence on disk and are ignored. The sidebar shows no steps at all.
3. **No overview.** The plan header says "3 of 6 done · 50m so far · about 30m
   left". It does not say how many steps, how many tasks are left, or which tasks
   are in trouble; failures show only as a tag on a row the user has to find.

## Goal

At a glance, for the active plan: how many tasks and steps there are, which one
is current, what is left, and where it failed, with every task listed in plan
order whether or not it has run. Lean: no new panels, no cards, no tiles.

## Principles

PRODUCT.md applies: answer the glance; real state only (unknown stays unknown);
calm until it matters; one vocabulary (same glyphs, colors, durations); plain
words. Interface skills applied while designing: group with space not lines;
controls look like controls and are at least 24 px; one stroke and one status
vocabulary; no `transition: all`; motion only on state change, 150 ms ease-out,
off under `prefers-reduced-motion`; theme-aware tokens only.

## Data

### Plan file (`planFile.ts`, pure)

`parsePlan(text)` returns `{ title?: string; tasks: PlanTask[] }`,
`PlanTask = { n: number; title: string; steps: { text: string; done: boolean }[] }`.

- A task starts at a heading (any level 1 to 6) matching `Task <n>` followed by
  `:`, `.`, `)`, `-` or an em or en dash and a title. Bold-only lines are not
  headings. Duplicate numbers: the first wins.
- A step is a top-level checkbox list item (`- [ ]`, `* [x]`, `1. [ ]`; indent of
  at most 2 spaces) under the current task. `[x]` / `[X]` is done. Markdown
  emphasis is stripped, a leading `Step <k>:` label is stripped, text is capped
  at 200 characters, whitespace collapsed.
- Limits: 200 tasks, 200 steps per task, input capped at 512 KB. Over the limit
  the extra is ignored, never an error.
- Text with no tasks returns `{ tasks: [] }`.

### Loading

`loadSddSnapshot` reads the plan file named by the ledger's `plan:` path
(resolved with the same rules as `planFilePath`: no `..`, no scheme, no `~`,
absolute only inside the plan root) with `readText`, tolerating any failure
(missing file, remote, over limit). The text goes on `SddSnapshot.planText`.
One extra read per poll, none when the ledger has no plan path.

### Board (`sddBoard.ts`)

- `total` = the larger of the plan file's task count and the highest number seen.
  Nodes `1..total` all exist; tasks only in the plan file are `pending`, titled
  from the plan, with their steps.
- Title: brief title, else plan title, else `Task N`.
- Steps: plan file steps when present, else brief steps. A step is `done` when
  its task is done, else when the plan file ticks it, else not done. Never
  inferred from anything else.
- `BoardSection.steps = { done, total }` is set only when a plan file was read
  (counts every task's steps; a done task counts all of its steps as done).
- The `running` rule is unchanged (first non-complete task once the ledger has a
  `Task` line or a report).

### Overview (`overview.ts`, pure)

`planOverview(section)` returns:

```ts
type PlanOverview = {
  tasks: { total: number; done: number; running: number; attention: number; failed: number; blocked: number; pending: number };
  left: number;                       // tasks not done, plus 1 when the final review is not done
  steps?: { done: number; total: number };
  current?: { id: string; label: string };   // "Task 4", the running or attention task
  problems: { id: string; label: string; why: string }[];  // "Task 5" / "fix 3 of 5", "Task 6" / "blocked", "failed"
  segments: { id: string; status: BoardStatus }[];         // one per task, then the final review
};
```

Problems are tasks in `failed`, `blocked`, or `attention` (fix round 3 or more)
status, in plan order; `why` is plain: "fix 3 of 5", "blocked", "failed".

## UI

### Overview block (sidebar and board tab; `PlanOverview.tsx`)

Replaces the progress line. Top to bottom, 8 px between rows, 16 px to the tree:

1. **Counts line** (12.5 px, `text-muted`, tabular): "3 of 6 tasks · 4 left · 14 of 31 steps".
   Steps appear only when known. When all tasks are done: "6 of 6 tasks · 31 steps".
   Elapsed and ETA stay on a second muted line exactly as today ("50m so far · about 30m left").
2. **Segment strip**: one 6 px high rounded segment per task plus the final review,
   2 px gaps, full width, `role="img"` with an `aria-label` that spells the counts
   ("3 done, 1 running, 1 needs a look, 1 blocked, 1 not started"). Colors are
   the status tokens (success, focus, warning, danger) and a muted track for not
   started. It is a summary, never the only carrier: the counts line and the tree
   say the same in words and glyphs.
3. **Problems** (only when there are some): "Needs a look" label (11.5 px, muted)
   then one button per problem, a pill of glyph + "Task 5 · fix 3 of 5" (24 px
   target, `bg-selection-subtle`, focus ring). Activating it expands that task in
   the tree, scrolls it into view and moves focus to its row. At most 3 shown, then
   "+2 more" which expands the rest in place.

No hero number, no cards, no uppercase eyebrow.

### Tree

- Every task is a row in plan order, including tasks that have not started
  (pending glyph, muted title).
- Every task with steps is expandable. Its children are the steps: leaf
  `treeitem`s with a small glyph (done check, or the hollow ring named "not
  ticked") and the step text, wrapping to at most 2 lines. Stage rows of a
  running task come first, then a "Steps 2 of 5" row-less caption, then steps.
- The running or attention task is expanded by default (as today); the user's
  toggle wins. All other tasks start collapsed. The row's right side keeps the
  duration; pending rows show "N steps" as muted text, a started task with steps
  shows "2/5".
- Keyboard unchanged (arrows, Home/End, Enter). Steps are not openable.

### Board tab

Same overview block in the header (replacing the progress line). The table's
detail row already lists steps; it now shows the ticked state from the plan file
and a count heading "Plan steps · 2 of 5". Rows for not-started tasks stay.

### Copy

Plain, sentence case, no jargon: "left", "needs a look", "not ticked", "blocked",
"fix 3 of 5". No em dashes except the existing "—" placeholder for an unknown
time.

## Out of scope

- Tasks before any `.superpowers/sdd/<plan>/` workspace exists (the ledger is
  what links a session to a plan file). Not guessing the newest plan file.
- Ticking steps from the panel (read-only).
- Orchestration and subagent sections (unchanged).

## Tests

- `planFile.test.ts`: headings, levels, dashes, duplicate numbers, checkboxes of
  each style, nesting ignored, emphasis stripped, limits, empty input, CRLF.
- `sddBoard.test.ts`: plan-only tasks appear pending with steps; `total` grows;
  titles fall back; a done task's steps are done; a ticked step in a running
  task counts; steps absent when no plan; brief steps still work.
- `sddWorkspace.test.ts`: plan file read once, unsafe path not read, read
  failure tolerated.
- `overview.test.ts`: every count, `left` with and without final review,
  problems order and wording, segments, no steps without a plan file.
- UI (happy-dom): `PlanOverview.test.ts` (text, `aria-label`, problem buttons,
  "+N more", callback), `TaskTree.test.ts` (step children, default expansion,
  keyboard, pending steps preview, step glyph names), panel and board view tests
  for placement and the problem-to-row jump.
- Integration (`flow.integration.test.ts` style): the real fixture ledger plus a
  plan file shows all tasks, step counts and problems end to end.
- Browser (Chromium + WebKit): the overview block and expanded steps pass the
  same contrast, target and overflow measurements at 240, 340 and 480 px in all
  six theme and palette combinations; the problem button moves focus to its row.
