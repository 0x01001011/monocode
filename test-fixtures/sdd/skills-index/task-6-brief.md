### Task 6: Desktop remote wiring

**Files:** Modify `remoteCommands.ts` (`HOST_COMMANDS`, result path translation), `remote.rs` (`supported_remote_method`), `skills.ts`, `docs/remote-access.md`.

**Interfaces:** Consumes Task 5 command. Produces: remote cwd catalog via `invokeWorkspace("list_skills", ...)`.

- [ ] **Step 1:** Tests: `list_skills` is in the allowlists; remote cwd no longer collapses to builtin-only; paths in results are rewritten to `remote://<env>/…`; disabled paths keyed per machine; unreachable host keeps last catalog.
- [ ] **Step 2:** Implement; TTL 30 s with `sinceRevision` revalidation.
- [ ] **Step 3:** Rust parity test reading `test-fixtures/skills` against the same `expected.json`.
- [ ] **Step 4:** Full gates; commit.

