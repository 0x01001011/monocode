### Task 3: Usage store (Rust)

**Files:** Modify `session_store.rs`, `lib.rs`.

**Interfaces:**
- Produces commands: `skill_usage_record(project_key: String, invocations: Vec<String>) -> Result<(), String>`; `skill_usage_snapshot(project_key: String) -> Result<UsageSnapshot, String>` where `UsageSnapshot { usage: Vec<{invocation, count, lastUsedAt}>, pairs: Vec<{a, b, count, lastUsedAt}> }`; `skill_usage_backfill() -> Result<u32, String>`.

- [ ] **Step 1:** Rust tests: `record_counts_once_per_message_and_pairs` (input `["a","b","a"]` gives a:1, b:1, pair a,b:1, no a,a), `snapshot_scoped_by_project_key`, `backfill_reads_typed_slash_tokens_and_skill_tool_blocks_once`.
- [ ] **Step 2:** Run; fail.
- [ ] **Step 3:** New migration step creating `skill_usage` and `skill_pair`; implement commands; backfill guarded by a settings row so it runs once.
- [ ] **Step 4:** `cargo test`, commit.

