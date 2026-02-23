# Tasks: Fix `/api/jobs/poll` maxConcurrent Race Condition

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Add `requeue()` to JobQueue

### T001 [DONE] Add `requeue` method to `JobQueue` interface
**File**: `packages/generacy/src/orchestrator/job-queue.ts`
- Add `requeue(jobId: string): Promise<void>` to the `JobQueue` interface (after `cancelJob`, ~line 53)
- Include JSDoc: requeues a dequeued-but-unassignable job back to pending at its correct priority position
- Document that it throws if job not found or not in `assigned` status

### T002 [DONE] Implement `requeue` on `InMemoryJobQueue`
**File**: `packages/generacy/src/orchestrator/job-queue.ts`
- Add `async requeue(jobId: string): Promise<void>` method to `InMemoryJobQueue` (after `cancelJob`, ~line 278)
- Validate job exists — throw `Error('Job not found: ${jobId}')` if not
- Validate job status is `assigned` — throw `Error('Cannot requeue job ${jobId}: expected status \'assigned\', got \'${job.status}\'')` if not
- Reset `job.status` to `'pending'`
- Clear `job.workerId` to `undefined`
- Clear `job.assignedAt` to `undefined`
- Call `this.insertIntoQueue(jobId, job.priority)` to re-insert at correct priority position

---

## Phase 2: Fix `pollJob` handler

### T003 [DONE] Add capacity pre-check and safety-net requeue to `pollJob` handler
**File**: `packages/generacy/src/orchestrator/server.ts`
- **Pre-check** (~line 372, before `jobQueue.poll()`): check `worker.currentJobs.length >= worker.maxConcurrent`; if at capacity, log at `debug` level and return `{ job: undefined, retryAfter: 5 }` early
- **Safety-net** (after `jobQueue.poll()` returns a job): capture the boolean return value of `workerRegistry.assignJob(workerId, job.id)`; if `false`, log at `warn` level, call `await jobQueue.requeue(job.id)`, and return `{ job: undefined, retryAfter: 5 }`
- Preserve existing behavior for the happy path: log `info` on successful assignment, build response with `job ?? undefined` and `retryAfter: job ? undefined : 5`
- Ensure response uses `satisfies PollResponse` for type safety on early returns

---

## Phase 3: Unit Tests for `requeue()`

### T004 [DONE] [P] Write unit tests for `requeue` method
**File**: `packages/generacy/src/orchestrator/__tests__/job-queue.test.ts`
- Add a new `describe('requeue', ...)` block inside the existing `InMemoryJobQueue` describe
- Follow existing test patterns: use `createJob()` helper, `beforeEach` queue reset
- **Test cases**:
  1. `should requeue an assigned job back to pending` — enqueue, poll (status→assigned), requeue, poll again → same job returned with fresh `workerId`/`assignedAt`, status `assigned`
  2. `should maintain priority ordering on requeue` — enqueue high + low priority jobs, poll the high job, enqueue a normal job, requeue the high job → next poll returns the high job (not normal)
  3. `should throw for non-existent job` — `requeue('nonexistent')` → throws `'Job not found: nonexistent'`
  4. `should throw for job not in assigned status` — enqueue a pending job, call `requeue(jobId)` → throws error about wrong status (`expected status 'assigned', got 'pending'`)
  5. `should throw for completed job` — enqueue, poll, `updateStatus(jobId, 'completed')`, call `requeue` → throws
  6. `should clear workerId and assignedAt` — enqueue, poll (sets workerId/assignedAt), requeue, `getJob()` → `workerId` is `undefined`, `assignedAt` is `undefined`, status is `'pending'`

---

## Phase 4: Integration Tests for Capacity Enforcement

### T005 [DONE] [P] Write HTTP integration tests for maxConcurrent enforcement on poll
**File**: `packages/generacy/src/orchestrator/__tests__/server.test.ts`
- Add tests within the existing `GET /api/jobs/poll` describe block (or a new nested describe)
- Follow existing test patterns: use the shared `server`/`baseUrl` from `beforeAll`, register workers with `fetch`, submit jobs via `server.submitJob()`
- **Test cases**:
  1. `should not assign job when worker is at maxConcurrent capacity` — register worker with `maxConcurrent: 1`, submit 2 jobs, poll once (gets job 1), poll again → response has no job and `retryAfter: 5`
  2. `should assign next job after first job is completed` — continuing from setup: register worker (`maxConcurrent: 1`), submit 2 jobs, poll (get job 1), report result for job 1 as completed (POST `/api/jobs/:jobId/result`), poll again → gets job 2
  3. `should respect maxConcurrent: 2 allowing two concurrent jobs` — register worker with `maxConcurrent: 2`, submit 3 jobs, poll twice (get jobs 1 and 2), poll third time → returns no job with `retryAfter: 5`

---

## Phase 5: Verification

### T006 [DONE] Run all existing + new tests to verify no regressions
**Files**:
- `packages/generacy/src/orchestrator/__tests__/job-queue.test.ts`
- `packages/generacy/src/orchestrator/__tests__/server.test.ts`
- Run `pnpm vitest run packages/generacy/src/orchestrator/__tests__/` (or equivalent)
- All existing tests must continue passing
- All new tests from T004 and T005 must pass
- Confirm no TypeScript compilation errors (`pnpm tsc --noEmit` or equivalent)

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (T001 + T002) must complete before Phase 2 (T003) — `requeue()` must exist before the handler calls it
- Phase 1 must complete before Phase 3 (T004) — tests need the method to exist
- Phase 2 must complete before Phase 4 (T005) — integration tests test the handler behavior
- Phase 5 (T006) depends on all prior phases

**Parallel opportunities within phases**:
- T001 and T002 are in the same file and sequential
- T004 and T005 are in different files and can run in parallel (marked [P])
- T004 only depends on Phase 1; T005 depends on Phase 1 + Phase 2

**Critical path**:
T001 → T002 → T003 → T005 → T006

**Parallel path**:
T001 → T002 → T004 (can start as soon as Phase 1 is done, in parallel with T003)
