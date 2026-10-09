# Tasks Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Tasks tab to the Workspace sidebar, and an "Open as tab" full view, that show the active project's agent work (SDD plan, subagents, todos, orchestration) with status, times and a severity-ranked status card.

**Architecture:** Pure model code in `src/features/tasks/model/` (types, duration format, SDD ledger parser, section builders, status-card derivation) with no React and an injected fs, then thin React UI in `src/features/tasks/ui/` and hooks in `src/features/tasks/hooks/`. The sidebar tab and the full tab (a virtual `FilePaneTab` like `sessionChanges`) both render from the same `BoardSection[]`. No new Rust: files are read through `listDir`, `readTextFile`, `statFiles` in `src/platform/tauri/fs.ts`.

**Tech Stack:** React 19 + TypeScript, Tailwind v4 tokens in `src/styles/index.css`, Vitest (`// @vitest-environment happy-dom` UI tests with `createRoot` + `act`, no testing-library), Hugeicons via `src/shared/ui/icons.tsx`.

**Spec:** `docs/superpowers/specs/2026-10-09-tasks-panel-design.md` (visual reference: `prototypes/tasks-panel/index.html`, final round). Read both. Product context: `PRODUCT.md`.

## Global Constraints

- Node 23 for every npm command: `export PATH=$HOME/.nvm/versions/node/v23.11.1/bin:$PATH` (Node 26 breaks happy-dom localStorage).
- Gates per task: `npx vitest run <the task's test files>` and `npx tsc --noEmit`. Phase-end gate: `npm run check:web` (vitest + tsc).
- Commit messages: imperative sentence, no prefix (repo style), ending with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never push, never open a PR (the controller does that, to the `fork` remote only).
- Tests live next to the file (`foo.ts` + `foo.test.ts`); UI tests are `.test.ts` (not `.tsx`) because vitest includes `src/**/*.test.ts` only.
- Sidebar styling uses existing tokens only: `text-content/…`, `border-stroke`, `bg-selection`, `--color-accent`, `--color-diff-add`/`-del`; amber is `--color-skill` (`#e8c547`). No new CSS variables, no new dependency.
- Type sizes in the panel: 11.5px meta, 12.5px body, 14px status headline. Faint text is `text-content/55` minimum (AA). Targets at least 24px tall. Visible focus ring `outline-2 outline-accent`.
- Color ladder everywhere: red = stopped and needs you; amber = needs a look (struggling, quiet, review found issues); blue (`--color-accent`) = running; green (`--color-diff-add`) = done; hollow gray ring = not started. Each meaning has one glyph; every glyph has an `aria-label`.
- Durations: seconds only while running (`2m 14s`), minutes once finished (`19m`, `1h 52m`), tabular numerals. Finished under 60 s shows `<1m`.
- Copy is plain and present tense: "A reviewer is checking Task 6", "Nothing needs you", "Decisions made for you", "Small issues saved for the end". No em dashes in UI copy.
- Never invent progress: unknown shows as unknown (a step checkbox is "done" only when its task is `done`, otherwise unchecked and labelled by the section, never ticked).
- The panel is read-only except the explicit actions in Task 12.

## Review Focus

Failure modes the spec implies that no feature task states directly (each is pinned by a named test):

1. Ledger with only a header line, or a plan whose `progress.md` is missing: shows an empty Plan section, not an error (Task 4: `loads a workspace with no ledger as all-pending`).
2. A brief with no `- [ ]` steps, or a task with a report but no brief: row still renders with its number as title (Task 3/4: `task without a brief keeps number-only title`).
3. Two SDD workspaces under one project: the most recently modified ledger wins, the other is selectable (Task 4: `orders workspaces by ledger mtime`).
4. Remote project (`remote://` path): files are read through the same fs functions; a read error shows the section as unavailable and never throws into React (Task 8: `section load failure renders nothing and keeps the rest`).
5. Session switch while a poll is in flight: a stale result must not overwrite the new session's board (Task 8: `ignores a stale poll result after the session changes`).
6. Sessions restored from history have no tool timestamps: durations show `—`, the running timer never shows a negative or `NaNm` (Task 1/2 tests).

---

## Phase A: Model foundations

### Task 1: Tool block timestamps

**Files:**
- Modify: `src/features/sessions/model/session.ts` (the `Block` type, around the `tool?:` field)
- Modify: `src/integrations/harness/core/apply.ts` (`upsertTool`, lines ~940-1030)
- Test: `src/integrations/harness/core/apply.test.ts` (existing file; append a `describe("tool timing")`)

**Interfaces:**
- Consumes: `upsertTool(session, patch)` (private) and the `tool.started` / `tool.updated` event cases.
- Produces: two optional fields on `Block`: `toolStartedAt?: number` and `toolEndedAt?: number` (epoch ms).

- [ ] **Step 1: Write failing tests** in `apply.test.ts`: (a) `stamps toolStartedAt when a tool starts` (apply `tool.started`, assert `block.toolStartedAt` is a number within 1 s of `Date.now()` using `vi.useFakeTimers()`/`setSystemTime`); (b) `stamps toolEndedAt once, on the first terminal status` (apply `tool.updated` with `status: "completed"`, advance time, apply another `tool.updated`; `toolEndedAt` equals the first completion time); (c) `does not stamp toolEndedAt for in_progress updates`; (d) `a tool first seen as completed gets both stamps equal`.
- [ ] **Step 2: Run** `npx vitest run src/integrations/harness/core/apply.test.ts -t "tool timing"`. Expected: 4 FAIL.
- [ ] **Step 3: Implement** the two fields on `Block` (doc-comment: "Epoch ms; absent on sessions restored before timing existed") and set them in `upsertTool`: on insert set `toolStartedAt = Date.now()` and, when `patch.status` is terminal, also `toolEndedAt`; on update set `toolEndedAt` only if absent and the new status is terminal. "Terminal" is `completed` or `failed` (match `streaming` logic at the `tool.updated` case). Keep the early-return no-change check intact (stamps must not defeat it).
- [ ] **Step 4: Run** the same command plus `npx vitest run src/integrations/harness src/features/sessions`. Expected: PASS, no regressions.
- [ ] **Step 5: Commit** "Record start and end times on tool blocks".

