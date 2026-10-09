# Tasks overview: implementation plan

> For agentic workers: use superpowers:subagent-driven-development. Steps use checkboxes.

**Spec:** `docs/superpowers/specs/2026-10-09-tasks-overview-design.md` (read it first). Product context: `PRODUCT.md`.

## Global constraints

- Node 23: `export PATH=$HOME/.nvm/versions/node/v23.11.1/bin:$PATH`.
- Gates per task: `npx vitest run <files>` and `npx tsc --noEmit`; phase gate `npm run check:web`.
- UI tests are `.test.ts`, `// @vitest-environment happy-dom`, `createRoot` + `act`, no testing-library.
- Theme-aware tokens only (`text-muted`, `text-success`, `text-warning`, `text-danger`, `text-focus`, `border-muted`, `bg-selection-subtle`). The token-adoption test guards `src/features/tasks`.
- No `transition: all`; motion only on state change, 150 ms ease-out, behind `motion-safe`.
- Commits: explicit paths, imperative message no prefix, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never push, never open a PR here.
- Browser specs: `npx playwright test -c preview-ux/pw-tasks.config.ts <name>`.

## Task A: model (planFile, load, board, overview)

- [ ] `model/planFile.ts` + tests per spec Data/Plan file.
- [ ] `sddWorkspace.ts`: read the plan file safely into `SddSnapshot.planText`; tests.
- [ ] `sddBoard.ts` + `taskBoard.ts`: all tasks incl. plan-only, titles, steps, `BoardSection.steps`; tests.
- [ ] `model/overview.ts` + tests.
- [ ] `useTaskBoard.ts`: nothing new unless needed; confirm the section carries the new fields end to end; test.

## Task B: UI (after A and the board-measurement agent)

- [ ] `ui/PlanOverview.tsx` + tests; replace the progress line in `TasksPanel` and `TaskBoardView`.
- [ ] `ui/TaskTree.tsx`: steps as children, default expansion, step glyphs, pending "N steps"/"2/5" meta, focus request prop; tests.
- [ ] Problem buttons reveal and focus the row (sidebar and board tab); tests.

## Task C: browser, integration, evidence

- [ ] Extend the fixtures and specs (overview, steps, 240/340/480 px, six themes).
- [ ] Extend `flow.integration.test.ts` with a plan file.
- [ ] Screenshots and measurements for the PR.
