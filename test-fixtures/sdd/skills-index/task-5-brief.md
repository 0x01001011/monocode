### Task 5: Host TS scanner and `list_skills`

**Files:** Create `host/skills.ts`, `test-fixtures/skills/**`, `test-fixtures/skills/expected.json`, `host/skills.test.ts`; modify `host/workspace-commands.ts`.

**Interfaces:**
- Produces: `listSkills(args: {cwd: string, home: string, sinceRevision?: number}): {skills: DiscoveredSkill[], revision: number} | {unchanged: true, revision: number}` and the same shape as Rust `DiscoveredSkill`.

- [ ] **Step 1:** Fixture tree covering `.agents`, `.claude`, a duplicate name across roots (priority), folded `description: >`, a missing frontmatter, a disabled-name edge, and a plugin with `installed_plugins.json`. Write `expected.json` by hand from the Rust rules.
- [ ] **Step 2:** `host/skills.test.ts` asserts `listSkills` equals `expected.json`, plus revision/`sinceRevision` behavior and `allowedRoots` permitting a read of a listed skill path.
- [ ] **Step 3:** Port scanner (same roots, priority, 16 KB prefix, frontmatter rules); revision = hash of memo state; register `list_skills` in workspace commands; add read-only skill-root allowlist in `allowedRoots`.
- [ ] **Step 4:** `npm run test:host`; commit.

