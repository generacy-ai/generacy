# Clarification Questions

## Status: Resolved

## Questions

### Q1: Requeue Position in Priority Queue
**Context**: The `pendingQueue` is sorted by priority (urgent > high > normal > low), with FIFO ordering within the same priority level. The spec's `requeue()` method pushes the job ID to the end of the array (`this.pendingQueue.push(jobId)`), which would place it after all other jobs regardless of priority — breaking the priority sort invariant. The existing `insertIntoQueue()` helper correctly inserts at the right position by priority.
**Question**: Should `requeue()` use the existing `insertIntoQueue()` method to maintain priority ordering, or should requeued jobs go to the back of the queue as the spec's code snippet implies?
**Options**:
- A) Use `insertIntoQueue()`: Requeued jobs are placed at their correct priority position (after other jobs of the same priority, but before lower-priority jobs). This preserves the queue's invariant and is consistent with how `updateStatus('pending')` already works.
- B) Push to end of queue: Requeued jobs go to the very back regardless of priority. This penalizes capacity-rejected jobs but breaks priority ordering.
**Answer**: A — Use `insertIntoQueue()`. The requeued job didn't fail — it was rejected due to worker capacity. It should go back at its correct priority position, not be penalized. Pushing to the end breaks the priority sort invariant.

---

### Q2: Requeue Error Handling for Invalid States
**Context**: The spec's `requeue()` implementation silently no-ops if the job is not found or not in `assigned` status. Other queue methods like `updateStatus()` and `cancelJob()` throw an `Error` when the job is not found. The spec should be consistent with existing patterns to avoid surprising behavior during debugging.
**Question**: What should `requeue()` do when the job doesn't exist or is in an unexpected status (e.g., `completed`, `running`, `pending`)?
**Options**:
- A) Throw on not-found, no-op on wrong status: Throw `Error('Job not found: ...')` if the job doesn't exist (matching `updateStatus`/`cancelJob` patterns), but silently return if the job is in a non-assigned status (defensive).
- B) Throw on both: Throw if the job doesn't exist OR if it's not in `assigned` status. This makes misuse visible immediately.
- C) Silent no-op for all cases: Match the spec as written — silently return for any unexpected input. This is the most defensive but hides bugs.
**Answer**: B — Throw on both. A requeue of a non-existent job or a job in `completed`/`pending`/`running` status is a programming error that should surface immediately. Matches the existing `updateStatus()`/`cancelJob()` throw-on-not-found pattern.

---

### Q3: Clearing workerId/assignedAt on Requeue
**Context**: When `poll()` assigns a job, it sets `job.workerId` and `job.assignedAt`. The spec's `requeue()` clears `assignedAt` but uses `undefined` assignment (`job.assignedAt = undefined`). The Job interface declares `assignedAt?: string` (ISO timestamp string), so this is type-safe, but `workerId` is also cleared. Should the spec also clear `job.workerId`? The spec snippet does clear it (`job.workerId = undefined`), but this is worth confirming since `workerId` could be useful for debugging/auditing to know who last had the job.
**Question**: Is clearing both `workerId` and `assignedAt` on requeue the correct behavior, or should `workerId` be preserved for audit/debugging purposes (e.g., as `lastWorkerId`)?
**Options**:
- A) Clear both fields: Reset the job to a clean pending state with no worker association. Simple and consistent with the initial pending state.
- B) Preserve workerId in metadata: Clear `workerId` from the primary field but store it in `job.metadata.lastWorkerId` for debugging. Adds minor complexity but aids troubleshooting.
**Answer**: A — Clear both fields. The job returns to a clean pending state. The orchestrator logs already record which worker was assigned the job, so `lastWorkerId` metadata adds complexity for marginal debugging value.

---

### Q4: Safety Net Requeue — Should It Also Unassign from Worker Registry?
**Context**: In the safety-net branch (where `assignJob()` returns `false` after `poll()` already dequeued the job), the spec calls `jobQueue.requeue(job.id)` to put the job back. However, `poll()` already set `job.workerId = workerId` on the job object in the queue. Since `assignJob()` returned `false`, the worker's `currentJobs` array does NOT contain this job ID. But the job's own `workerId` field points to this worker. `requeue()` clears `workerId`, so this is handled — but if `requeue()` implementation changes, this could become inconsistent. Should the handler explicitly call `workerRegistry.unassignJob()` as well for safety?
**Question**: Should the safety-net branch also call `workerRegistry.unassignJob(workerId, job.id)` before requeuing, even though the worker registry never tracked the assignment?
**Options**:
- A) No explicit unassign: `requeue()` already clears the job's `workerId`, and the worker registry never added the job to `currentJobs`. An unnecessary `unassignJob()` call adds confusion.
- B) Add explicit unassign as defense-in-depth: Call `unassignJob()` before `requeue()`. It's a no-op if the job isn't tracked, but makes the intent clear and is safe against future changes.
**Answer**: A — No explicit unassign. `assignJob()` returned `false`, so the worker registry never tracked the job. Calling `unassignJob()` would be a misleading no-op that implies the assignment happened. `requeue()` already clears `workerId` on the job itself.

