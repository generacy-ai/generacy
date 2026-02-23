# Bug Fix: Worker poll endpoint doesn't enforce per-worker concurrency

**Branch**: `229-summary-api-jobs-poll` | **Date**: 2026-02-23 | **Status**: Draft

## Summary

The `/api/jobs/poll` endpoint can assign multiple jobs to the same worker, bypassing the `maxConcurrent` limit. The poll handler in `server.ts` dequeues a job via `jobQueue.poll()` before checking worker capacity, and then ignores the `false` return value from `workerRegistry.assignJob()`. This allows a worker to receive more jobs than its `maxConcurrent` setting permits, causing concurrent execution on the same working directory and corrupting git state.

### Root Cause

The `pollJob` handler (`packages/generacy/src/orchestrator/server.ts:353-386`) has a check-then-act race:

```typescript
const job = await jobQueue.poll(workerId, capabilities);  // dequeues job unconditionally
if (job) {
  workerRegistry.assignJob(workerId, job.id);  // returns false if at capacity — ignored
  logger.info('Job assigned to worker', { jobId: job.id, workerId });
}
sendJson(res, 200, { job: job ?? undefined, retryAfter: job ? undefined : 5 });
```

1. `jobQueue.poll()` (`job-queue.ts:136-172`) removes the job from the pending queue, sets its status to `assigned`, and returns it — with no awareness of worker capacity.
2. `workerRegistry.assignJob()` (`worker-registry.ts:241-256`) correctly checks `worker.currentJobs.length >= worker.maxConcurrent` and returns `false` when at capacity — but the caller ignores this return value.
3. The job is sent to the worker in the HTTP response regardless.

### Observed Impact

- tetrad-development#7 and #8 were both assigned to agent-1 within 1ms at 19:26:13
- Both jobs operated on the same git working directory concurrently
- Issue #7's work was committed to issue #8's branch
- Issue #7's feature branch was never pushed

## User Stories

### US1: Orchestrator enforces worker concurrency limits

**As a** system operator,
**I want** the poll endpoint to respect each worker's `maxConcurrent` setting,
**So that** workers never receive more jobs than they can safely execute in parallel.

**Acceptance Criteria**:
- [ ] A worker with `maxConcurrent: 1` that already has an assigned job receives `{ job: undefined, retryAfter: 5 }` on subsequent poll requests
- [ ] A worker with `maxConcurrent: N` can receive up to N jobs, but no more
- [ ] Jobs not assigned due to capacity remain in the pending queue for other workers
- [ ] The capacity check occurs **before** dequeuing the job from the pending queue

### US2: Failed capacity checks don't leak jobs

**As a** system operator,
**I want** jobs to remain available when a worker is at capacity,
**So that** no jobs are lost or stuck in an assigned state with no worker processing them.

**Acceptance Criteria**:
- [ ] When `assignJob()` would return `false`, the job stays in the pending queue with `status: 'pending'`
- [ ] The job can be picked up by another worker or by the same worker after it completes a current job
- [ ] No orphaned jobs exist in `assigned` status without a corresponding worker tracking them

### US3: Rapid polling doesn't bypass concurrency

**As a** system operator,
**I want** rapid successive poll requests from the same worker to be safe,
**So that** even under high request rates, concurrency limits are enforced.

**Acceptance Criteria**:
- [ ] Two back-to-back poll requests from a worker with `maxConcurrent: 1` result in at most one job assignment
- [ ] The second request returns `{ job: undefined, retryAfter: 5 }`

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Check worker capacity before calling `jobQueue.poll()` in the `pollJob` handler | P1 | Early return with `{ job: undefined, retryAfter: 5 }` if `currentJobs.length >= maxConcurrent` |
| FR-002 | Handle `assignJob()` return value as a safety net after `poll()` | P1 | If `assignJob()` returns `false`, re-enqueue the job and return no-job response |
| FR-003 | Add `requeue()` method to `JobQueue` interface and `InMemoryJobQueue` | P1 | Resets job to `pending` status and re-adds to pending queue |
| FR-004 | Log when a poll is rejected due to capacity | P2 | Include `workerId`, `currentJobs.length`, and `maxConcurrent` in the log entry |
| FR-005 | Add test: rapid polls with `maxConcurrent: 1` yields exactly 1 job | P1 | Enqueue 2+ jobs, poll twice with same worker, assert second returns no job |
| FR-006 | Add test: `pollJob` handler respects capacity when worker already has jobs | P1 | Mock worker at capacity, verify no job is dequeued |
| FR-007 | Add test: rejected job stays in pending queue | P1 | Verify job remains available for another worker to poll |

