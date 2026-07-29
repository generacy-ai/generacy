# Tasks: PR-feedback handler mislabels a successful CLI self-commit cycle as no-diff

**Input**: Design documents from `/specs/1073-problem-when-pr-feedback/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/pr-feedback-disposition.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Label vocabulary (US4)

- [ ] T001 [US4] Add `blocked:resolve-failed` entry to the `WORKFLOW_LABELS` array in `packages/workflow-engine/src/actions/github/label-definitions.ts` (after the four existing `blocked:*` labels, around `:110-129`). Fields: `name: 'blocked:resolve-failed'`, `color: 'D73A4A'`, `description: 'PR-feedback code changes landed but thread reply/resolve failed — check GitHub API responses (#1073).'` (spec FR-013, data-model.md § New label vocabulary).

## Phase 2: Handler core — SHA capture + dispatcher gate (US1, US2, US3)

- [ ] T002 [US1] In `packages/orchestrator/src/worker/pr-feedback-handler.ts` around `:30-49`, add a new `const BLOCKED_RESOLVE_FAILED_LABEL = 'blocked:resolve-failed';` next to the existing sibling `BLOCKED_*` label constants (plan.md § pr-feedback-handler.ts edit 1).

- [ ] T003 [US1] In `packages/orchestrator/src/worker/pr-feedback-handler.ts` between `spawnClaudeForFeedback()` return (`:459-465`) and `evaluatePushGuard()` (`:474-485`), capture `const postCliSha = await this.getHeadSha(checkoutPath);` and derive `const cliSelfCommitted = postCliSha !== null && preFixSha !== null && postCliSha !== preFixSha;`. Placement is load-bearing — MUST be after spawn returns and before `commitAndPushChanges` runs (research.md § D-1, D-2; data-model.md truth table).

- [ ] T004 [US3] In `packages/orchestrator/src/worker/pr-feedback-handler.ts` at the two happy-path log branches around `:502-512`, add `source: 'handler'` structured field to both:
  - `:503-506` info line (existing message `'Successfully pushed changes to PR branch'` unchanged).
  - `:508-511` warn line (existing message `'Pushed partial changes before CLI timed out — retry may follow'` unchanged).
  Message text preserved verbatim; this is a structured-field addition, not a rewrite (research.md § D-6, FR-007).

- [ ] T005 [US1, US2] In `packages/orchestrator/src/worker/pr-feedback-handler.ts` at the B1/B2/B3 branch (`:577-590`), retarget the gate to `if (!cliSelfCommitted && (!success || !hasChanges))`. Body unchanged. Immediately after the guarded block, add a distinct info log emitted when `cliSelfCommitted && !hasChanges`:
  ```
  { prNumber, issueNumber, source: 'cli', disposition: 'cli-self-committed',
    preFixSha, postFixSha: postCliSha }
  message: 'CLI self-committed changes — proceeding to reply/resolve'
  ```
  Falls through to the happy-path reply/resolve loop at `:592+` (spec FR-002, FR-003, FR-007, FR-008, FR-008a; contract § Decision table AFTER; data-model.md § CLI-self-commit info line).

- [ ] T006 [US4] In `packages/orchestrator/src/worker/pr-feedback-handler.ts` at the `resolveSuccesses === 0` branch (`:625-633`), split by `const headAdvanced = cliSelfCommitted || hasChanges;`:
  - `headAdvanced === true` → new warn `'commit pushed but resolve batch had zero successes — entering blocked:resolve-failed disposition (#1073)'` payload includes `outcomes, preFixSha, postFixSha: postCliSha`, then `await this.addBlockedResolveFailedLabel(...)`.
  - `headAdvanced === false` → existing warn + `addBlockedStuckFeedbackLoopLabel` preserved verbatim (spec FR-013; contract § resolveSuccesses === 0 branch; data-model.md).

- [ ] T007 [US4] In `packages/orchestrator/src/worker/pr-feedback-handler.ts` after `:1242`, add a new `private async addBlockedResolveFailedLabel(github, owner, repo, issueNumber)` method mirroring the shape of `addBlockedFixerTimeoutLabel` at `:1176-1194` (try/catch, info-log on success, warn-log on failure, non-fatal fall-through). Reference `BLOCKED_RESOLVE_FAILED_LABEL` from T002 (research.md § Implementation patterns, plan.md edit 6).

## Phase 3: Cockpit precedence (US4)

- [ ] T008 [US4] In `packages/cockpit/src/state/precedence.ts` around `:26-51`, insert `'blocked:resolve-failed'` into `WAITING_PIPELINE_ORDER` immediately after `'blocked:fixer-timeout-repeat'`. Placement rationale: terminal blocked state, no auto-retry, must outrank `waiting-for:address-pr-feedback` and follow the two fixer-timeout terminals (research.md § D-4, plan.md § precedence.ts).

## Phase 4: Regression tests (US1, US2, US3, US4)

- [ ] T009 [P] [US1, US2, US3, US4] Create NEW test file `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.cli-self-commit.test.ts` (colocation pattern matches `pr-feedback-handler.push-guard.test.ts`, `pr-feedback-handler.gate-reassert.test.ts` — research.md § D-5). Reuse mock scaffolding from `pr-feedback-handler.test.ts`; spy on `getHeadSha` via `vi.spyOn(handler as any, 'getHeadSha')` and stub `commitAndPushChanges` + `spawnClaudeForFeedback`. Test cases:
  - **T-SC-001** (FR-009 / SC-001): `spawn` → `{ success: true, timedOut: false }`, `commitAndPushChanges` → `false`, `getHeadSha` → `'sha-A'` then `'sha-B'`. Assert zero `add*Blocked*Label` calls AND N reply/resolve calls (one per trusted thread).
  - **T-SC-002** (FR-010 / SC-002): same as T-SC-001 but `getHeadSha` returns `'sha-A'` both times. Assert `addBlockedStuckFeedbackLoopLabel` called exactly once.
  - **T-SC-003** (SC-003 log audit): capture `logger.info` calls; assert exactly one has `disposition: 'cli-self-committed'` with `preFixSha` and `postFixSha` fields present; assert no `logger.warn` call has message matching `/no-diff cycle/`.
  - **T-SC-004** (SC-004 unreachability): combine T-SC-001 conditions and assert `msg: "No changes to commit"` and `no-diff cycle` warn MUST NOT co-occur when `postCliSha !== preFixSha`.
  - **T-US4-B** (FR-013): head advanced (`postCliSha !== preFixSha`) + `resolveSuccesses === 0` → assert `addBlockedResolveFailedLabel` called, `addBlockedStuckFeedbackLoopLabel` NOT called.
  - **T-US4-B-inverse** (FR-013 complement): head unchanged + `resolveSuccesses === 0` → assert `addBlockedStuckFeedbackLoopLabel` called, `addBlockedResolveFailedLabel` NOT called.
  - **T-Q4-caveat** (FR-008a): assert both `preFixSha` and `postFixSha` (long form, not short) appear in the CLI-self-commit log payload.

- [ ] T010 [P] [US4] Extend `packages/cockpit/src/state/__tests__/precedence.test.ts` (or `classifier.test.ts`, whichever pins `WAITING_PIPELINE_ORDER`) with one assertion: `blocked:resolve-failed` outranks `waiting-for:address-pr-feedback` in the tie-break table (research.md § D-4 last paragraph).

## Phase 5: Changeset

- [ ] T011 Create NEW file `.changeset/1073-cli-self-commit-detection.md` with the frontmatter and body specified in plan.md § changeset (bump levels: `@generacy-ai/workflow-engine` **minor**, `@generacy-ai/orchestrator` **patch**, `@generacy-ai/cockpit` **patch**). CLAUDE.md changeset gate requires this file to be **newly added** in the PR diff.

## Phase 6: Verification

- [ ] T012 Run `pnpm --filter @generacy-ai/orchestrator test pr-feedback-handler` and assert green — SC-007 requires existing #1070 timeout-disposition coverage to pass unmodified alongside the new cases from T009.

- [ ] T013 Run `pnpm --filter @generacy-ai/cockpit test` and assert green — the precedence assertion from T010 must pass and pre-existing tie-break tests must not regress.

- [ ] T014 Run `pnpm --filter @generacy-ai/workflow-engine build` and `pnpm --filter @generacy-ai/workflow-engine test` and assert green — confirms the new label entry from T001 does not break existing consumers of `WORKFLOW_LABELS`.

- [ ] T015 Follow `quickstart.md` steps to reproduce the pre-fix failure signature in the worker log (`msg: "No changes to commit"` co-occurring with `msg: "no-diff cycle — ... blocked-stuck-feedback-loop disposition"` on a cycle that pushed a commit) and confirm the new build no longer emits that sequence — instead emits the `disposition: 'cli-self-committed'` line with both SHAs (SC-003, SC-004).

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 (label vocabulary) → T007 (handler's new label method references the label name).
- T002 (label constant) → T007.
- T003 (SHA capture + `cliSelfCommitted` local) → T005, T006 (both consume `cliSelfCommitted` / `postCliSha`).
- T005, T006, T007 all edit the same file (`pr-feedback-handler.ts`) — sequence within Phase 2 to avoid merge friction: T002 → T003 → T004 → T005 → T006 → T007.
- T005 + T006 + T007 (handler complete) → T009 (regression tests exercise the new dispatcher shape).
- T008 (cockpit precedence entry) → T010 (test asserts the new entry).
- All implementation phases (1-3) → T011 (changeset covers only added-file diffs).
- T009, T010 → T012, T013 (verification runs the new tests).
- T001-T010 → T014 (build/typecheck sanity across packages).
- All → T015 (end-to-end log-signature check).

**Parallel opportunities**:
- Within Phase 4: T009 (orchestrator test file) and T010 (cockpit test file) can run in parallel — different files, no shared state. Both marked `[P]`.
- Within Phase 6: T012, T013, T014 can run in parallel (different package filters, independent commands).

**Non-parallelizable**:
- Phase 2 tasks (T002-T007) all edit `pr-feedback-handler.ts` — must run sequentially.
- T001 must land before T007 (compile-time dependency on the label existing in `WORKFLOW_LABELS`).

---

*Generated by `/tasks`; based on spec.md, plan.md, research.md, data-model.md, and contracts/pr-feedback-disposition.md.*
