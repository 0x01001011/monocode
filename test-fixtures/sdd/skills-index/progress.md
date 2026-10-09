# SDD ledger — plan: docs/superpowers/plans/2026-10-07-skills-index-remote-ranking.md

Spec: docs/superpowers/specs/2026-10-07-skills-index-remote-ranking-design.md
Env: `source /tmp/kcode-env.sh` before cargo/node (Node 23; CC=homebrew clang because /usr/local/include is root 0700 and Apple clang hardcodes -I/usr/local/include).
Baseline: ebb5db1; vitest 4707 pass / 13 skip / 0 fail.

## Pre-flight scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1 -> T2 | bump_revision / skills_revision | consistent; T2 must call T1's fn |
| T2 -> T4 | skills-changed event, onSkillsChanged | T4 touches skills.ts too; sequential so no conflict |
| T3 -> T4 | UsageSnapshot shape | T3 serde camelCase (lastUsedAt) must match T4 TS type |
| T2/T3 share lib.rs | command registration | sequential, no conflict |
| T5 -> T6 | list_skills {skills,revision}|{unchanged} | consistent |
| T5/T6 fixture | expected.json paths | Ruling: expected.json uses fixture-relative paths; each test rewrites root prefix |
| T1..T8 self-consistency | tests vs code vs files | T6 lists remote.rs + docs; T7 only verifies; no contradictions |

