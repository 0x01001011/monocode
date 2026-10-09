# SDD ledger — plan: docs/superpowers/plans/2026-10-09-tasks-panel.md

Spec: docs/superpowers/specs/2026-10-09-tasks-panel-design.md (+ prototypes/tasks-panel/index.html, PRODUCT.md)
Branch: mc/tasks-panel (worktree mc-9fa24e37). Base before Task 1: 00de4cb.

## Rulings
Ruling: T11 uses `openTaskBoardTab` directly from App (no extra `openTasksBoard` helper) unless App wiring proves untestable — cost if wrong: one thin untested handler in App.tsx
Task 1: implemented (2b33c9d); review pending. Concern: applyBatch.test.ts strips new stamps (unlisted file)
Task 1: minor (deferred): applyBatch.test.ts now strips the two stamps so batch-vs-sequential equivalence no longer covers them
Task 1: complete (commits 00de4cb..2b33c9d, review clean)
Task 2: implemented (cbe0ed2); review: spec ✅
Task 2: parked — no boundary tests for 59_999 and 60_000 — Ruling: the final review decides whether they are worth adding
Task 2: Ruling: the "—" placeholder for unknown durations is exempt from the no-em-dash copy rule — cost if wrong: swap one character
Task 2: complete (commits 2b33c9d..cbe0ed2, review 1 parked)
Task 3: implemented (423e98a)
Task 3: complete (commits cbe0ed2..423e98a)
Task 4: implemented (f64a336); review pending. Concerns: no-ledger workspace shows task 1 running; extra BoardNode.target
Task 4: review: spec ❌ (DONE_WITH_CONCERNS vs spec), Important x2 (end-time window can attach whole-branch/other-task package to last task; missing mtimes can give endedAt < startedAt)
Task 4: Ruling: DONE_WITH_CONCERNS is NOT mapped to `attention` — cost if wrong: amber is not shown for a concerned implementer report
Task 4: fix round 1/5 dispatched (resume implementer a918943ebbd45a723); FIX_BASE=f64a336
Task 4: fix round 1/5 (3 addressed, 1 open + 1 regression — status rule stricter than amended spec (task 7 right after task 6 stays pending); first task's own review packages dropped by whole-branch filter; commits f64a336..bd63c32)
Task 4: fix round 2/5 dispatched (resume implementer a918943ebbd45a723); FIX_BASE=bd63c32
Task 4: fix round 2/5 (2 addressed, 0 open; commits bd63c32..7c2c240)
Task 4: complete (commits 423e98a..7c2c240, review clean after 2 fix rounds)
Task 5: implemented (f7ded6c); review pending
Task 5: fix round 1/5 dispatched (resume implementer a21a04c553887977a); FIX_BASE=f7ded6c
Task 5: fix round 1/5 implemented (4220ff1, completed by a fresh agent after the original died twice); re-review pending
FINAL REVIEW (opus, 64121a5..d3250cc): Ready with fixes. Critical C1: plan read from project root
Final fix wave: dispatched; base d3250cc