### Task 2: Duration formatting and board types

**Files:**
- Create: `src/features/tasks/model/duration.ts`, `src/features/tasks/model/duration.test.ts`
- Create: `src/features/tasks/model/taskBoard.ts`

**Interfaces:**
- Produces from `duration.ts`: `formatDuration(ms: number | undefined, running: boolean): string`.
- Produces from `taskBoard.ts` (types only, copied from the spec section "Unified model"):
```ts
export type BoardStatus = "pending" | "running" | "done" | "attention" | "failed" | "blocked" | "cancelled";
export type BoardStage = { kind: "implement" | "review" | "fix" | "final-review" | "final-fix"; label: string; status: BoardStatus; verdict?: string; startedAt?: number; endedAt?: number };
export type BoardStep = { text: string; done: boolean };
export type BoardNode = { id: string; title: string; index?: number; status: BoardStatus; startedAt?: number; endedAt?: number; summary?: string; stages?: BoardStage[]; steps?: BoardStep[]; children?: BoardNode[]; dependsOn?: string[]; commits?: string; models?: string; fixRounds?: number; target?: BoardTarget };
export type BoardTarget = { kind: "report" | "brief" | "review" | "transcript" | "session" | "commit"; ref: string };
export type BoardNote = { taskIndex?: number; text: string };
export type BoardSection = { source: "sdd" | "orchestration" | "agents" | "todos"; id: string; title: string; done: number; total: number; startedAt?: number; nodes: BoardNode[]; decisions?: BoardNote[]; minors?: BoardNote[]; parked?: BoardNote[]; planPath?: string; finalReview?: BoardNode };
```

- [ ] **Step 1: Write failing tests** for `formatDuration` (exact values): running `48_000`→`"48s"`, `134_000`→`"2m 14s"`, `600_000`→`"10m"`, `3_720_000`→`"1h 02m"`; finished `2*60_000`→`"2m"`, `19*60_000+20_000`→`"19m"`, `3_720_000`→`"1h 02m"`, `30_000`→`"<1m"`; `undefined`→`"—"`; negative or `NaN`→`"—"`.
- [ ] **Step 2: Run** `npx vitest run src/features/tasks/model/duration.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `formatDuration` and create `taskBoard.ts` with the types above.
- [ ] **Step 4: Run** the test file and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** "Add task board types and duration formatting".

### Task 3: SDD ledger parser

**Files:**
- Create: `src/features/tasks/model/sddLedger.ts`, `src/features/tasks/model/sddLedger.test.ts`
- Fixture (already in the repo): `test-fixtures/sdd/skills-index/` (a real 8-task ledger: `progress.md`, `plan-path`, `task-N-brief.md`, `task-N-report.md` with a `Status:` line). Read `progress.md` before writing the parser.

**Interfaces:**
- Produces:
```ts
export type LedgerFix = { round: number; state: "dispatched" | "done"; addressed?: number; open?: number; commits?: string };
export type LedgerTask = { n: number; implemented?: { sha: string; verdict: string }; fixes: LedgerFix[]; complete?: { commits?: string; clean: boolean; parked: number }; };
export type LedgerNote = { taskIndex?: number; text: string };
export type ParsedLedger = { planPath?: string; tasks: LedgerTask[]; rulings: LedgerNote[]; minors: LedgerNote[]; parked: LedgerNote[]; final: { review?: string; fixWave?: "dispatched" | "complete" } };
export function parseLedger(text: string): ParsedLedger;
export type BriefInfo = { title?: string; steps: string[] };
export function parseBrief(text: string): BriefInfo;
export function reportStatus(text: string): "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED" | undefined;
```
Grammar (line based; unknown lines are ignored): `# SDD ledger — plan: <path>` sets `planPath`; `Task N: implemented (<sha>); review: <verdict>` sets `implemented`; `Task N: fix round R/5 dispatched…` pushes a `dispatched` fix; `Task N: fix round R/5 (X addressed, Y open — …; commits a..b)` replaces that round with `done` + counts + commits; `Task N: minor (deferred): <text>` → minors; `Task N: parked — <text>` → parked; `Task N: complete (commits a..b, review clean|K parked …)` or `Task N: complete — <text>` → `complete` (`commits` only when present, `clean` true unless the text contains `parked`, `parked` = K or 0); any line containing `Ruling:` (with or without a `Task N:` prefix) → rulings (text after `Ruling:`); `FINAL REVIEW …` → `final.review`; `Final fix wave: complete` / `dispatched` → `final.fixWave`. `parseBrief`: title from the first `### Task N: <title>` heading, steps from `- [ ] **Step k:** text` (or `**Step k: text**`) lines with the bold markers stripped; a brief with no checkbox lines returns `steps: []`.

