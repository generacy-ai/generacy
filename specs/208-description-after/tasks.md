# Tasks: Auto-Mark PR Ready on Workflow Completion

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Core Implementation

### T001 Add markReadyForReview() method to PrManager
**File**: `packages/orchestrator/src/worker/pr-manager.ts`
- Add method after `ensureDraftPr()` (after line 140)
- Implement try-catch with warn-level logging
- Call `github.getCurrentBranch()` to get current branch
- Call `github.findPRForBranch()` to get PR with number property
- Handle "no PR found" case with warning log and early return
- Call `github.markPRReady(owner, repo, pr.number)` to mark ready
- Log success with `prNumber` and `prUrl`
- Catch all errors and log as warnings without re-throwing
- Add JSDoc comment explaining idempotent behavior and best-effort nature

### T002 Integrate markReadyForReview() into workflow completion
**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`
- Locate `loopResult.completed` branch at line 227-229
- Add info log "Marking PR as ready for review" before method call
- Call `await prManager.markReadyForReview()` after `labelManager.onWorkflowComplete()`
- Place call before SSE emission (workflow:completed event)
- Ensure sequential execution (not parallel with label cleanup)

---

## Phase 2: Testing

### T003 [P] Write unit tests for PrManager.markReadyForReview()
**File**: `packages/orchestrator/src/worker/pr-manager.test.ts`
- Test success path: verify `markPRReady()` called with correct args
  - Mock `getCurrentBranch()` → `"123-feature"`
  - Mock `findPRForBranch()` → `{ number: 42, draft: true, ... }`
  - Mock `markPRReady(owner, repo, 42)` → `void`
  - Assert `markPRReady` called with `(owner, repo, 42)`
  - Assert info log emitted with `prNumber: 42` and `prUrl`
- Test "no PR found" case: verify warning logged and method returns gracefully
  - Mock `findPRForBranch()` → `null`
  - Assert `markPRReady` NOT called
  - Assert warning log emitted with branch name
- Test API error case: verify error caught and logged as warning
  - Mock `markPRReady()` → throws `Error("API rate limit")`
  - Assert warning log emitted with `error: String(error)`
  - Assert method doesn't throw (returns normally)

### T004 [P] Write integration tests for claude-cli-worker
**File**: `packages/orchestrator/src/worker/claude-cli-worker.test.ts`
- Test workflow completion: verify `markReadyForReview()` called on completion
  - Mock `phaseLoop.executeLoop()` → `{ completed: true, ... }`
  - Assert `prManager.markReadyForReview()` called
  - Assert info log "Marking PR as ready" emitted before call
- Test gate hit: verify `markReadyForReview()` NOT called at gates
  - Mock `phaseLoop.executeLoop()` → `{ gateHit: true, ... }`
  - Assert `prManager.markReadyForReview()` NOT called
- Test phase failure: verify `markReadyForReview()` NOT called on failure
  - Mock `phaseLoop.executeLoop()` → `{ completed: false, gateHit: false, ... }`
  - Assert `prManager.markReadyForReview()` NOT called

### T005 Write edge case tests
**File**: `packages/orchestrator/src/worker/pr-manager.test.ts`
- Test resume after gate: workflow pauses, resumes, completes → `markReadyForReview()` called
- Test PR already ready: verify idempotent behavior (no error when already ready)
- Test deleted PR: `findPRForBranch()` returns null → warning logged, no crash
- Test race condition: multiple calls to `markReadyForReview()` → all succeed gracefully

---

## Phase 3: Verification & Documentation

### T006 Run full test suite
**Files**: All test files in `packages/orchestrator`
- Run `pnpm test` in orchestrator package
- Verify all new tests pass
- Verify no regression in existing tests
- Check test coverage for new code paths

### T007 Manual E2E verification
**Environment**: Staging/local development
- Start development stack with Firebase emulators
- Run full orchestrator workflow (specify → clarify → plan → tasks → implement → validate)
- Verify draft PR created after specify phase
- Verify PR automatically marked ready after validate phase completes
- Check logs for "Marking PR as ready" and "Marked PR as ready" messages
- Verify no errors or warnings in orchestrator logs
- Confirm GitHub UI shows PR as "Ready for review"

### T008 Update CHANGELOG
**File**: `packages/orchestrator/CHANGELOG.md`
- Add entry under "Unreleased" or next version section
- Document new feature: "PRs automatically marked ready for review on workflow completion"
- Include note about best-effort error handling
- Reference issue/spec number (208)

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (Core Implementation) must complete before Phase 2 (Testing)
- Phase 2 (Testing) must complete before Phase 3 (Verification)
- T001 must complete before T002 (need method before calling it)

**Parallel opportunities within phases**:
- T003 and T004 can run in parallel (different test files)
- T005 can run in parallel with T003/T004 (same file as T003, but independent test cases)

**Critical path**:
T001 → T002 → T003/T004/T005 (parallel) → T006 → T007 → T008

**Estimated effort**:
- Phase 1: 30-45 minutes (straightforward implementation)
- Phase 2: 45-60 minutes (comprehensive test coverage)
- Phase 3: 30 minutes (verification and docs)
- **Total**: ~2-2.5 hours

---

## Success Criteria Checklist

After completion, verify:
- [ ] `markReadyForReview()` method added to `PrManager` with proper error handling
- [ ] Method called from `claude-cli-worker.ts` on workflow completion only
- [ ] Info log "Marking PR as ready" emitted before call
- [ ] All unit tests pass (success, no PR, API error cases)
- [ ] All integration tests pass (completed, gate, failure cases)
- [ ] Edge cases tested (resume, already ready, deleted PR, race conditions)
- [ ] Full test suite passes with no regressions
- [ ] Manual E2E test confirms PR marked ready automatically
- [ ] Logs show expected messages with no errors
- [ ] CHANGELOG updated with feature description
- [ ] No workflow failures due to mark-ready errors (all caught and logged)

---

*Task list generated 2026-02-21*
