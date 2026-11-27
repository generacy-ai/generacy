# Tasks: tasks.md safety net must match zero-padded spec dirs

**Input**: Design documents from `/specs/1241-summary-evaluatetasksmd/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Shared resolver (foundational — blocks everything)

- [X] T001 [US3] Create `packages/workflow-engine/src/specs/spec-dir-resolver.ts`:
  pure `matchSpecDir(entries: string[], issueNumber: number): SpecDirMatch` and
  `findSpecDirName(entries, issueNumber): string | undefined`, plus the `SpecDirMatch`
  discriminated union (`{kind:'match';dir}` / `{kind:'none'}` / `{kind:'ambiguous';dirs}`).
  Algorithm: candidates = entries where `^(\d+)-` matches and `Number(digits) === issueNumber`;
  exact = candidates where `digits === String(issueNumber)`; one exact → match, multiple exact →
  ambiguous(exact); no exact → one candidate match / multiple ambiguous(candidates) / zero none.
  `findSpecDirName` returns the dir on `match`, `undefined` on `none`|`ambiguous`.
  (FR-001/002/002a/002b/003/004/006)
- [X] T002 [US3] Create `packages/workflow-engine/src/specs/index.ts` barrel re-exporting
  `matchSpecDir`, `findSpecDirName`, `SpecDirMatch` from `./spec-dir-resolver.js`.
- [X] T003 [US3] Add `export * from './specs/index.js';` to
  `packages/workflow-engine/src/index.ts` (public export → minor).
- [X] T004 [P] [US2] Write `packages/workflow-engine/src/specs/__tests__/spec-dir-resolver.test.ts`:
  padded match (issue 6 ↔ `006-foo`, SC-001), non-padded match (issue 6 ↔ `6-foo`; issue 123 ↔
  `123-foo`, SC-003), exact-precedence (both `6-foo` + `006-bar` → `6-foo`, SC-004),
  cross-boundary non-match (issue 6 vs `60-`, `600-`, SC-002), `006abc-foo` ignored,
  non-numeric entry (`contracts`) ignored, multiple padded → `ambiguous`, empty listing → `none`.
- [X] T005 [US3] Build the package: `pnpm --filter @generacy-ai/workflow-engine build`
  (dependents resolve to `dist/`, so this must land before typechecking/testing orchestrator
  or generacy).

## Phase 2: Safety net fix (orchestrator) — the reported defect

- [X] T006 [US1] In `packages/orchestrator/src/worker/tasks-md-fallback.ts` (`evaluateTasksMd`)
  replace the `entry.startsWith(\`${issueNumber}-\`)` filter + `matches.length > 1` guard with
  `matchSpecDir(entries, issueNumber)`: `none` → `unreadable` "no spec dir for issue N";
  `ambiguous` → `unreadable` "ambiguous spec dirs for issue N: …" (preserve existing reason
  strings). All downstream `countTasks`/classification logic unchanged (FR-005).
- [X] T007 [US1] Extend `packages/orchestrator/src/worker/__tests__/tasks-md-fallback.test.ts`:
  issue 6 + `specs/006-foo/tasks.md` with unchecked tasks → `incomplete` (SC-001); exact
  precedence through `evaluateTasksMd`; ambiguous padded dirs → `unreadable`. Existing cases must
  still pass unchanged (SC-003).

## Phase 3: Sibling call sites converge on the shared resolver (US3)

<!-- Phase boundary: resolver (Phase 1) must be built before these compile -->

- [X] T008 [P] [US3] `packages/orchestrator/src/worker/epic-post-tasks.ts:302` (`resolveFeatureDir`):
  `dirs.find(startsWith)` → `findSpecDirName(dirs, issueNumber)`. Keep the `specs/${issueNumber}`
  fallback; leave the line ~330 branch-name check untouched.
- [X] T009 [P] [US3] `packages/orchestrator/src/worker/clarification-poster.ts` (`findSpecDir`):
  replace the local numeric `find` body with `findSpecDirName` (gains exact-precedence +
  ambiguity→undefined).
- [X] T010 [P] [US3] `packages/workflow-engine/src/actions/github/preflight.ts:298`
  (`checkSpeckitStatus`): `dirs.find(startsWith)` → `findSpecDirName`. Lines 199/344 branch-name
  checks untouched.
- [X] T011 [P] [US3] `packages/workflow-engine/src/actions/github/get-context.ts:123`
  (`findFeatureDir`): `dirs.find(startsWith)` → `findSpecDirName`.
- [X] T012 [P] [US3] `packages/workflow-engine/src/actions/epic/post-tasks-summary.ts:55`:
  `dirs.find(startsWith)` → `findSpecDirName`; existing "No spec directory found" path covers
  none/ambiguous.
- [X] T013 [P] [US3] `packages/generacy/src/cli/commands/cockpit/context.ts:408` (`findSpecDir`):
  keep the branch-named-dir fast path (`specs/<branch>` exists → use it), replace the prefix loop
  with `findSpecDirName(entries, issueNumber)`.

## Phase 4: Verification & release gate

- [X] T014 [US3] Add `.changeset/1241-spec-dir-numeric-resolver.md` (newly added file):
  `@generacy-ai/workflow-engine: minor`, `@generacy-ai/orchestrator: patch`,
  `@generacy-ai/generacy: patch` (FR-008, CLAUDE.md changeset gate).
- [X] T015 [US3] Rebuild `@generacy-ai/workflow-engine`, then typecheck + run the orchestrator
  and generacy test suites (dependents read built `dist/`, so rebuild first).
- [X] T016 [US3] SC-005 grep: ``rg "startsWith(\`\${issueNumber}-\`)" packages/*/src`` returns only
  the branch-name checks (`preflight.ts` 199/344, `epic-post-tasks.ts` ~330) — no remaining
  spec-dir prefix matches.

## Dependencies & Execution Order

**Sequential phases:**
- Phase 1 (resolver + build) → Phase 2 & Phase 3 (all import the new export; won't compile until
  T005 builds `workflow-engine`'s `dist/`).
- T001 → T002 → T003 → T005 (module, barrel, public export, then build). T004 can be written in
  parallel with T001–T003 but is validated after T005.
- Phase 2 (T006 → T007) is the reported defect; T006 must precede its new tests.
- Phase 4 last: T014 changeset anytime after code lands; T015 build+test gate; T016 grep audit.

**Parallel opportunities:**
- T004 [P] alongside T001–T003.
- T008–T013 [P] — six independent files across three packages, each a `find`→`findSpecDirName`
  swap, all unblocked once T005 has built the resolver.

## Next step

`/speckit:implement` to begin execution.
