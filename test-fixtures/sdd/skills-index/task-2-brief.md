### Task 2: Watcher, event, frontend invalidation

**Files:** Create `src-tauri/src/skills_watch.rs`; modify `Cargo.toml` (add `notify`), `lib.rs`, `skills.ts`, `useComposerSkills.ts`, `SkillsPage.tsx`.

**Interfaces:**
- Consumes: Task 1 `bump_revision`.
- Produces: Tauri event `skills-changed` with payload `{ revision: number }`; TS `onSkillsChanged(cb): Promise<() => void>` exported from `skills.ts`.

- [ ] **Step 1:** Rust test `watcher_bumps_revision_on_new_skill` using a temp dir root and a short debounce override.
- [ ] **Step 2:** Run it; see failure.
- [ ] **Step 3:** Implement `pub fn start(app: AppHandle, roots: Vec<PathBuf>)` with `notify::recommended_watcher`, 300 ms debounce, ignore errors, emit `skills-changed`. Start it from `lib.rs` setup over the user-level roots and the open project roots when known.
- [ ] **Step 4:** TS: `loadSkills` clears the catalog cache on the event; picker open no longer passes `{refresh:true}` for file harnesses; `SkillsPage` uses `loadSkills`. Add vitest `skills-changed invalidates cache` and `picker open does not rescan`.
- [ ] **Step 5:** Run `npx vitest run src/features/skills src/features/sessions` and cargo tests; commit.

