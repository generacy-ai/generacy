# Tasks: Resume-After-Failure Retry Logic for Implement Phase

**Input**: Design documents from `specs/359-summary-when-implement-phase/`
**Prerequisites**: plan.md (required), spec.md (required), research.md (available)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup

- [X] T001 [US2] Add `maxImplementRetries` to `WorkerConfigSchema` in `packages/orchestrator/src/worker/config.ts`
  - Add field: `maxImplementRetries: z.number().int().min(0).max(5).default(2)`
  - Include JSDoc comment: `/** Maximum retries for implement phase when partial progress is detected */`

- [X] T002 [P] [US1] Add optional `options?: { message?: string }` parameter to `commitPushAndEnsurePr` in `packages/orchestrator/src/worker/pr-manager.ts`
  - Update method signature: `async commitPushAndEnsurePr(phase: WorkflowPhase, options?: { message?: string })`
  - Thread `options?.message` through to `commitAndPush` (extract as private parameter or inline)
  - In `commitAndPush`, use `options?.message ?? \`chore(speckit): complete ${phase} phase for #${this.issueNumber}\`` as the commit message

## Phase 2: Core Retry Logic in phase-loop.ts

All tasks touch `packages/orchestrator/src/worker/phase-loop.ts`.

- [X] T003 [US1] Guard `phaseTimestamps.set()` to preserve `startedAt` across retries (~line 108)
  - Replace unconditional `phaseTimestamps.set(phase, { startedAt: ... })` with:
    ```typescript
    if (!phaseTimestamps.has(phase)) {
      phaseTimestamps.set(phase, { startedAt: new Date().toISOString() });
    }
    ```

- [X] T004 [US2] Declare `implementRetryCount` counter before the phase loop (~line 81)
  - Add `let implementRetryCount = 0;` before `for (let i = startIndex; ...)`
  - Place after the `currentSessionId` declaration for logical grouping

- [X] T005 [US1] [US3] Insert implement retry block after the failure handler (~line 198–211)
  - After `results.push(result)` and before `if (!result.success) { ... return ... }`, add:
    ```typescript
    if (!result.success && phase === 'implement') {
      const { hasChanges } = await prManager.commitPushAndEnsurePr(phase, {
        message: `wip(speckit): partial implement progress for #${context.item.issueNumber} (retry ${implementRetryCount + 1})`,
      });
      if (hasChanges && implementRetryCount < config.maxImplementRetries) {
        implementRetryCount++;
        currentSessionId = undefined;
        this.logger.warn(
          { phase, retry: implementRetryCount, maxRetries: config.maxImplementRetries },
          'Implement phase failed with partial progress — retrying with fresh session',
        );
        await stageCommentManager.updateStageComment({
          stage,
          status: 'in_progress',
          phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'in_progress'),
          startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
          prUrl: context.prUrl,
        });
        i--;
        continue;
      }
    }
    ```
  - Note: This block must come BEFORE the existing `if (!result.success) {` block that calls `labelManager.onError`

- [X] T006 [US1] Update `hasPriorImplementation` check to match WIP retry commit messages (~line 229–233)
  - Add `.includes('partial implement progress')` to the `commits.some(...)` predicate:
    ```typescript
    hasPriorImplementation = commits.some(
      (c) =>
        c.message.includes(`complete ${phase} phase`) ||
        c.message.includes('feat: complete T') ||
        c.message.includes('partial implement progress'),
    );
    ```

## Phase 3: Tests

- [X] T007 [P] [US2] Add unit tests for `maxImplementRetries` config validation in `packages/orchestrator/src/config/__tests__/loader-workspace.test.ts` or a new `packages/orchestrator/src/worker/__tests__/config.test.ts`
  - Test that `maxImplementRetries` defaults to `2`
  - Test that valid values (0–5) parse correctly
  - Test that out-of-range values (negative, >5) fail Zod validation
  - Test that non-integer values fail Zod validation

- [X] T008 [P] [US1] Update `packages/orchestrator/src/worker/pr-manager.test.ts` for custom commit message option
  - Add test: when `options.message` is provided, `github.commit` is called with the custom message
  - Add test: when `options.message` is omitted, `github.commit` is called with the default `chore(speckit): complete ${phase} phase` message
  - Verify backward compatibility: existing tests for `commitPushAndEnsurePr` still pass without modification

- [X] T009 [US1] [US2] [US3] Add retry scenario tests to `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts`
  - Test: implement phase failure with `hasChanges=true` triggers retry (counter increments, `currentSessionId` cleared, loop continues)
  - Test: implement phase failure with `hasChanges=false` falls through to existing error path immediately
  - Test: retry count respects `maxImplementRetries` — when exhausted, error path is triggered
  - Test: non-implement phase failure (`clarify`, `plan`, etc.) does NOT trigger retry
  - Test: `stageCommentManager.updateStageComment` is called with `status: 'in_progress'` on retry (US3)
  - Test: `phaseTimestamps` `startedAt` is preserved (not overwritten) on re-entry to implement phase
  - Test: `implementRetryCount` resets per `executeLoop` call (declared inside the function, not the class)

## Dependencies & Execution Order

**Phase 1** (T001, T002): Independent — touch different files (`config.ts`, `pr-manager.ts`). Run in parallel.

**Phase 2** (T003–T006): All modify `phase-loop.ts`. Must run sequentially in order:
- T003 before T005 (timestamp guard needed before retry loop entry)
- T004 before T005 (retry counter needed before retry block)
- T005 before T006 (retry block needs to exist before updating hasPriorImplementation context is tested)

**Phase 3** (T007–T009): Tests can start once corresponding implementation is complete:
- T007 can run after T001 (config)
- T008 can run after T002 (pr-manager)
- T009 can run after T003–T006 (phase-loop)
- T007 and T008 are parallel (different test files)

**Critical ordering**: Phase 2 must complete before T009 (phase-loop tests).
