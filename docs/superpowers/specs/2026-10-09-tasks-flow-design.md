# Tasks panel: audit fixes and the superpowers flow strip

Date: 2026-10-09
Status: approved by request ("/impeccable audit, and enhance flow panel for superpower, with sub, spec, test")
Builds on: `2026-10-09-tasks-panel-design.md` (the panel itself)

## Part 1: Audit

`/impeccable audit` of `src/features/tasks/ui/*`. Evidence is measured, not guessed:
`tests/browser/tasks-panel.{html,tsx}` renders the real `TasksPanel` (340 px sidebar
width) in Chromium; a script composites every text node and glyph over its real
background and computes WCAG contrast for 6 theme and palette combinations
(dark, light) x (default, colorblind, high-contrast) x 5 status-card states.
Tap-target heights were measured the same way.

### Audit health score: 15 / 20 (Good)

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 3 | Tree, live region, focus and labels are right; contrast fails in the light theme |
| 2 | Performance | 3 | 3 s poll is guarded and stable-keyed; `TaskTree` does an O(n) `find` per row per render |
| 3 | Responsive | 3 | Fluid sidebar column, wraps and truncates; only 340 px was measured |
| 4 | Theming | 2 | Hard-coded ink ratios and raw diff tokens instead of the theme-aware status tokens |
| 5 | Anti-patterns | 4 | No side stripes, gradients, eyebrows, nested cards or ghost cards |
| | **Total** | **15** | |

### Anti-patterns verdict: pass

The panel does not read as AI output: one card, sentence-case titles, one moving
element, one glyph per meaning. The detector (`detect.mjs`) reports nothing.

### Findings

Dark theme passes every text check. All failures are in the light theme or in
the colorblind / high-contrast palettes, which is why four design reviews missed
them (the prototypes were dark only).

**[P1] Informational text uses `text-content/55` and `/66` instead of `text-muted`.**
Light theme: 3.1 to 3.3:1 for the task index numbers, "Step 7 title" (pending),
"Then one last review...", "parked", "Task 2" tags, the explainer lines and the
table header; 4.2 to 4.45:1 for durations, the progress line, "Open as tab", the
legend and the card detail. The design system says to use `text-muted` (theme
aware: 5.3:1 in light) and `tokenAdoption.test.ts` bans `text-content/35..55` in
other feature roots, but `src/features/tasks` is not one of its roots, which is
how it drifted.
Standard: WCAG 1.4.3. Fix: `/impeccable polish` (tokens) plus extend the guard.

**[P1] Status text and marks use raw `diff-*` / `skill` colors.**
"Nothing needs you" (`text-diff-add`) is 2.15:1 in light and 4.45:1 in dark
colorblind. "fix 3 of 5" and "blocked" (`text-skill`) are 3.1 to 3.6:1 in light.
Fix: `text-success`, `text-warning`, `text-danger` (the repo's status tokens,
measured per theme).

**[P1] Glyph marks fail on their own fill.**
Struggling "!" on amber is 2.5:1 in light. Needs-you "?" (`text-black/80` on
`diff-del`) is 3.6:1 in light colorblind and 2.6:1 in light high-contrast; failed
"×" is 3.9:1. Fix: marks take the status token as ink on a tint, or
`text-background-base` on a solid status fill, so the pair flips with the theme.

**[P2] Pending glyph ring is 2.5:1 in light** (needs 3:1 for a non-text
control). Fix: `border-muted`.

**[P2] No regression guard.** Nothing renders the panel in the light theme.
Fix: a browser spec asserting AA across themes (Part 3) and adding
`src/features/tasks` to the token-adoption roots.

**[P3] Tree rows toggle on click but show no pointer cursor**, and
`renderRows` calls `visible.find` per row (quadratic in rows). Fix: `cursor-pointer`
on expandable rows; build an id-to-entry map once per render.

**[P2] The panel starts at the plan.** A superpowers run is a flow: spec, plan,
subagent build, checks. The panel shows only the build, so "where are we?" and
"did the tests pass?" still need the transcript. This is Part 2.

Measured and fine: every button, select and tree row is at least 24 px tall;
`animate-pulse` is behind `motion-safe`; the status headline is the only live
region; only one element moves.

Not measured: widths other than 340 px, a real remote project, WebKit. Part 3
adds 240 px and 480 px widths to the browser spec.

## Part 2: The flow strip

### Goal

One line under the plan title that shows where the superpowers flow stands:

`Spec ✓  ›  Plan ✓ 6 tasks  ›  Build ● 3 of 6  ›  Check ○`

It answers the glance question for the three things the panel never covered:
the spec, the subagents doing the build, and the tests.

### Principles (from PRODUCT.md)

- Show real state only. A phase appears only with evidence; there is no
  "Spec: unknown". With no spec line in the ledger there is no Spec phase.
