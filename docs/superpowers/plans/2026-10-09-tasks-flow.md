# Tasks panel audit fixes and flow strip: implementation plan

> For agentic workers: use superpowers:subagent-driven-development. Steps use checkboxes.

**Spec:** `docs/superpowers/specs/2026-10-09-tasks-flow-design.md` (read it first). Product context: `PRODUCT.md`.

## Global constraints

- Node 23 for every npm command: `export PATH=$HOME/.nvm/versions/node/v23.11.1/bin:$PATH`.
- Gates per task: `npx vitest run <the task's test files>` and `npx tsc --noEmit`. Phase gate: `npm run check:web`.
- UI tests are `.test.ts` (not `.tsx`), `// @vitest-environment happy-dom`, `createRoot` + `act`, no testing-library.
- Use the theme-aware tokens: `text-muted`, `text-success`, `text-warning`, `text-danger`, `border-muted`. Never `text-content/NN` for text that carries information.
- Commit messages: imperative sentence, no prefix, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never push, never open a PR.
- Browser specs: `npx playwright test -c preview-ux/pw-tasks.config.ts <name>` (local config using cached Chromium and WebKit; the committed `playwright.config.ts` is what CI uses).

## Task 1: Audit fixes, browser regression spec, token guard (files: `src/features/tasks/ui/*`, `tests/browser/tasks-panel*.{ts,tsx,html}`, `src/app/shell/tokenAdoption.test.ts`)

- [ ] Replace informational `text-content/55|/66|/45` with `text-muted` in every `src/features/tasks/ui/*.tsx`.
- [ ] Replace `text-diff-add` (text) with `text-success`, `text-skill` (text) with `text-warning`, status text in red with `text-danger`.
- [ ] Glyph marks (`TaskGlyph.tsx`, `TasksTabBadge.tsx`, `StatusCard.tsx` primary button): ink flips with the theme. Solid needs-you: `bg-danger text-background-base`. Struggling and tab badge: `bg-warning/22 text-warning` (badge solid: `bg-warning text-background-base`). Failed: `bg-danger/22 text-danger`. Done: `text-success`. Pending and quiet rings: `border-muted` / `border-warning`.
- [ ] `cursor-pointer` on expandable tree rows; replace the per-row `visible.find` in `TaskTree.tsx` with a map built once per render.
- [ ] Add `src/features/tasks` to `ROOTS` in `src/app/shell/tokenAdoption.test.ts` and make it pass.
- [ ] Write `tests/browser/tasks-panel.spec.ts` from `/tmp/audit-reference.spec.ts` (measurement code) as real assertions, per spec Part 3: text AA, glyph border 3:1, mark-on-fill 4.5:1 (skip decorative fills with no mark), controls >= 24 px, no horizontal overflow at 240/340/480 px. Run it in Chromium and WebKit; it must fail before the token changes and pass after (record the before-count of failures in the commit message).
- [ ] Existing vitest tests for tasks stay green (update class-name assertions if any).
- [ ] Commit.

## Task 2: Flow model (files: `src/features/tasks/model/{taskBoard,sddLedger,sddBoard,flow,testRuns}.ts` + tests, `hooks/useTaskBoard.ts` + test)

- [ ] `sddLedger.ts`: parse `Spec: <path>` into `specPath`; carry it to `BoardSection.specPath` in `sddBoard.ts`.
- [ ] `testRuns.ts` + `testRuns.test.ts` per spec.
- [ ] `flow.ts` + `flow.test.ts` per spec (`FlowPhase`, `deriveFlow`).
- [ ] `useTaskBoard.ts`: expose `flow: FlowPhase[]` on `TaskBoard` (empty without a plan); `subagentsRunning` = running nodes in the agents section plus running stage nodes of the plan; add tests.
- [ ] Commit.

## Task 3: FlowStrip UI (after tasks 1 and 2; files: `src/features/tasks/ui/{FlowStrip,TasksPanel,TaskBoardView,TaskBoardSurface}.tsx`, tests)

- [ ] `FlowStrip.tsx` per spec UI section, with `FlowStrip.test.ts`.
- [ ] Place it in the sidebar plan block and the board view header; spec/plan buttons open the file through the existing open-plan path (add an `onOpenFile` prop only if needed).
- [ ] Extend `tests/browser/tasks-panel.tsx` fixture with a flow and make `tasks-panel.spec.ts` cover the strip (contrast, wrap at 240 px).
- [ ] Commit.

## Task 4: Verification

- [ ] `/tmp/full-verify.sh`, browser spec in both engines, independent code review, fix findings.
