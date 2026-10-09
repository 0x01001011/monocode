### Task 1: Rust memoized scan and revision

**Files:** Modify `src-tauri/src/skills.rs`.

**Interfaces:**
- Produces: `pub(crate) fn skills_revision() -> u64`, `pub(crate) fn bump_revision() -> u64`, Tauri command `skills_revision() -> u64`.

- [ ] **Step 1:** Write failing tests in `skills.rs`: `memo_skips_unchanged_file` (second scan reads zero files; expose a `#[cfg(test)]` counter `PARSE_COUNT`), `memo_invalidates_on_content_change_same_len`, `deleted_skill_disappears`.
- [ ] **Step 2:** Run `cargo test --manifest-path src-tauri/Cargo.toml skills::` and see them fail.
- [ ] **Step 3:** Add a `static MEMO: Mutex<HashMap<PathBuf, (SystemTime, u64, (String,String))>>` consulted in `scan_root` before `read_prefix`; key on mtime and len; drop entries whose file vanished. Keep existing behavior otherwise.
- [ ] **Step 4:** Run full `cargo test` for the crate; existing skills tests must stay green.
- [ ] **Step 5:** Commit `perf(skills): memoize parsed SKILL.md by mtime and size`.