- One vocabulary. Phases reuse `TaskGlyph` kinds (done, running, pending,
  struggling, failed) and the same duration and wording rules.
- Calm until it matters. The strip is plain text and small glyphs; only a
  failed check or a struggling build changes color.

### Model (`src/features/tasks/model/flow.ts`, pure, no React)

```ts
type FlowPhaseId = "spec" | "plan" | "build" | "check";
type FlowPhase = {
  id: FlowPhaseId;
  label: string;            // "Spec", "Plan", "Build", "Check"
  status: BoardStatus;      // reuses the board vocabulary
  detail?: string;          // "6 tasks", "3 of 6", "2 subagents working", "tests passed 4m ago"
  path?: string;            // spec or plan file (relative to the plan root), opens in the editor
};
deriveFlow(input: { plan: BoardSection; blocks?: readonly Block[]; subagentsRunning: number; now: number }): FlowPhase[]
```

| Phase | Evidence | Status | Detail |
|---|---|---|---|
| Spec | ledger line `Spec: <path>` (first path-like token) | done | "Open" target `path` |
| Plan | `plan.planPath` | done | "<total> tasks" |
| Build | plan nodes | pending when no task started, running while any is running, attention while a task is in fix round 3 or more, done when `done >= total` | "3 of 6", plus "2 subagents working" while Build is running or needs attention |
| Check | last test run and the final review | see below | "tests passed 4m ago", "final review running" |

Check status: `failed` when the latest test run failed; `running` while a test
run is in flight or the final review runs; `attention` when the final review
ended with findings; `done` when the final review is done (the review alone is
evidence when no test run was found); otherwise `pending` (nothing has run yet,
which is a fact). A test run whose command is piped (`npx vitest run | tail`) has
an unknown outcome, because the harness reports the last stage's exit code: it
reads "tests ran 4m ago" and never decides the status. Denied and cancelled calls
never ran and are skipped.

### Test runs (`src/features/tasks/model/testRuns.ts`)

`lastTestRun(blocks)` scans the session's tool blocks (newest first) for shell
tool calls whose command matches a known runner (`vitest`, `npm test`,
`npm run test`, `npm run check`, `cargo test`, `pytest`, `jest`, `go test`,
`playwright test`) and returns `{ status: "running" | "passed" | "failed", at, command }`.
`status` comes from `toolCallState` (the same source the rest of the panel
uses); `at` is `toolEndedAt ?? toolStartedAt`. No exit-code parsing: the
harness already says whether the call failed. No match returns `undefined`,
and the Check detail then shows only the final review.

### Ledger (`sddLedger.ts`)

Add `specPath?: string`, read from the first `Spec:` line. Tolerant: a line
without a path-like token is ignored. `BoardSection.specPath` carries it.

### UI

- `FlowStrip.tsx`: an `ol` labelled "Superpowers flow". Each phase is a `li`
  with a small `TaskGlyph`, the label, and the detail. The first phase that is
  running, attention or failed (else the first pending) has `aria-current="step"`.
  Spec and Plan are `button`s (24 px target, `FOCUS` ring) that open the file
  through the same path as "Open plan"; Build and Check are plain text.
- Sidebar: under the progress line, above the tree. Wraps onto a second line at
  narrow widths; never scrolls horizontally.
- Full tab: in the header, under the plan title and progress line.
- Separator "›" is `aria-hidden`; the list order carries the meaning.
- Copy: phase names as above; details are present tense and plain
  ("tests failed 2m ago", "final review running"). No jargon beyond what the
  panel already uses.

### Out of scope

- Brainstorming and "finishing a branch" phases (no durable evidence on disk).
- Parsing test counts from output (the harness reports pass or fail only).
- Starting a run or re-running tests from the strip (the panel is read-only).

## Part 3: Tests

- Pure model: `flow.test.ts` (each phase and status, no evidence means no
  phase, subagent count, check precedence), `testRuns.test.ts` (runner
  matching, newest wins, running, failed, no match, non-shell tools ignored),
  `sddLedger.test.ts` (Spec line, missing, malformed).
- UI (happy-dom): `FlowStrip.test.ts` (order, `aria-current`, buttons only for
  Spec and Plan, open callback, no strip when no phases), panel and board-view
  tests for placement.
- Browser (Chromium + WebKit, `tests/browser/tasks-panel.spec.ts`): for every
  theme x palette x state, every text node is at least 4.5:1 (3:1 for 18 px+ or
  bold 14 px+), glyph borders at least 3:1, glyph marks on their fill at least
  4.5:1, every control at least 24 px; no horizontal overflow at 240, 340 and
  480 px; the flow strip wraps instead of overflowing.
- Guard: `tokenAdoption.test.ts` roots include `src/features/tasks`.