- [ ] **Step 1: Write failing tests** loading the fixture with `readFileSync`: task 1 is `complete` with commits `ebb5db1..129e9e2` and `clean: true`; task 2 has `implemented.verdict` starting with `spec ❌`, one `done` fix round with `addressed: 2, open: 0` and commits `95f86ae..e704fdd`; task 7 is `complete` with no `commits`; rulings count is 9 or more and includes one without a `Task N:` prefix; minors include a `taskIndex: 1` entry; `final.fixWave === "complete"`; plus unit cases: `parseLedger("")` returns empty arrays; a header-only ledger returns `planPath` and no tasks; unknown lines are ignored; `parseBrief` on task 2's brief returns title `Watcher, event, frontend invalidation` and 5 steps; `parseBrief("no steps here")` returns `{ title: undefined, steps: [] }` (test name `task without a brief keeps number-only title` is covered in Task 4); `reportStatus` reads `task-2-report.md` → `DONE_WITH_CONCERNS`.
- [ ] **Step 2: Run** `npx vitest run src/features/tasks/model/sddLedger.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the parser per the grammar above.
- [ ] **Step 4: Run** the test file and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** "Parse SDD ledgers, briefs and reports".

### Task 4: SDD board section builder and workspace loader

**Files:**
- Create: `src/features/tasks/model/sddBoard.ts`, `src/features/tasks/model/sddBoard.test.ts`
- Create: `src/features/tasks/model/sddWorkspace.ts`, `src/features/tasks/model/sddWorkspace.test.ts`

**Interfaces:**
- Consumes: `parseLedger`, `parseBrief`, `reportStatus` (Task 3); `BoardSection`, `BoardNode`, `BoardStage` (Task 2).
- Produces:
```ts
export type SddSnapshot = { slug: string; dir: string; ledgerText: string; briefs: Record<number, string>; reports: Record<number, string>; mtimes: Record<string, number>; reviews: { name: string; mtimeMs: number }[] };
export function buildSddSection(snapshot: SddSnapshot, now: number): BoardSection;
export type SddFs = { listDir(path: string): Promise<{ name: string; path: string; isDir: boolean }[]>; readText(path: string): Promise<string>; statMtimes(paths: string[]): Promise<{ path: string; mtimeMs: number | null }[]> };
export type SddWorkspaceRef = { dir: string; slug: string; ledgerMtimeMs: number };
export function findSddWorkspaces(fs: SddFs, projectCwd: string): Promise<SddWorkspaceRef[]>;
export function loadSddSnapshot(fs: SddFs, ref: SddWorkspaceRef): Promise<SddSnapshot>;
```
`mtimes` is keyed by file name (`task-2-report.md`); `reviews` are the `review-<a>..<b>.diff` files. Workspaces are `<projectCwd>/.superpowers/sdd/<slug>/` and are found by listing that directory; missing directory returns `[]`.

Section rules (spec "SDD ledger parsing"): section title is the workspace slug with dashes turned to spaces and the date prefix `YYYY-MM-DD-` removed, first letter capitalized; node title = brief title, else `Task N`; `total` = number of briefs (or highest task number seen); `done` = tasks with `complete`. Status: `complete` → `done`; otherwise the first task (in order) that has a brief/report/ledger line and no `complete` is `running`, all later ones `pending`; a `BLOCKED` report → `blocked`; fix round number ≥ 3 on the running task → node `attention` and `fixRounds` set. A `done` node with any fix round gets `summary` `"Review found issues. Fixed in N round(s), then passed."` (when the `implemented.verdict` starts with `spec ❌` or contains `Important`/`Critical`; otherwise `"Passed first review."` when no fixes and `"Passed after N fix(es)."` when fixes exist and there is no verdict text). Stages for a node: `implement` (ends at the report mtime), `review` (verdict from `implemented.verdict`, started at the matching `review-*.diff` mtime when present), then one `fix` stage per round labelled `R1`… . `startedAt` of task n = `endedAt` of task n-1 (task 1: earliest brief mtime from `mtimes`); `endedAt` of a done task = mtime of its last review package at or before the next task's start, falling back to the report mtime; missing mtimes leave times undefined. `steps` come from the brief; `done: true` for every step only when the node is `done`. `decisions` = rulings, `minors`, `parked` from the ledger notes; a `finalReview` node is set when the ledger has `final.review` (status `running` while `final.fixWave !== "complete"`, else `done`), and is otherwise a `pending` node titled `Last review of the whole branch`. `startedAt` of the section = first task's start.

- [ ] **Step 1: Write failing tests** (`sddBoard.test.ts`, building a `SddSnapshot` from the fixture dir with fake mtimes: task-N-brief at 13:59:19, report N at fixed times): `maps the real ledger to 5-of-8 style progress` (truncate the fixture ledger text to the lines through `Task 6: complete` and assert `done === 6`, node 7 `running`, node 8 `pending`); `done task with one fix round says fixed in 1 round` (task 2); `running task past round 3 is attention` (append `Task 7: fix round 3/5 dispatched` and assert `attention`, `fixRounds === 3`); `blocked report marks blocked` (report text `Status: BLOCKED`); `steps are done only when the task is done`; `task without a brief keeps number-only title`; `later tasks stay pending even with a stray brief`; `final review node pending until the ledger names it`; `decisions come from rulings with task index`; `durations come from mtimes and are undefined when missing`.
  `sddWorkspace.test.ts` with a fake `SddFs` over an in-memory tree: `finds nothing when .superpowers/sdd is missing`; `orders workspaces by ledger mtime`; `loads a workspace with no ledger as all-pending` (briefs present, no `progress.md`: `done === 0`, no throw); `reads only briefs, reports, review packages and progress` (assert the fs `readText` was never called with other file names).
- [ ] **Step 2: Run** both test files. Expected: FAIL.
- [ ] **Step 3: Implement** `buildSddSection`, `findSddWorkspaces`, `loadSddSnapshot` per the rules above (`loadSddSnapshot` lists the directory once, reads `progress.md`, briefs and reports, and stats all files in a single `statMtimes` call).
- [ ] **Step 4: Run** both test files and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** "Build the SDD plan board from ledger files".

## Phase B: Other sources and status

### Task 5: Todo, subagent and orchestration sections

**Files:**
- Create: `src/features/tasks/model/sections.ts`, `src/features/tasks/model/sections.test.ts`

**Interfaces:**
- Consumes: `Block` with `taskList` (`TaskListMeta`, status `pending|in_progress|completed|cancelled`), `agentRun` (`AgentRunMeta`), `tool` (status string), `toolStartedAt`/`toolEndedAt` (Task 1); `OrchestrationRun`/`OrchestrationTask`/`OrchestrationDispatch` from `src/features/orchestration/model/orchestrationState.ts`; `isAgentToolName` from `src/integrations/harness/core/preview.ts`; `toolCallState` from `src/features/sessions/model/transcriptActivity.ts`.
- Produces:
```ts
export function buildTodoSection(blocks: readonly Block[]): BoardSection | undefined;
export function buildAgentSection(blocks: readonly Block[], now: number): BoardSection | undefined;
export function buildOrchestrationSection(run: OrchestrationRun | undefined, now: number): BoardSection | undefined;
export function dropMirroredTodos(todos: BoardSection | undefined, plan: BoardSection | undefined): BoardSection | undefined;
```
Rules: todos use the latest `taskList` block only (status map: `completed`→`done`, `in_progress`→`running`, `cancelled`→`cancelled`, else `pending`); agents are blocks with `agentRun` or an agent tool name, `running` when the tool status is not terminal, `failed` when `isFailedStatus`, with `startedAt`/`endedAt` from Task 1 (absent for restored sessions) and `models` from `agentRun.model`; each node `target` is `{ kind: "transcript", ref: block.id }`; orchestration nodes come from `run.tasks` (status map: `queued`→`pending`, `running`/`cancelling`→`running`, `completed`→`done`, `failed`/`interrupted`→`failed`, `blocked`→`blocked`, `cancelled`→`cancelled`), `dependsOn` copied, times from the latest dispatch of that task (`startedAt`, and `updatedAt` as `endedAt` when settled), `target` `{ kind: "session", ref: task.sessionId }`; `dropMirroredTodos` returns `undefined` when the todo titles, after stripping a leading `Task N:` / `N.` prefix and case, equal the plan node titles in order or the todo count equals the plan `total` with at least 80 percent matching titles.

- [ ] **Step 1: Write failing tests**: `todos use the latest list only`; `agent block running then completed gets times`; `restored agent block has no times and does not throw`; `failed agent maps to failed`; `orchestration maps statuses and keeps dependsOn`; `orchestration time comes from the latest dispatch of the task`; `undefined run returns undefined`; `dropMirroredTodos hides a list that mirrors the plan`; `dropMirroredTodos keeps an unrelated list`.
- [ ] **Step 2: Run** `npx vitest run src/features/tasks/model/sections.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the four functions.
- [ ] **Step 4: Run** the test file and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** "Build todo, subagent and orchestration sections".

