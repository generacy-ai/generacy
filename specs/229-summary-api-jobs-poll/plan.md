# Implementation Plan: Fix `/api/jobs/poll` maxConcurrent Race Condition

## Summary

The `pollJob` handler in the orchestrator server has a check-then-act race condition where `jobQueue.poll()` dequeues a job before `workerRegistry.assignJob()` checks the worker's capacity. If `assignJob()` returns `false` (worker at capacity), the job is already dequeued and sent to the worker anyway, bypassing the `maxConcurrent` limit.

**Fix approach**: Add a capacity pre-check before calling `poll()`, and a safety-net after `poll()` that requeues the job if `assignJob()` fails. Add a `requeue()` method to `InMemoryJobQueue` that returns a job to the pending queue in its correct priority position.

## Technical Context

- **Language**: TypeScript (ESM, `.js` extensions in imports)
- **Runtime**: Node.js (single-threaded event loop)
- **Framework**: Raw `node:http` server with custom router
- **Test framework**: Vitest
- **Key files**:
  - `packages/generacy/src/orchestrator/server.ts` — HTTP handler
  - `packages/generacy/src/orchestrator/job-queue.ts` — `JobQueue` interface + `InMemoryJobQueue`
  - `packages/generacy/src/orchestrator/worker-registry.ts` — `WorkerRegistry` (no changes needed)
  - `packages/generacy/src/orchestrator/__tests__/server.test.ts` — HTTP integration tests
  - `packages/generacy/src/orchestrator/__tests__/job-queue.test.ts` — Unit tests

## Architecture Overview

The fix is minimal and surgical — three changes across two source files and two test files:

```
pollJob handler (server.ts)
│
├── 1. PRE-CHECK: worker.currentJobs.length >= worker.maxConcurrent?
│   └── YES → return { job: undefined, retryAfter: 5 } (skip poll entirely)
│
├── 2. POLL: jobQueue.poll(workerId, capabilities)
│   └── returns job (already dequeued + marked assigned)
│
└── 3. ASSIGN: workerRegistry.assignJob(workerId, job.id)
    ├── TRUE → log success, send job in response
    └── FALSE (safety net) → jobQueue.requeue(job.id), log warn, return retryAfter
```

The pre-check prevents the common case. The safety-net handles the edge case where another async operation assigns a job between the pre-check and the poll (theoretically impossible in single-threaded Node.js, but good defensive coding).

## Implementation Phases

### Phase 1: Add `requeue()` to `JobQueue` interface and `InMemoryJobQueue`

**File**: `packages/generacy/src/orchestrator/job-queue.ts`

**1a. Add `requeue` to `JobQueue` interface** (after `cancelJob`, ~line 53):

```typescript
/**
 * Requeue a job that was dequeued but could not be assigned.
 * Returns the job to the pending queue at its correct priority position.
 * @param jobId - The job ID to requeue
 * @throws Error if job not found or not in 'assigned' status
 */
requeue(jobId: string): Promise<void>;
```

**1b. Implement `requeue` on `InMemoryJobQueue`** (after `cancelJob`, ~line 278):

```typescript
async requeue(jobId: string): Promise<void> {
  const job = this.jobs.get(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  if (job.status !== 'assigned') {
    throw new Error(`Cannot requeue job ${jobId}: expected status 'assigned', got '${job.status}'`);
  }

  // Reset to clean pending state
  job.status = 'pending';
  job.workerId = undefined;
  job.assignedAt = undefined;

  // Re-insert at correct priority position
  this.insertIntoQueue(jobId, job.priority);
}
```

**Key decisions** (from clarifications):
- Uses `insertIntoQueue()` to maintain priority ordering (Q1: answer A)
- Throws on not-found AND wrong status (Q2: answer B)
- Clears both `workerId` and `assignedAt` (Q3: answer A)

---

### Phase 2: Fix `pollJob` handler in server

**File**: `packages/generacy/src/orchestrator/server.ts`

Replace lines 372-385 (the poll-assign-response block) with:

```typescript
// Pre-check: reject if worker is already at capacity
if (worker.currentJobs.length >= worker.maxConcurrent) {
  logger.debug('Worker at capacity, skipping poll', {
    workerId,
    currentJobs: worker.currentJobs.length,
    maxConcurrent: worker.maxConcurrent,
  });
  sendJson(res, 200, { job: undefined, retryAfter: 5 } satisfies PollResponse);
  return;
}

const job = await jobQueue.poll(workerId, capabilities);

if (job) {
  const assigned = workerRegistry.assignJob(workerId, job.id);
  if (!assigned) {
    // Safety net: job was dequeued but worker can't accept it — put it back
    logger.warn('Worker assignment failed after poll, requeuing job', {
      jobId: job.id,
      workerId,
    });
    await jobQueue.requeue(job.id);
    sendJson(res, 200, { job: undefined, retryAfter: 5 } satisfies PollResponse);
    return;
  }
  logger.info('Job assigned to worker', { jobId: job.id, workerId });
}

const response: PollResponse = {
  job: job ?? undefined,
  retryAfter: job ? undefined : 5,
};

sendJson(res, 200, response);
```

