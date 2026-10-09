### Task 4: Ranking with usage (TS)

**Files:** Create `skillUsage.ts`; modify `slashCommands.ts`, `Composer.tsx`, `skills.ts`, `SkillPromptField.tsx`.

**Interfaces:**
- Consumes: Task 3 commands.
- Produces: `type SkillUsage = { counts: Map<string,{count:number,lastUsedAt:number}>; pairs: Map<string,number> }`; `rankSkills(skills, query, limit?, usage?: SkillUsage, draftInvocations?: string[])`; `recordSkillUse(projectKey, invocations)`.

- [ ] **Step 1:** Tests in `skills.test.ts`: no usage → identical output to today; frecent skill outranks alphabetical neighbor on empty query; 14-day half-life; boost capped at 120; co-use boost up to 80 when draft contains the paired `/x`; fuzzy name hit still beats a heavy-use description hit.
- [ ] **Step 2:** Run; fail.
- [ ] **Step 3:** Implement scoring per spec; load snapshot once per project key into a module store with a React subscription; `pickSkill` and `applySkillsToTurn` call `recordSkillUse` with distinct invocations, ignoring failures.
- [ ] **Step 4:** Run `npx vitest run` and `npx tsc --noEmit`; commit.