## Technical Design

### Approach: Pre-check capacity before poll (Option A)

Add a capacity check at the start of the `pollJob` handler, before calling `jobQueue.poll()`. This is sufficient because:

- Node.js is single-threaded; synchronous code between `await` points cannot be interleaved
- The capacity check and `poll()` call execute within the same synchronous block
- No TOCTOU race exists within a single event loop tick

#### Changes to `pollJob` in `server.ts`

```typescript
async pollJob(req: IncomingMessage, res: ServerResponse) {
  // ... existing validation ...

  const worker = workerRegistry.getWorker(workerId);
  if (!worker) {
    sendError(res, 404, 'WORKER_NOT_FOUND', `Worker ${workerId} not found`);
    return;
  }

  // NEW: Check capacity before dequeuing
  if (worker.currentJobs.length >= worker.maxConcurrent) {
    logger.debug('Worker at capacity, skipping poll', {
      workerId,
      currentJobs: worker.currentJobs.length,
      maxConcurrent: worker.maxConcurrent,
    });
    sendJson(res, 200, { job: undefined, retryAfter: 5 });
    return;
  }

  const capabilities = capabilitiesParam
    ? capabilitiesParam.split(',').map(c => c.trim())
    : worker.capabilities;
  const job = await jobQueue.poll(workerId, capabilities);

  if (job) {
    const assigned = workerRegistry.assignJob(workerId, job.id);
    if (!assigned) {
      // Safety net: re-enqueue if assignment fails unexpectedly
      logger.warn('assignJob failed after capacity pre-check, re-enqueuing', {
        jobId: job.id,
        workerId,
      });
      await jobQueue.requeue(job.id);
      sendJson(res, 200, { job: undefined, retryAfter: 5 });
      return;
    }
    logger.info('Job assigned to worker', { jobId: job.id, workerId });
  }

  sendJson(res, 200, {
    job: job ?? undefined,
    retryAfter: job ? undefined : 5,
  });
}
```

#### New `requeue()` method in `job-queue.ts`

```typescript
async requeue(jobId: string): Promise<void> {
  const job = this.jobs.get(jobId);
  if (job && job.status === 'assigned') {
    job.status = 'pending';
    job.assignedAt = undefined;
    job.workerId = undefined;
    this.pendingQueue.push(jobId);
  }
}
```

### Files to Modify

| File | Change |
|------|--------|
| `packages/generacy/src/orchestrator/server.ts` | Add capacity pre-check in `pollJob`; handle `assignJob()` return value with re-enqueue fallback |
| `packages/generacy/src/orchestrator/job-queue.ts` | Add `requeue()` method to `InMemoryJobQueue` and `JobQueue` interface |
| `packages/generacy/src/orchestrator/server.test.ts` | Add tests for capacity enforcement during poll |
| `packages/generacy/src/orchestrator/job-queue.test.ts` | Add test for `requeue()` method |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Concurrent job assignments per worker | Never exceeds `maxConcurrent` | Test: 2 rapid polls with `maxConcurrent: 1` yields exactly 1 assignment |
| SC-002 | Job loss on capacity rejection | Zero jobs lost | Test: rejected jobs remain in pending queue and are assignable to other workers |
| SC-003 | Existing test suite | All pass | `pnpm test` — no regressions in `server.test.ts`, `job-queue.test.ts`, `worker-registry.test.ts` |
| SC-004 | Response format on capacity rejection | `{ job: undefined, retryAfter: 5 }` | Unit test verifies exact response shape |

## Assumptions

- Node.js single-threaded event loop ensures no interleaving between the capacity check and `jobQueue.poll()` within the same synchronous execution context
- The orchestrator runs as a single process (not clustered); if clustering is added later, the atomic check-and-claim pattern (Option B) should be revisited
- `workerRegistry.getWorker()` returns a live reference to the worker object, so `currentJobs.length` reflects the current state at read time
- The `requeue()` safety net is defensive only; under normal single-threaded operation, the pre-check prevents the condition

## Out of Scope

- Switching to an atomic check-and-claim pattern (Option B) — unnecessary for single-process Node.js
- Database-backed job queue persistence — separate concern
- Worker-side concurrency enforcement — the orchestrator is the source of truth
- Rate limiting the poll endpoint — separate concern from concurrency enforcement
- Retry or remediation of jobs corrupted by the original bug — requires manual intervention
- Cluster-aware locking or distributed concurrency control

---

*Generated by speckit*