### Task 6: Status card derivation

**Files:**
- Create: `src/features/tasks/model/statusCard.ts`, `src/features/tasks/model/statusCard.test.ts`

**Interfaces:**
- Consumes: `BoardSection` (Task 2), `formatDuration` (Task 2).
- Produces:
```ts
export type StatusKind = "needs-you" | "struggling" | "quiet" | "running" | "done" | "idle";
export type StatusAction = "answer-in-session" | "remind-later" | "see-issues" | "open-reviewer" | "keep-waiting" | "stop-after-task" | "open-session" | "review-decisions";
export type StatusSessionInput = { id: string; title: string; busy: boolean; needsInput: boolean; question?: string; askedAt?: number; lastActivityAt?: number };
export type StatusCard = { kind: StatusKind; sessionId?: string; headline: string; detail?: string; reassurance?: string; actions: StatusAction[]; since?: number; others?: { count: number; kind: StatusKind; text: string } };
export function deriveStatusCard(input: { sessions: StatusSessionInput[]; activeSessionId?: string; plan?: BoardSection; now: number; quietAfterMs: number }): StatusCard;
export function tabBadge(card: StatusCard): "ask" | "fail" | "quiet" | undefined;
```
Rules (spec "Status card"): priority `needs-you` > `struggling` > `quiet` > `running` > `done` > `idle`, across all sessions; `needs-you` when any session has `needsInput` (headline `"<title> is waiting for your answer"` when it is not the active session, `"This session is waiting for your answer"` for the active one; `detail` = `Task N asks: “question”` only when `question` is given, plus `" · 3m ago"` from `askedAt`); `struggling` when the plan has a node with `fixRounds >= 3` and status `attention` (headline `"Task N is on fix round R of 5"`, detail `"The reviewer has sent it back R times. If round 5 fails, it stops and asks you."`, actions `see-issues`); `quiet` when a session is `busy` and `now - lastActivityAt >= quietAfterMs` (headline `"No activity on <running task or session title> for 6m"` using `formatDuration(…, false)` rounded to whole minutes, actions `open-reviewer`, `keep-waiting`); `running` when any session is busy or a plan node is `running` (headline `"A reviewer is checking Task N"` when the running node's last stage is `review`, else `"The agent is working on Task N"`, else `"The agent is working"`; `detail` = `"<node title> · <running duration> so far"`; `reassurance` `"Nothing needs you"`; actions `stop-after-task`, `open-session`); `done` when the plan has `done === total > 0` and nothing runs (headline `"Plan finished in <duration>"`, detail `"<n> decisions to look over"` when decisions exist, action `review-decisions`); else `idle` with empty headline. `others` summarizes the worst state of the sessions other than the one the card names (`count` = number of other busy or waiting sessions; `text` like `"2 other runs · ssh-hardening quiet 6m"`), omitted when none. `tabBadge`: `needs-you`→`"ask"`, `struggling`→`"fail"`, `quiet`→`"quiet"`, else `undefined`.

- [ ] **Step 1: Write failing tests**: one per kind with the exact headline strings above; `needs-you outranks struggling`; `an alert from another session names that session`; `quiet needs lastActivityAt older than quietAfterMs and ignores a session that is not busy`; `others counts other busy sessions and names the quietest`; `tabBadge maps kinds`; `no sessions and no plan is idle`.
- [ ] **Step 2: Run** `npx vitest run src/features/tasks/model/statusCard.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `deriveStatusCard` and `tabBadge`.
- [ ] **Step 4: Run** the test file and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** "Derive the Tasks status card across sessions".

## Phase C: Sidebar UI

### Task 7: Glyphs, rows and the keyboard tree

**Files:**
- Create: `src/features/tasks/ui/TaskGlyph.tsx`, `src/features/tasks/ui/TaskTree.tsx`, `src/features/tasks/ui/TaskTree.test.ts`
- Reference for look: `prototypes/tasks-panel/index.html`; reference for icon/glyph code: `src/features/sessions/ui/TaskListPreview.tsx`

**Interfaces:**
- Consumes: `BoardNode`, `BoardStatus` (Task 2), `formatDuration` (Task 2).
- Produces:
```ts
export type GlyphKind = "done" | "pending" | "running" | "ask" | "struggling" | "quiet" | "failed" | "blocked" | "cancelled" | "issues";
export function TaskGlyph(props: { kind: GlyphKind; small?: boolean }): JSX.Element; // aria-label per kind: "done", "not started", "running", "needs you", "struggling", "quiet", "failed", "blocked", "cancelled", "review found issues"
export function glyphForStatus(status: BoardStatus): GlyphKind;
export function TaskTree(props: { nodes: BoardNode[]; label: string; now: number; onOpen?: (node: BoardNode) => void; expandedIds?: ReadonlySet<string>; onToggle?: (id: string) => void }): JSX.Element;
```
`TaskTree` renders `ul[role=tree]` with `li[role=treeitem]` rows; ONE Tab stop (roving `tabIndex` 0 on the active treeitem, -1 on the rest, tabindex on the treeitem element itself); `ArrowDown/ArrowUp` move, `ArrowRight` expands, `ArrowLeft` collapses (or moves to parent), `Home/End`, `Enter` calls `onOpen`. Chevron only on nodes with `summary`, `stages`, `children` or `steps` content worth opening. Row: glyph, index, title (truncated, `title` attribute holds the full text), `fixRounds >= 3` renders an amber `fix R of 5` tag, duration right aligned (`formatDuration(endedAt - startedAt, false)`, or `now - startedAt` running; `—` if no `startedAt`). Running rows use a static accent dot glyph (no animation); expanded node shows `summary` text and `children`.

- [ ] **Step 1: Write failing UI tests** (happy-dom pattern in `src/features/sessions/ui/LiveAgentsPreview.test.ts`): `renders one tab stop`; `arrow keys move the roving focus`; `right arrow expands a node with a summary and left collapses it`; `enter calls onOpen with the node`; `glyphs carry aria-labels`; `no chevron on a plain finished task`; `running node shows a live duration and a pending node shows none`; `fix-round tag shows for fixRounds 3`.
- [ ] **Step 2: Run** `npx vitest run src/features/tasks/ui/TaskTree.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `TaskGlyph` (CSS-drawn discs/rings with Tailwind, matching the prototype and `TaskListPreview` vocabulary) and `TaskTree`.
- [ ] **Step 4: Run** the test file and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** "Add task glyphs and a keyboard-navigable task tree".

### Task 8: Data hook, status card and panel

**Files:**
- Create: `src/features/tasks/model/tauriSddFs.ts` (adapter), `src/features/tasks/hooks/useTaskBoard.ts`, `src/features/tasks/hooks/useTaskBoard.test.ts`
- Create: `src/features/tasks/ui/StatusCard.tsx`, `src/features/tasks/ui/TasksPanel.tsx`, `src/features/tasks/ui/TasksPanel.test.ts`

**Interfaces:**
- Consumes: Tasks 2-7; `listDir`, `readTextFile`, `statFiles` from `src/platform/tauri/fs.ts`; `orchestrator.subscribe/snapshot/run(leadId)` from `src/features/orchestration/model/orchestration.ts` via `useSyncExternalStore`; `sessionNeedsInput`, `Session` from `src/features/sessions/model/session.ts`.
- Produces:
```ts
export const tauriSddFs: SddFs;
export type TaskBoard = { sections: BoardSection[]; plan?: BoardSection; statusCard: StatusCard; workspaces: SddWorkspaceRef[]; selectedWorkspace?: string; selectWorkspace(slug: string): void; loading: boolean };
export function useTaskBoard(input: { projectCwd: string; activeSession?: Session; sessions: readonly StatusSessionInput[]; visible: boolean; now?: () => number; fs?: SddFs; pollMs?: { visible: number; hiddenBusy: number } }): TaskBoard;
export function StatusCard(props: { card: StatusCard; onAction?: (action: StatusAction, card: StatusCard) => void }): JSX.Element;
export function TasksPanel(props: { board: TaskBoard; now: number; onAction?: (action: StatusAction, card: StatusCard) => void; onOpenNode?: (node: BoardNode, section: BoardSection) => void; onOpenAsTab?: () => void }): JSX.Element;
```
`useTaskBoard` polls the SDD workspace (list, then load the selected or newest workspace): every `pollMs.visible` (default 3000) while `visible`, every `pollMs.hiddenBusy` (default 15000) while not visible but some session is busy, otherwise never; it also reloads immediately when `activeSession.blocks.length` changes. It builds sections: `plan` (SDD), orchestration (`orchestrator.run(activeSession.id)`), agents, todos (after `dropMirroredTodos`); sections with no nodes are omitted. Every load is wrapped so a thrown fs error yields no plan section and does not reject. A result is discarded when the `projectCwd`/session changed since the load started. `StatusCard` renders the card per the prototype (headline 14px semibold, only the headline in `role="status"` and, for `needs-you`, `role="alert"` on the card; the running dot pulses only here, respecting `prefers-reduced-motion`; actions as buttons that call `onAction`; the `others` line as a row below). `TasksPanel` layout per spec "Panel layout": status card, others line, plan header (title, `?` legend button that toggles an inline legend, **Open as tab** button, one muted line `"5 of 8 done · 1h 01m so far · about 35m left"` with the ETA only when `done >= 3` and `done < total`: mean finished-task duration times remaining, prefixed `about`), `TaskTree` of the plan nodes, a muted line `Then one last review of the whole branch.` while the final review is pending, "Decisions made for you" (real `button` with `aria-expanded`, first 3 notes with `Task N` source, **Show all N**), "Small issues saved for the end" (collapsed, merged with `parked`), then "Other agents here" and any other sections. Empty state (no sections and `idle`): heading `Nothing to track yet`, body `When the agent works through a plan or hands work to other agents, each task shows up here with its status and time.`, and the three bullets from the spec.

- [ ] **Step 1: Write failing tests**: hook (`useTaskBoard.test.ts`, fake `SddFs`, fake timers): `loads the newest workspace and builds a plan section`; `polls every 3s while visible and not at all when idle`; `section load failure renders nothing and keeps the rest`; `ignores a stale poll result after the session changes`; `selectWorkspace switches the plan`. Panel (`TasksPanel.test.ts`): `shows the running headline and Nothing needs you`; `needs-you card is an alert and its action fires onAction("answer-in-session")`; `ETA appears only after three tasks are done`; `decisions show three then Show all`; `empty state copy`; `legend button toggles the legend`.
- [ ] **Step 2: Run** both test files. Expected: FAIL.
- [ ] **Step 3: Implement** the adapter, hook, `StatusCard`, `TasksPanel` (use `TaskTree` from Task 7).
- [ ] **Step 4: Run** both files and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** "Add the Tasks panel with status card and plan tree".

### Task 9: Wire the Tasks tab into the sidebar

**Files:**
- Modify: `src/features/settings/model/appearance.ts` (`SidebarTabId`, `DEFAULT_SIDEBAR_TAB_ORDER`, `isSidebarTabId`; new tab goes after `"changes"`)
- Modify: `src/features/settings/model/projectSidebarTab.ts` (`isProjectSidebarTab` accepts `"tasks"`)
- Modify: `src/app/shell/Sidebar.tsx` (`TAB_LABELS` `tasks: "Tasks"`, `COMPACT_TAB_ICONS` `tasks: CheckCircle` from `src/shared/ui/icons.tsx`, tab button badge, panel mount next to the Changes panel at ~line 2101, new props)
- Modify: `src/app/App.tsx` (pass the new props where `<Sidebar` is rendered, ~line 12482)
- Test: `src/features/settings/model/projectSidebarTab.test.ts` (extend), `src/app/shell/SidebarTasksTab.test.ts` (new; follow `src/app/shell/SidebarRename.test.ts` for mocking `FileTree`, `useGitFileStatuses`, `useProjectDiffStats`)

**Interfaces:**
- Consumes: `useTaskBoard`, `TasksPanel`, `tabBadge` (Tasks 6, 8).
- Produces: new `Sidebar` props `activeSession?: Session`, `onTasksAction?: (action: StatusAction, card: StatusCard) => void`, `onOpenTasksTab?: () => void`, `onOpenTaskNode?: (node: BoardNode, section: BoardSection) => void`. The Tasks tab is selectable like the other tabs and is persisted per project; a saved order lacking `tasks` gets it appended (already how `loadSidebarTabOrder` behaves, assert it).
- The tab button gets a badge from `tabBadge(board.statusCard)` and `aria-label` `"Tasks, needs you"` / `"Tasks, a task is failing review"` / `"Tasks, quiet for a while"` (no badge and plain `"Tasks"` while merely running). Badge shapes: `ask` red rounded square with `?`; `fail` amber disc with `!`; `quiet` hollow amber ring (`aria-hidden`, label carries meaning). The hook is called from `Sidebar` always (so the badge works with the tab closed) with `visible = tab === "tasks"`.
- `busySessionIds` and `approvalSessionIds` already exist on `Sidebar`; build `StatusSessionInput[]` from `sessions` + those sets (title from `SessionSummary.title`; `question` and `askedAt` only for `activeSession`; `lastActivityAt` = max of `updatedAt` from the summary and the active session's latest `toolEndedAt`/`toolStartedAt`).

- [ ] **Step 1: Write failing tests**: `projectSidebarTab accepts and restores "tasks"`; `loadSidebarTabOrder appends tasks to an old saved order`; `Sidebar renders a Tasks tab and shows the panel when selected` (mock `useTaskBoard` to return a fixed board); `Tasks tab has no badge while only running`; `needs-you board gives the tab an ask badge and an accessible name`.
- [ ] **Step 2: Run** `npx vitest run src/features/settings src/app/shell/SidebarTasksTab.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the wiring. Do not change behavior of existing tabs.
- [ ] **Step 4: Run** `npx vitest run src/app src/features/settings src/features/tasks` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** "Add a Tasks tab to the Workspace sidebar".

## Phase D: Full tab

### Task 10: Task board tab model and persistence

**Files:**
- Modify: `src/features/workspace/model/layout.ts` (`FilePaneTab.taskBoard?: TaskBoardSource`, `TaskBoardSource = { sessionId: string }`, `newTaskBoardTab`, `isTaskBoardTab`, `openTaskBoardTab`, `editorTabKey`, `isPreviewableTab`, and the other places `sessionChanges` is enumerated: lines ~433-445, 500-521, 789)
- Modify: `src/features/workspace/model/workspaceSnapshot.ts` (`sanitizeFile`: sanitize `taskBoard` like `sessionChanges`; reject combinations with plan/commit/releaseNotes/review/terminal)
- Modify: `src/features/sessions/model/sessionWorkspaceLifecycle.ts` (close a session's task board tab when the session closes, mirroring lines 117-132)
- Test: `src/features/workspace/model/layout.test.ts`, `workspaceSnapshot.test.ts`, `src/features/sessions/model/sessionWorkspaceLifecycle.test.ts` (extend each)

**Interfaces:**
- Produces: `newTaskBoardTab(cwd: string, sessionId: string, projectCwd?: string): FilePaneTab` (`path` = `cwd`, `taskBoard: { sessionId }`, NOT `review`); `isTaskBoardTab(file): file is FilePaneTab & { taskBoard: TaskBoardSource }`; `openTaskBoardTab(tab: WorkspaceTab, cwd: string, sessionId: string, projectCwd?: string, pin?: boolean): WorkspaceTab` (re-focuses an existing board tab instead of duplicating); `editorTabKey` returns `` `task-board:${file.cwd}:${file.taskBoard.sessionId}` ``.

- [ ] **Step 1: Write failing tests**: `openTaskBoardTab opens once and refocuses`; `editorTabKey for a task board`; `task board tabs round-trip the snapshot`; `a snapshot with taskBoard and terminal is dropped`; `closing a session closes its task board tab`.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement** by mirroring every `sessionChanges` touch point listed above.
- [ ] **Step 4: Run** `npx vitest run src/features/workspace src/features/sessions` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** "Add a task board editor tab kind".

### Task 11: Task board view and Open as tab

**Files:**
- Create: `src/features/tasks/ui/TaskBoardView.tsx`, `src/features/tasks/ui/TaskBoardView.test.ts`
- Modify: `src/features/files/ui/FilePane.tsx` (render branch like `sessionReview`, and exclude task board tabs from the generic file loop at ~line 168), `src/features/workspace/ui/SurfaceTabs.tsx` (tab label `Tasks`, `iconName` an existing icon name used for checklists or `"CHANGES"` fallback, tooltip `"Task progress for this session"`)
- Modify: `src/app/App.tsx` (handler passed to `Sidebar.onOpenTasksTab` calls `openTaskBoardTab` with the active tab, session cwd/id; pass `Session` and callbacks into `FilePane` as needed, mirroring how `SessionChangesDiff` gets its props)

**Interfaces:**
- Consumes: `useTaskBoard`, `deriveStatusCard`, `BoardSection` (Tasks 2-8), `isTaskBoardTab` (Task 10).
- Produces: `TaskBoardView(props: { projectCwd: string; session?: Session; sessions: readonly StatusSessionInput[]; onAction?: (action: StatusAction, card: StatusCard) => void; onOpenNode?: (node: BoardNode, section: BoardSection) => void; onOpenPlan?: (path: string) => void; onChangeDecision?: (note: BoardNote) => void })`.
Per spec "Full tab": header line 1 = status headline plus `✓ Nothing needs you` when `reassurance` is set; line 2 muted = plan title, `5 of 8 done`, elapsed, ETA; **Open plan** button (path in `title`; calls the new optional prop `onOpenPlan(path: string)` with `section.planPath`); table of EVERY plan node plus the final review row (never skip rows), columns glyph / Task / What happened / Time; "What happened" is one phrase for ordinary tasks (`node.summary` text: `Passed first review`, `Passed after 1 fix`) and a chain (`written → review: 3 issues → fixed in 1 round, passed`, built from `node.stages`) only for the running node and for nodes with 2 or more fix rounds, parked notes or `blocked`; each row has an explicit chevron `button` (`aria-expanded`) opening a detail row with commits (a button calling `onOpenNode` with `{ kind: "commit" }`), models, plan steps checklist, **Open review**, **Open transcript**; below the table: decisions with `If wrong: …` and a **Change this** button each (calls `onChangeDecision(note)`), then small issues, each with the one-line explainers from the spec.

- [ ] **Step 1: Write failing tests**: `renders every task including pending and the final review row`; `ordinary tasks show one phrase and the running task shows a chain`; `row chevron toggles the detail row with aria-expanded`; `header shows Nothing needs you when running`; `Change this calls the handler with the decision`; `Open as tab from the sidebar opens a task board tab` (App-level logic extracted into a small pure helper `openTasksBoard(tabs, activeTabId, session)` in `layout.ts` or `tabGroups.ts` if App wiring is untestable; test the helper).
- [ ] **Step 2: Run** `npx vitest run src/features/tasks src/features/files src/features/workspace`. Expected: FAIL.
- [ ] **Step 3: Implement** the view and the three wiring edits.
- [ ] **Step 4: Run** the same command and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** "Add the full Tasks view as an editor tab".

## Phase E: Actions and notifications

### Task 12: Actions and exception notifications

**Files:**
- Create: `src/features/tasks/model/taskActions.ts`, `src/features/tasks/model/taskActions.test.ts`
- Create: `src/features/tasks/model/taskAlerts.ts`, `src/features/tasks/model/taskAlerts.test.ts`
- Modify: `src/app/App.tsx` (handler wiring: `onTasksAction`, `onOpenTaskNode`, `onChangeDecision`), `src/features/settings/model/appearance.ts` or the existing settings module pattern for one setting: `quietAfterMinutes` (default 5, read by `useTaskBoard` callers; add a numeric setting following how other numeric settings are stored there)
- Reference: `src/features/notifications/` (`notifications.ts`, `useInputNotifications.ts`), which already notifies for needs-input.

**Interfaces:**
- Produces:
```ts
export type TaskActionEffect =
  | { kind: "select-session"; sessionId: string }
  | { kind: "queue-message"; sessionId: string; text: string }
  | { kind: "prefill-composer"; sessionId: string; text: string }
  | { kind: "snooze"; sessionId: string; ms: number }
  | { kind: "open-file"; path: string }
  | { kind: "open-commit"; range: string }
  | { kind: "scroll-transcript"; sessionId: string; blockId: string }
  | { kind: "none" };
export function effectForAction(action: StatusAction, card: StatusCard, ctx: { activeSessionId?: string }): TaskActionEffect;
export function effectForNode(node: BoardNode, section: BoardSection, ctx: { projectCwd: string; sddDir?: string; sessionId?: string }): TaskActionEffect;
export function changeDecisionText(note: BoardNote): string; // "About your decision on Task 4: <text>"
export const STOP_AFTER_TASK_TEXT = "Stop after the current task and summarize where you are.";
export type TaskAlert = { kind: "struggling" | "quiet" | "plan-done"; key: string; title: string; body: string };
export function taskAlertsBetween(prev: StatusCard | undefined, next: StatusCard): TaskAlert[];
```
`effectForAction`: `answer-in-session`/`open-session`/`open-reviewer` → `select-session` of `card.sessionId` (fallback active); `stop-after-task` → `queue-message` with `STOP_AFTER_TASK_TEXT` (never an interrupt); `remind-later` → `snooze` 10 minutes; `keep-waiting` → `snooze` 10 minutes; `see-issues`, `review-decisions` → `none` (the UI scrolls/expands locally). `effectForNode`: kind `report`/`brief`/`review` → `open-file` with `<sddDir>/task-N-report.md` etc.; `transcript` → `scroll-transcript`; `session` → `select-session`; `commit` → `open-commit`. `taskAlertsBetween` returns an alert only on a transition into `struggling`, `quiet` or a `done` plan card (key stable per kind+sessionId so the same state does not re-alert); `needs-you` is NOT produced here (existing input notifications already cover it).

- [ ] **Step 1: Write failing tests** for every mapping above, `changeDecisionText("Task 4", "Record usage at send")`, and for alerts: `alerts once on entering struggling`, `does not alert twice for the same state`, `plan done alerts once`, `needs-you produces no alert here`, `running to running produces none`.
- [ ] **Step 2: Run** both test files. Expected: FAIL.
- [ ] **Step 3: Implement** both modules; wire `App.tsx` handlers: `select-session` uses the existing session selection function used by `onSelectSession`; `queue-message` uses the existing queued/send path for a busy session (find it where messages are queued while a turn runs); `prefill-composer` writes the composer draft through the existing draft API; `open-file`/`open-commit` use the existing open-file and commit-tab helpers; alerts are delivered through the existing notifications module when it can take a new notification kind without refactoring it. If it cannot, deliver none, keep `taskAlertsBetween` tested and unwired, and record a `Ruling:` in the report saying so.
- [ ] **Step 4: Run** `npx vitest run src/features/tasks src/features/notifications src/app` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** "Wire Tasks actions and exception alerts".

## Phase F: Ship

### Task 13: Verify, build and install

Controller task, not delegated (no code changes expected; fixes go to a subagent).

- [ ] **Step 1:** `npm run check:web` (vitest + tsc). Expected: all pass.
- [ ] **Step 2:** `npm run test:host`. Expected: pass (no host changes).
- [ ] **Step 3:** Build `npx tauri build --bundles app --config '{"productName":"kcode","bundle":{"createUpdaterArtifacts":false}}'` with the env from the build notes (`SDKROOT`, `CC`, `CXX` Homebrew clang), then `ditto target/release/bundle/macos/kcode.app /Applications/kcode.app`.
- [ ] **Step 4:** Browser check of the real UI states via the app's dev build if available, otherwise report that the UI was verified by tests and the prototype only.

### Task 14: Final review and PR

- [ ] **Step 1:** Whole-branch review on the most capable model over `git merge-base fork/main HEAD..HEAD` with the ledger's minors and rulings; one fix dispatch for findings; one scoped re-review.
- [ ] **Step 2:** Push `mc/tasks-panel` to `fork` and open a PR inside the fork only (`gh pr create --repo 0x01001011/monocode --base main --head mc/tasks-panel`) after the user names the target; never against `hardbeat920/monocode`.