**Key decisions** (from clarifications):
- `logger.debug` for pre-check rejection (Q5: answer A — normal operation, not noisy)
- `logger.warn` for safety-net path (unexpected anomaly)
- No explicit `workerRegistry.unassignJob()` in safety-net (Q4: answer A — registry never tracked it)
- Response uses `undefined` not `null` (Q8: answer A — match existing behavior)
- Workers must be registered before polling (Q7: answer A — already the current behavior)

---

### Phase 3: Add unit tests for `requeue()`

**File**: `packages/generacy/src/orchestrator/__tests__/job-queue.test.ts`

Add a new `describe('requeue', ...)` block with these test cases:

1. **should requeue an assigned job back to pending** — enqueue a job, poll it (status becomes `assigned`), requeue it, poll again → get the same job back with `pending→assigned` transition, `workerId` and `assignedAt` cleared then re-set.

2. **should maintain priority ordering on requeue** — enqueue jobs at `high` and `low` priority, poll the `high` job, enqueue a new `normal` job, requeue the `high` job → next poll returns the `high` job (not the `normal` one).

3. **should throw for non-existent job** — call `requeue('nonexistent')` → throws `Error('Job not found: nonexistent')`.

4. **should throw for job not in assigned status** — enqueue a pending job, call `requeue(jobId)` → throws error about wrong status.

5. **should throw for completed job** — enqueue, poll, update to `completed`, call `requeue` → throws.

6. **should clear workerId and assignedAt** — enqueue, poll (sets workerId/assignedAt), requeue, then `getJob()` → `workerId` is undefined, `assignedAt` is undefined, status is `pending`.

---

### Phase 4: Add HTTP integration tests for capacity enforcement

**File**: `packages/generacy/src/orchestrator/__tests__/server.test.ts`

Add tests within the existing `GET /api/jobs/poll` describe block:

1. **should not assign job when worker is at maxConcurrent capacity** — register a worker with `maxConcurrent: 1`, submit 2 jobs, poll once (gets job 1), poll again → should return `{ retryAfter: 5 }` with no job (worker at capacity).

2. **should assign next job after completing the first** — continuing from above, report the first job as completed (which calls `unassignJob`), poll again → should return job 2.

3. **should requeue job if assignment fails (safety net)** — This is harder to test at the HTTP level because the safety-net path requires `assignJob()` to return `false` after the pre-check passed. Could be tested by:
   - Registering a worker with `maxConcurrent: 1`
   - Submitting 2 jobs
   - Polling and getting job 1 (assigned)
   - Verify second poll returns no job (pre-check blocks it)

   The safety-net path is primarily tested via the unit tests in phase 3 and by confirming the requeue logic works correctly.

---

## Files Changed

| File | Change | Lines |
|------|--------|-------|
| `packages/generacy/src/orchestrator/job-queue.ts` | Add `requeue()` to interface + implementation | ~25 new lines |
| `packages/generacy/src/orchestrator/server.ts` | Add pre-check + safety-net in `pollJob` | ~20 modified lines |
| `packages/generacy/src/orchestrator/__tests__/job-queue.test.ts` | Add `requeue` unit tests | ~80 new lines |
| `packages/generacy/src/orchestrator/__tests__/server.test.ts` | Add capacity enforcement integration tests | ~50 new lines |

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Pre-check vs atomic check-and-claim | Pre-check (Option A from spec) | Node.js is single-threaded; the pre-check and poll execute synchronously within the same event loop tick. No TOCTOU race possible. Simpler than threading worker registry through the queue. |
| Requeue priority position | Use `insertIntoQueue()` | Job wasn't at fault — worker was at capacity. Penalizing it by pushing to end would break priority invariant. (Q1) |
| Requeue error handling | Throw on not-found AND wrong status | Calling requeue on a completed/pending job is a programming error. Matches existing `updateStatus`/`cancelJob` throw-on-not-found pattern. (Q2) |
| Worker fields on requeue | Clear both `workerId` and `assignedAt` | Clean slate. Logs already capture the assignment history. (Q3) |
| Safety-net unassign | No explicit `unassignJob()` | Registry never tracked the job (`assignJob` returned false). Calling `unassignJob` would be a misleading no-op. (Q4) |
| Pre-check log level | `debug` | Capacity rejections are normal operation during healthy polling. `warn` reserved for safety-net anomaly. (Q5) |
| Response format | Keep `undefined` (omitted from JSON) | Match existing behavior. Changing to `null` would be a breaking API change. (Q8) |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Pre-check reads stale `currentJobs` | Impossible in single-threaded Node.js — `currentJobs` is updated synchronously by `assignJob`/`unassignJob`. No async gap between check and poll. |
| `requeue()` called on already-requeued job | Throws on wrong status (job must be `assigned`). After requeue, status is `pending`, so double-requeue throws. |
| Existing tests break | No existing behavior changes for the happy path. Pre-check only adds a new early-return for at-capacity workers. Existing tests use `maxConcurrent: 1` and poll once — they'll pass unchanged. |
| Job lost if requeue throws | `requeue()` only throws on invalid input (not-found, wrong status). In the safety-net path, the job was just dequeued by `poll()` so it definitely exists and is in `assigned` status. |
| Worker polls rapidly and always gets rejected | Expected behavior — the `retryAfter: 5` tells the client to back off for 5 seconds. This matches the existing no-job-available response. |
