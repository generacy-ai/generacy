# Tasks: In-Flight-Keyed Resume Dedupe (#862)

**Input**: Design documents from `/specs/862-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), clarifications.md, research.md, data-model.md, contracts/{queue-manager,lua-scripts,label-monitor}.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: `[US1]` = single durable-fix user story ("replace history-keyed resume dedupe with in-flight queue check")

All file paths below are relative to the repo root (`/workspaces/generacy`).

---

## Phase 1: Foundational (blocks everything else)

- [ ] **T001** [US1] Extend `QueueManager` interface with `enqueueIfAbsent(item)` and `hasInFlight(itemKey)` in `packages/orchestrator/src/types/monitor.ts`. Match the JSDoc contract from `data-model.md` § "Type-Level Contracts" (semantic notes on atomicity, Q1→B, Q2→A, Q3→A, Q4→A, fail-safe direction). Do not narrow `QueueAdapter` — the two extra methods live only on `QueueManager`.

- [ ] **T002** [US1] Add `IN_FLIGHT_KEY = 'orchestrator:queue:in-flight-items'` constant next to the other queue-key constants at the top of `packages/orchestrator/src/services/redis-queue-adapter.ts`. Also add a private `enqueueIfAbsentCommandDefined = false` flag alongside `claimCommandDefined`. This is prerequisite plumbing for T003–T005 to reference; keep the change minimal (constant + flag + type import if needed).

---

## Phase 2: Core Adapter Implementation

<!-- Phase boundary: T001 (interface) must land before adapters implement it. -->

- [ ] **T003** [US1] Implement `enqueueIfAbsent` on `RedisQueueAdapter` (`packages/orchestrator/src/services/redis-queue-adapter.ts`):
  - Define `ENQUEUE_IF_ABSENT_SCRIPT` Lua string exactly per `contracts/lua-scripts.md` (SISMEMBER → SADD + ZADD, returns 1/0).
  - Add `ensureEnqueueIfAbsentCommand()` following the `ensureClaimCommand()` shape (line ~73).
  - Method body: derive `itemKey` via `buildItemKey`, `priority` via `getPriorityScore(item.queueReason)`, build `SerializedQueueItem { …item, priority, attemptCount: 0, itemKey }`, invoke `(this.redis as any).enqueueIfAbsent(PENDING_KEY, IN_FLIGHT_KEY, itemKey, String(priority), JSON.stringify(serialized))`.
  - `try/catch`: on error, `logger.warn({ err, itemKey }, 'Redis error in enqueueIfAbsent, dropping (fail-safe)')` and return `false` (fail-drop per D5 in research).
  - On enqueue success (`result === 1`), emit `info` log `'Item enqueued to Redis sorted set (in-flight-checked)'` with `{ owner, repo, issue, priority, itemKey }`.

- [ ] **T004** [US1] Implement `hasInFlight(itemKey)` on `RedisQueueAdapter` (same file). Body: `SISMEMBER IN_FLIGHT_KEY itemKey`, coerce to boolean. Wrap in `try/catch`, `logger.warn` + return `false` on error. Do NOT reference this method from any dedupe path — observability only per Q1→B.

- [ ] **T005** [US1] Extend SET maintenance across `complete` and `release` in `RedisQueueAdapter` (same file, existing lines ~152–224):
  - `complete(workerId, item)` → convert existing sequential `hdel + del` into `multi().hdel(claimedKey, itemKey).del(heartbeatKey).srem(IN_FLIGHT_KEY, itemKey).exec()`. Update log line to note "removed from claimed set + in-flight index".
  - `release(workerId, item)` dead-letter branch → `multi().hdel(claimedKey, itemKey).del(heartbeatKey).zadd(DEAD_LETTER_KEY, Date.now(), JSON.stringify(deadLetterItem)).srem(IN_FLIGHT_KEY, itemKey).exec()`.
  - `release` retry branch → `multi().hdel(claimedKey, itemKey).del(heartbeatKey).zadd(PENDING_KEY, retryPriority, JSON.stringify(requeueItem)).exec()`. NO `srem` — item stays in SET (still in flight, just moved back to pending). See `contracts/lua-scripts.md` § "SET maintenance outside Lua".
  - Also confirm: existing `enqueue()` (unconditional, used only by `release` retry today) does NOT need `SADD` because the retry-path item is already in SET from its original enqueue. Skip mutating `enqueue()` in this task — Phase 3 covers the audit.

- [ ] **T006** [P] [US1] Implement `enqueueIfAbsent(item)` and `hasInFlight(itemKey)` on `InMemoryQueueAdapter` in `packages/orchestrator/src/services/in-memory-queue-adapter.ts`:
  - Add private `inFlightSet: Set<string>` field.
  - `enqueueIfAbsent`: if `inFlightSet.has(itemKey)` → return `false`; else `inFlightSet.add(itemKey)`, push to pending array with priority, return `true`. Fully synchronous under the hood (`Promise.resolve`).
  - `hasInFlight`: `Promise.resolve(this.inFlightSet.has(itemKey))`.
  - Extend `complete` and the dead-letter branch of `release` to `inFlightSet.delete(itemKey)`. Retry branch: no change (item stays in SET). See `contracts/queue-manager.md` § "Contract table" for the invariant matrix.
  - Existing implicit itemKey-idempotency guard (lines 44–61 per research.md) is now redundant with `enqueueIfAbsent`; leave `enqueue()` unconditional to match `RedisQueueAdapter` unless a caller depends on the guard — grep before deleting.

---

## Phase 3: Consumer Refactor

<!-- Phase boundary: adapters must expose `enqueueIfAbsent` before the consumer can call it. -->

- [ ] **T007** [US1] Rewrite the `type === 'resume'` branch of `LabelMonitorService.processLabelEvent` in `packages/orchestrator/src/services/label-monitor-service.ts` (existing lines ~264–372):
  - Widen `queueAdapter` constructor parameter type from `QueueAdapter` to `QueueManager` (already the concrete type passed by `server.ts:372`).
  - Delete the `phaseTracker.isDuplicate` check for `dedupPhase = 'resume:${parsedName}'`.
  - Delete the `phaseTracker.markProcessed(..., 'resume:${parsedName}', TTL)` call at the end of the resume branch.
  - Replace `await this.queueAdapter.enqueue(queueItem)` for the resume branch with `const enqueued = await this.queueManager.enqueueIfAbsent(queueItem)`.
  - On `enqueued === false`: emit the structured info line per `contracts/label-monitor.md` § "New flow" (`itemKey`, `gate`, `reason: 'in-flight'`, `source`, `owner`, `repo`, `issueNumber`), and `return false`.
  - On `enqueued === true`: emit existing `'Issue enqueued (resume)'` info line and `return true`.
  - **DO NOT touch the `type === 'process'` branch** — that path keeps `phaseTracker.clear + isDuplicate + markProcessed + queueAdapter.enqueue`. Verify with a grep pre- and post-edit.

---

## Phase 4: Deletion of #849 Paired-Clear Machinery

<!-- Phase boundary: T007 must be in place first so no runtime path still expects the callback to fire. -->

- [ ] **T008** [P] [US1] Delete `ClearResumeDedupeCallback` and paired-clear plumbing from `packages/orchestrator/src/worker/label-manager.ts`:
  - Remove the `export type ClearResumeDedupeCallback = ...` declaration (~line 10).
  - Remove the `clearResumeDedupe?: ClearResumeDedupeCallback` constructor parameter (~line 30).
  - Remove the `try { await this.clearResumeDedupe?.(gateSuffix); } catch { logger.warn(...) }` block inside `onGateHit` (search for `'Cleared paired resume dedupe on pause'`).
  - Update tests in `packages/orchestrator/src/worker/__tests__/label-manager*.test.ts` that assert the callback firing — either delete or reshape those assertions.

- [ ] **T009** [P] [US1] Delete the paired-clear closure at `packages/orchestrator/src/worker/claude-cli-worker.ts` lines ~406–422:
  - Delete the closure that captures `phaseTracker` + calls `phaseTracker.clear(item.owner, item.repo, item.issueNumber, resume:${gate})`.
  - Remove the closure argument from the `new LabelManager(...)` invocation.
  - Delete the `phaseTracker?: PhaseTracker` field from `ClaudeCliWorkerDeps` in `packages/orchestrator/src/worker/types.ts` (search for the interface definition; imports of `PhaseTracker` may also become dead — clean up).

- [ ] **T010** [US1] Delete the worker-mode `PhaseTrackerService` wiring at `packages/orchestrator/src/server.ts` lines 326–338 (from #849):
  - Remove the worker-mode `workerPhaseTracker` instantiation block.
  - Remove the `phaseTracker: workerPhaseTracker` prop passed to `new ClaudeCliWorker(...)`.
  - **KEEP** the full-mode `PhaseTrackerService` instantiation at line ~360 — that instance is still used by `LabelMonitorService`'s `type === 'process'` branch and by `PrFeedbackMonitorService`. Verify by grepping for `phaseTracker` after edit.

- [ ] **T011** [US1] Delete `packages/orchestrator/src/__tests__/paired-resume-dedupe-clear.integration.test.ts`. Its scenario ("stale `resume:<gate>` key from prior cycle blocks re-enqueue after paired-clear runs") is impossible by construction after this refactor. The single-cycle non-regression scenario (two resume triggers within one cycle → one enqueue) is covered by SC-003 in the new integration test (T013).

---

## Phase 5: Tests

<!-- Phase boundary: implementation must exist for these tests to run against. -->

- [ ] **T012** [P] [US1] Add `packages/orchestrator/src/services/__tests__/redis-queue-adapter.enqueueIfAbsent.test.ts` — unit test for the Lua atomic primitive:
  - Uses `ioredis-mock` (`RedisMock` mode) — assert `defineCommand` support for the KEYS/ARGV pattern by calling `enqueueIfAbsent` twice on the same item; expect `true` then `false`.
  - Assert SET invariants after each transition per `data-model.md` § "SET invariants":
    - After `enqueueIfAbsent` (success): `SISMEMBER in-flight-items itemKey` == 1, `ZSCORE pending <serialized>` non-nil.
    - After a full lifecycle `enqueueIfAbsent → claim → complete`: `SISMEMBER == 0`, `HKEYS claimed:<workerId>` empty.
    - After `enqueueIfAbsent → claim → release (retry)`: item back in pending, `SISMEMBER == 1` still.
    - After `enqueueIfAbsent → claim → release (dead-letter, attemptCount >= maxRetries)`: `SISMEMBER == 0`, dead-letter zset has one member.
  - Orphan-claim scenario (Q4→A): manually seed a `claimed:<dead-worker>` hash + SET member, call `enqueueIfAbsent` for the same itemKey → expect `false` (in flight). Then simulate reclaim (remove from claimed hash + SET) and retry → expect `true`.
  - Redis-error fail-safe: mock a transport error on the underlying command; expect `enqueueIfAbsent` returns `false`, no throw, warn log.
  - If `ioredis-mock` does not execute `SISMEMBER + SADD + ZADD` inside a Lua body correctly, note that in the test and refactor adapter to `WATCH/MULTI/EXEC` compare-and-swap (per `quickstart.md` § "Test-harness gotchas").

- [ ] **T013** [US1] Add `packages/orchestrator/src/__tests__/inflight-resume-dedupe.integration.test.ts` covering the three regression scenarios from `contracts/label-monitor.md` § "Test-visible behaviors":
  - Follow the shape of the deleted `paired-resume-dedupe-clear.integration.test.ts`: `ioredis-mock` + real `LabelMonitorService.processLabelEvent` + real `RedisQueueAdapter`.
  - **Scenario 1 (kept-green from #849)**: pause → resume → re-pause → resume. Both resumes must enqueue (assert `processLabelEvent` returned `true` twice; queue depth == 1 between them because `claim`+`complete` drained the first).
  - **Scenario 2 (this #862 case)**: fresh queue, no residual keys. Emit `completed:<gate>` → enqueue succeeds. Drive `claim` + `complete`. Emit `completed:<gate>` again → still enqueues. (Under pre-fix behavior with a stale phase-tracker resume key, the second would drop — assert that scenario is unreachable because no such key exists after this refactor.)
  - **Scenario 3 (SC-003 — webhook+poll race)**: fire two concurrent `processLabelEvent` calls for the same `itemKey` on the same `completed:<gate>` occurrence via `Promise.all`. Assert exactly one returned `true`, one returned `false`, and pending queue depth == 1.
  - Assert the structured drop-line format from D6 (`msg: 'Dropping resume event (item already in flight)'` with `itemKey`, `gate`, `reason: 'in-flight'`, `source`).

- [ ] **T014** [P] [US1] Sweep existing tests for references to removed symbols and update:
  - `packages/orchestrator/src/worker/__tests__/label-manager*.test.ts` — remove any `clearResumeDedupe` constructor args / callback assertions.
  - `packages/orchestrator/src/__tests__/server-boot-resume-wizard-branch.test.ts` and any other `server.ts` tests — verify they don't assert on `workerPhaseTracker` wiring.
  - `packages/orchestrator/src/services/__tests__/label-monitor*.test.ts` — refactor resume-branch assertions to expect `enqueueIfAbsent` calls instead of `phaseTracker.isDuplicate`/`markProcessed` calls; leave `process`-branch assertions untouched.
  - Compile clean (`pnpm typecheck` from repo root or `tsc --noEmit` inside the package).

---

## Phase 6: Verification

<!-- Phase boundary: run only after Phase 5 tests are green. -->

- [ ] **T015** [US1] Run the full `packages/orchestrator` test suite (`pnpm test --run` from `packages/orchestrator`). Expect all previously-green tests still green, T012 + T013 green, no references to `paired-resume-dedupe-clear` or `ClearResumeDedupeCallback` in the codebase (`grep -r 'ClearResumeDedupeCallback\|paired-resume-dedupe-clear\|clearResumeDedupe' packages/orchestrator/src` returns empty).

- [ ] **T016** [US1] Manual verification per `quickstart.md` § "Manual repro — the stranded scenario". Uses a live cluster + a test issue; five-step drill in the quickstart (attach `waiting-for:*` + `completed:*`, verify enqueue log, wait for completion, re-attach labels, verify second enqueue with NO manual `redis DEL`). Also inspect Redis directly per § "Redis inspection" — confirm `SMEMBERS orchestrator:queue:in-flight-items` reflects live state and `KEYS phase-tracker:*:resume:*` is empty for freshly-triggered resumes.

---

## Dependencies & Execution Order

**Sequential phase boundaries** (each must complete before the next starts):

1. **Phase 1** (T001–T002) — interface + constants
2. **Phase 2** (T003–T006) — adapter implementations depend on T001's interface
3. **Phase 3** (T007) — consumer depends on T003 (`enqueueIfAbsent` on Redis adapter)
4. **Phase 4** (T008–T011) — deletions depend on T007 being live so no runtime path expects the callback
5. **Phase 5** (T012–T014) — tests depend on all prior implementation
6. **Phase 6** (T015–T016) — verification depends on Phase 5

**Parallelizable within a phase**:

- **Phase 2**: T003 → T004 → T005 must run in the same file (`redis-queue-adapter.ts`) so sequential; T006 (`in-memory-queue-adapter.ts`) is `[P]` — independent file.
- **Phase 4**: T008 (`label-manager.ts`) and T009 (`claude-cli-worker.ts` + `types.ts`) are `[P]` — independent files. T010 (`server.ts`) sequential after T009 because `server.ts` imports `ClaudeCliWorkerDeps`. T011 (test deletion) is `[P]` — no code dependency.
- **Phase 5**: T012 (Redis adapter unit test) and T014 (test sweep) are `[P]` — independent files. T013 (integration test) uses `LabelMonitorService`, so it can run in parallel with T012 and T014 once implementation is complete.

**Critical serial spine** (must run in order, no shortcut):

T001 → T003 → T007 → T010 → T015

Everything else can slot into the parallel windows above.

---

## Suggested Next Step

Run `/speckit:implement` to begin execution.