## Rulings
Ruling: Rust C compiler = Homebrew llvm@18 via CC env — no sudo/system change — cost if wrong: build only works with that env
Ruling: sequential implementers in this worktree (skill forbids parallel implementers) — cost: slower than the 3-agent split
Ruling: Task 8 pushes the feature branch and opens a PR (user said "ship"); no merge to main — cost if wrong: an extra remote branch
Ruling: kcode install is a build-time --config productName override, identifier unchanged — cost if wrong: shares app data dir with MonoCode.app (see T8 migration-compat check)
Task 1: minor (deferred): memo entries for never-rescanned roots persist for process life (bounded, small)
Task 1: minor (deferred): same-len test relies on fs mtime granularity; could use File::set_modified
Task 1: complete (commits ebb5db1..129e9e2, review clean)
Task 2: implemented (95f86ae); review: spec ❌ (no degradation when unwatched), Important x2 (stale when unwatched; recreated root not re-watched on non-macOS)
Task 2: minor (deferred): no tests for root-created-later/debounce coalescing; dropFileCatalogs deletes vs bumping generation; failed-root retry log spam; skills_watch_project non-atomic count; SkillsPage loading flash on reload; $HOME fallback watch event churn on macOS
Task 2: Ruling: SkillsPage uses loadDiscoveredSkills (cached, unfiltered) instead of loadSkills — page needs disabled skills visible — cost: second cache to keep in sync (invalidateSkills clears both)
Task 2: fix round 1/5 dispatched (resume implementer ab6141aac0b2ae18d); FIX_BASE=95f86ae
Task 2: fix round 1/5 (2 addressed, 0 open; commits 95f86ae..e704fdd)
Task 2: minor (deferred): prune only checks is_dir so delete+recreate within one debounce window is not pruned; register_project count not atomic
Task 2: complete (commits 129e9e2..e704fdd, review clean after 1 fix round)
Task 3: implemented (5d9de02); review: spec ✅, Important x1 (backfill stamps history with now -> defeats 14-day decay)
Task 3: minor (deferred): Skill tool call after typed /name counts twice; bare "Skill" title not counted; statements not cached in backfill
Task 3: Ruling for Task 4 dispatch: Task 4 must await/run skill_usage_backfill before enabling live recording (double-count window, reviewer finding 4) — cost if wrong: small count inflation
Task 3: fix round 1/5 dispatched; FIX_BASE=5d9de02
Task 3: fix round 1/5 (2 addressed, 0 open; commits 5d9de02..8113287)
Task 3: minor (deferred): backfill_skips_sessions_without_a_project test is vacuous (asserts key "/" but old code wrote key "  "); assert on raw skill_usage table instead
Task 3: complete (commits e704fdd..8113287, review clean after 1 fix round)
Task 4: implemented (eab0c9b); review: spec ✅ (deviation: records at send via preparePrompt not at pickSkill — accepted, avoids pick+send double count); Important x1 (record-at-prepare double counts on deferred/failed queued delivery)
Task 4: Ruling: record at send, not pickSkill — brief said pickSkill+applySkillsToTurn but that double counts — cost if wrong: picks never sent are not counted
Task 4: minor (deferred): project key may fragment across worktrees on first send with createDraftWorktree; backfill failure can double count; store never evicts; typed token counts as draft skill; no render test for useSkillUsage; BtwSheet/automations recording unverified; native commands (/compact) may be ranked as skills
Task 4: fix round 1/5 dispatched; FIX_BASE=eab0c9b
Task 4: fix round 1/5 (1 addressed, 0 open; commits eab0c9b..6097340)
Task 4: minor (deferred): main-send record fires at turn completion (sendHarnessTurn resolves at turn end), not acceptance; orchestration retry re-records; App.tsx call sites have no direct unit test
Task 4: complete (commits 8113287..6097340, review clean after 1 fix round)
Task 5: implemented (548a529); review: Critical x1 (symlinked SKILL.md -> arbitrary file read via read_text_file allowance; reproduced by reviewer)
Task 5: Ruling: host-only hardening — scanner skips skills whose realpath isn't a regular SKILL.md/skill.md; read allowance requires the same; Rust scanner unchanged (local machine, no trust boundary) — cost if wrong: host/Rust listings diverge for symlinked non-skill files
Task 5: minor (deferred): Rust vs JS trim() differ on U+0085/U+FEFF; plugin-id sort UTF-16 vs byte order for non-BMP; no test that memo doesn't leak across homes
Task 5: fix round 1/5 dispatched; FIX_BASE=548a529
Task 5: fix round 1/5 (1 addressed, 0 open; commits 548a529..ae43c2d) — controller re-ran 24/24 host tests independently
Task 5: minor (deferred): TOCTOU between isSkillFile and readFile (needs concurrent writer in repo); win32 'Skills' casing in pre-filter; symlink tests POSIX-only; scan amplification via /skills/**/SKILL.md ENOENT paths (bounded by memo); symlink to another file literally named SKILL.md is readable (accepted)
Task 5: complete (commits 6097340..ae43c2d, review clean after 1 fix round)
Task 6: implemented (02244d3); review: spec ✅; Important x1 (remote sessions never record skill usage -> remote ranking never accrues; doc claim false)
Task 6: Ruling: remote picker inserts /name without expanding the SKILL.md body on desktop (spec non-goal "don't change inlining"); correct for a claude host (handles /name natively), a codex host treats it as text — documented in docs/remote-access.md — cost if wrong: picker lists skills that may do nothing on non-claude remote hosts (follow-up: expand via readTextFile)
Task 6: minor (deferred): host ignores disabledPaths so a disabled remote skill hides a lower-priority same-name one; first-load failure caches builtin-only for 30s; scanRemoteSkills not deduped across harness catalogs; pi/omp remote sessions get empty skill cwd
Task 6: fix round 1/5 dispatched; FIX_BASE=02244d3
Task 6: fix round 1/5 (1 addressed, 0 open; commits 02244d3..fd0b3b3)
Task 6: minor (deferred, FOR FINAL FIX WAVE): RemoteSession records build-intent turns (add `&& command.intent !== "build"`, local path skips them); recordSkillsUsedInTurn on remote pi/omp spawns a local probe with remote:// cwd (skip when hasNativeCommands(harness)); usage lost if host accepts send but response lost and pending cleared by snapshot; usage key for auto-created worktree first message uses project cwd
Task 6: complete (commits ae43c2d..fd0b3b3, review clean after 1 fix round)
Task 7: complete — A host HTTP e2e PASS (504 skills, sinceRevision unchanged, new skill bumps revision, symlink attack blocked); B bench PASS (baseline ebb5db1 median 23964us; new cold 26442us (~10% slower first scan); warm 3841-4385us (~5.5-6x faster), warm re-reads 0 files); C watcher PASS (max 321ms vs 1s); gates: vitest 4753/13skip, tsc 0, test:host 124, cargo test 577, fmt 0, clippy 0
Task 7: note: `cargo test --release` doesn't compile (pre-existing macos.rs debug_assertions-only fns) unrelated
FINAL REVIEW (opus, de033ff..fd0b3b3): Ready to ship: with fixes. Critical none. Important: I1 migration 19 collides with origin/main (verified by controller: origin/main d8902e7 has its own `if current < 19`; real DB max version = 18); I2 usage keys live(worktree) vs backfill(project root) disagree; I3 plugin enable/disable + settings edits not watched -> stale picker (regression); I4 remote build turns counted; I5 remote pi/omp probe; I6 vacuous backfill test. Minor folded: M1 false comment, M3 unsorted read_dir.
Final fix wave: ONE dispatch with final-fix-brief.md; base fd0b3b3. After it: scoped re-review, then rebase onto origin/main (resolve conflicts), re-run all gates, THEN build kcode and ship.
Ruling: remove our schema_migrations v19 step; rely on unconditional ensure_skill_usage_tables — cost if wrong: none for correctness (CREATE IF NOT EXISTS), no version bookkeeping for our tables
Ruling: usage keyed by project root everywhere (spec said normalized cwd) — cost if wrong: worktree-specific rankings no longer separate
Final fix wave: complete (fd0b3b3..0487660, scoped re-review clean: 8/8 addressed). minors: BtwSheet reads usage under worktree path; 11 roots/project (cap ~23 projects); is_relevant ancestor rule on dir-level events