---

### Q5: Log Level for Capacity Pre-Check Rejection
**Context**: The spec uses `logger.debug()` for the capacity pre-check rejection (FR-004 says "Log when a poll is rejected due to capacity" at P2). In production, `debug` level logs are typically disabled, which means operators wouldn't see capacity rejections in normal logging. However, the safety-net branch uses `logger.warn()`. The pre-check rejection is an expected, normal-operation event (worker is busy), while the safety-net is an unexpected anomaly.
**Question**: What log level should the capacity pre-check rejection use?
**Options**:
- A) `debug`: Capacity rejections are a normal, expected event during healthy operation. Only visible when debugging is enabled. Avoids log noise.
- B) `info`: Makes capacity rejections visible in standard production logs, useful for operators monitoring worker utilization without enabling debug.
- C) `warn` for first occurrence per worker, `debug` for subsequent: Highlights the first time a worker hits capacity (potentially unexpected), then quiets down. Adds implementation complexity.
**Answer**: A — `debug`. Capacity rejections are normal operation — the worker is busy and polls frequently. `info` would be noisy in production. The safety-net `warn` is correct because that path is an unexpected anomaly.

---

### Q6: Test Scope — Integration vs. Unit for pollJob Handler
**Context**: The spec lists tests in FR-005/FR-006/FR-007 but doesn't specify whether these should be HTTP-level integration tests (hitting the actual server with `fetch()`, matching existing `server.test.ts` patterns) or unit tests that call the handler directly with mocked request/response objects. The existing `server.test.ts` uses HTTP-level tests with a real server instance.
**Question**: Should the new pollJob tests follow the existing HTTP integration test pattern in `server.test.ts`, or should they be lower-level unit tests?
**Options**:
- A) HTTP integration tests: Follow the existing `server.test.ts` pattern — spin up the server, use `fetch()` to call `/api/jobs/poll`, assert on HTTP responses. Tests the full request path including routing and serialization.
- B) Both: Add HTTP integration tests for the handler behavior AND unit tests for the `requeue()` method in `job-queue.test.ts`. This is what the spec's file list implies (changes to both test files).
**Answer**: B — Both. HTTP integration tests for the handler (matching existing `server.test.ts` patterns) plus unit tests for the `requeue()` method in `job-queue.test.ts`. The spec's file list implies both.

---

### Q7: Handling of Unknown/Unregistered Workers in Poll
**Context**: The spec adds a capacity check using `workerRegistry.getWorker(workerId)` and returns 404 if the worker is not found. The existing `pollJob` handler already looks up the worker for capabilities but does NOT return an error if the worker isn't registered — it falls through and uses the query parameter capabilities instead. The spec changes this behavior to require worker registration before polling.
**Question**: Is requiring worker registration before polling (returning 404 for unregistered workers) an intentional behavior change, or should unregistered workers still be able to poll with explicit capabilities?
**Options**:
- A) Require registration (spec as written): Workers must register before polling. The 404 error for unregistered workers is intentional. This ensures all workers have a `maxConcurrent` limit.
- B) Allow unregistered workers with explicit capabilities: If a worker provides capabilities in the query string, allow polling even without registration. Skip the capacity check for unregistered workers (no limit enforceable). This preserves backward compatibility.
**Answer**: A — Require registration (spec as written). The existing handler already returns 404 for unregistered workers (server.ts:363-366). This isn't a behavior change — it's the current behavior.

---

### Q8: Response Shape — `job: undefined` vs Omitted Field
**Context**: The spec uses `{ job: undefined, retryAfter: 5 }` as the no-job response, but when serialized to JSON, `undefined` values are omitted entirely — `JSON.stringify({ job: undefined })` produces `{}`. The existing handler uses `job ?? undefined` which has the same behavior. Clients parsing the JSON response would see a missing `job` field, not an explicit `null`. Should the response explicitly use `null` instead of `undefined` to make the "no job available" state unambiguous in the JSON response?
**Question**: Should the no-job response use `null` (explicitly present in JSON) or `undefined` (omitted from JSON) for the `job` field?
**Options**:
- A) Keep `undefined` (omitted from JSON): Match existing behavior. Clients already handle this since it's the current response format.
- B) Change to `null`: Use `{ job: null, retryAfter: 5 }` so the field is explicitly present in the JSON response. This is a more explicit API contract but changes the existing response shape.
**Answer**: A — Keep `undefined` (omitted from JSON). This is the existing behavior. Changing to `null` would be a breaking API change for clients, not appropriate for a bug fix.
