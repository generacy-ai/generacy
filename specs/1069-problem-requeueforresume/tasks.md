# Tasks: Atomic `requeueForResume()` / `release()` re-pend in `RedisQueueAdapter`

**Input**: Design documents from `/specs/1069-problem-requeueforresume/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Lua-script atomicity (FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007)

- [X] T001 [US1] Add `REQUEUE_FOR_RESUME_SCRIPT` constant to
  `packages/orchestrator/src/services/redis-queue-adapter.ts`, immediately after
  `RECLAIM_ORPHAN_SCRIPT`. Body per `contracts/requeue-for-resume-script.md § Lua body`:
  `HGET` claim → null-guard returns `{0, -1}` after best-effort `DEL heartbeat`;
  otherwise `cjson.decode` → set `queueReason='resume'`, `priority=tonumber(ARGV[2])`,
  `attemptCount=parsed.attemptCount` (verbatim, FR-003), `itemKey=ARGV[1]`,
  `claimedAt=nil` (A6) → `HDEL` + `DEL heartbeat` + `ZADD pending` → return
  `{1, parsed.attemptCount}`.

- [X] T002 [US1] Add `RELEASE_SCRIPT` constant to
  `packages/orchestrator/src/services/redis-queue-adapter.ts`, immediately after
  `REQUEUE_FOR_RESUME_SCRIPT`. Body per `contracts/release-script.md § Lua body`:
  `HGET` claim → null-guard returns `{0, -1}` after best-effort `DEL heartbeat`;
  otherwise `cjson.decode` + `attemptCount = parsed.attemptCount + 1` (FR-004);
  branch on `attemptCount >= tonumber(ARGV[4])`: dead-letter branch `HDEL` +
  `DEL heartbeat` + `ZADD dead-letter <nowMs> <payload>` + `SREM in-flight`
  (FR-006) → return `{2, attemptCount}`; retry branch overwrites
  `queueReason='retry'`, `priority=tonumber(ARGV[2])`, no `SREM`, `HDEL` +
  `DEL heartbeat` + `ZADD pending` → return `{1, attemptCount}`.

- [X] T003 [US1] Add `_REQUEUE_FOR_RESUME_SCRIPT_FOR_TESTS` and
  `_RELEASE_SCRIPT_FOR_TESTS` `@internal` const-exports in the same location
  as `_ENQUEUE_IF_ABSENT_SCRIPT_FOR_TESTS` (currently around
  `redis-queue-adapter.ts:67`). FR-012 static-assertion pattern parity with
  `_ENQUEUE_IF_ABSENT_SCRIPT_FOR_TESTS`.

- [X] T004 [US1] Add private boolean flags `requeueForResumeCommandDefined = false`
  and `releaseCommandDefined = false` in the sibling group at
  `redis-queue-adapter.ts:190-192` (next to `claimCommandDefined`,
  `enqueueIfAbsentCommandDefined`, `reclaimOrphanCommandDefined`).

- [X] T005 [US1] Add `ensureRequeueForResumeCommand()` private method following
  the existing `ensureEnqueueIfAbsentCommand()` / `ensureReclaimOrphanCommand()`
  pattern at `redis-queue-adapter.ts:234-250`. Calls
  `this.redis.defineCommand('requeueForResumeItem', { numberOfKeys: 3, lua: REQUEUE_FOR_RESUME_SCRIPT })`.
  Command name uses the `Item` suffix to avoid shadowing the adapter's own
  public method name on the ioredis client object (data-model.md § New adapter fields).

- [X] T006 [US1] Add `ensureReleaseCommand()` private method with same pattern.
  Calls `this.redis.defineCommand('releaseItem', { numberOfKeys: 5, lua: RELEASE_SCRIPT })`.
  `numberOfKeys: 5` covers pending / claimed / heartbeat / dead-letter /
  in-flight per `contracts/release-script.md § Keys`.

---

## Phase 2: Caller rewrite of `release()` and `requeueForResume()` (FR-005, FR-007, FR-008)

<!-- Phase boundary: Complete Phase 1 (scripts + defineCommand guards must exist before callers can invoke them). -->

- [X] T007 [US1] Rewrite `requeueForResume()` at
  `packages/orchestrator/src/services/redis-queue-adapter.ts:839-894` per the
  caller shape in `contracts/requeue-for-resume-script.md § Caller shape`.
  Call `ensureRequeueForResumeCommand()`; invoke
  `(this.redis as any).requeueForResumeItem(PENDING_KEY, claimedKey, heartbeatKey, itemKey, String(resumePriority), JSON.stringify(item))`;
  destructure `[code, attemptCount]`; `switch(code)` on 0 (log existing
  `:853-856` info line — no `attemptCount` field) and 1 (log existing
  `:879-887` info line with `attemptCount` from tuple). Preserve outer
  `try/catch → logger.warn(..., 'Redis error in requeueForResume')` verbatim.
  Message text and field shape MUST match `:853-856` + `:879-887` byte-for-byte
  (FR-005 + SC-007).

- [X] T008 [US1] Rewrite `release()` at
  `packages/orchestrator/src/services/redis-queue-adapter.ts:724-813` per the
  caller shape in `contracts/release-script.md § Caller shape`. Call
  `ensureReleaseCommand()`; invoke
  `(this.redis as any).releaseItem(PENDING_KEY, claimedKey, heartbeatKey, DEAD_LETTER_KEY, IN_FLIGHT_KEY, itemKey, String(retryPriority), JSON.stringify(item), String(this.maxRetries), String(Date.now()))`;
  destructure `[code, attemptCount]`; `switch(code)` on 0 (log existing
  `:753-756` info line), 1 (log existing `:802-805` info line with
  `attemptCount` from tuple), 2 (`this.dropLogState.delete(itemKey)` +
  `this.enqueuedAtCache.delete(itemKey)` bookkeeping cleanup, then log
  existing `:782-785` warn line with `attemptCount` + `maxRetries` from tuple).
  Preserve outer `try/catch → logger.warn(..., 'Redis error in release')`
  verbatim. All message text and field shapes MUST match
  `:753-756` + `:782-785` + `:802-805` byte-for-byte (FR-005 + SC-007).

- [X] T009 [P] [US1] Parity audit of
  `packages/orchestrator/src/services/in-memory-queue-adapter.ts` per FR-009 /
  OoS-5. Confirm log-line messages and field shapes at `:236-240` (release no-op),
  `:263-266` (dead-letter), `:278-281` (retry), `:296-300` (requeueForResume
  no-op), `:319-327` (requeueForResume success) match the Redis adapter
  post-rewrite (Phase 2 tasks T007 + T008). Expected: exact match with zero
  source edit required. No behavioural change; do NOT introduce a Lua script
  here (adapter is Redis-free by contract).

---

## Phase 3: Concurrency + round-trip regression coverage (FR-010, FR-011, FR-012, SC-001, SC-002, SC-003, SC-004, SC-005, SC-006)

<!-- Phase boundary: Complete Phase 2 (callers must invoke the new scripts before tests can exercise them end-to-end). -->

- [X] T010 [P] [US1] Create
  `packages/orchestrator/src/services/__tests__/redis-queue-adapter.requeueForResume-atomic.test.ts`
  (SC-001, FR-010). Real ioredis against a live `redis:7` service. Two
  `describe` blocks: (a) **Deterministic controlled interleave** — seed a
  claim + heartbeat; use `redis.monitor()` or a wrapped ioredis command hook
  to detect the first `HGET claimed:*` and inject a full `reapOrphanClaims()`
  call between `HGET` return and the mutation window; assert on fixed code
  that script's inside-Lua `HGET` returns `nil`, script returns `{0, -1}`,
  `ZCARD pending === 1` (reaper's re-pend is the only writer); baseline
  demonstration per `quickstart.md § Deterministic-interleave baseline`
  (reviewer runs against `HEAD~1` worktree and attaches failure log to PR
  description). (b) **Natural-race smoke test** — N=100 pairs of
  `Promise.all([reapOrphanClaims(), requeueForResume(workerId, item)])`,
  fresh claim per pair; assert `ZCARD pending === 1` each pair.

- [X] T011 [P] [US1] Create
  `packages/orchestrator/src/services/__tests__/redis-queue-adapter.release-atomic.test.ts`
  (SC-002, FR-010). Same shape as T010 for BOTH branches of `release()`.
  Two additional `describe` blocks beyond the requeueForResume shape:
  `describe('retry branch', ...)` — `attemptCount + 1 < maxRetries` seeded;
  deterministic interleave asserts `ZCARD pending === 1` + retry payload
  preserved + `SISMEMBER IN_FLIGHT_KEY itemKey === 1` (FR-006);
  `describe('dead-letter branch (FR-002 Q1=A)', ...)` — `attemptCount + 1 === maxRetries`
  seeded; deterministic interleave asserts (post-fix) that when the
  script-fired path runs, `ZCARD dead-letter === 1` and
  `SISMEMBER IN_FLIGHT_KEY itemKey === 0`; when the reaper-won path runs
  (script's inside-Lua `HGET` returns `nil`, returns `{0, -1}`), in-flight
  SET is untouched (`SISMEMBER === 1`). Both branches exactly 1 round trip
  (SC-004).

- [X] T012 [P] [US1] Create
  `packages/orchestrator/src/services/__tests__/redis-queue-adapter.round-trip-count.test.ts`
  (SC-003 + SC-004). **Separate plain test** per Clarifications Q4 rider —
  no concurrency harness. Wrap the ioredis client with a command counter
  (either `redis.monitor()` subscriber or a proxy `Redis` object). Assert
  exactly 1 command reaching Redis on each of: (a) `requeueForResume`
  success path (1 × `EVALSHA` of `REQUEUE_FOR_RESUME_SCRIPT`, excluding
  null-guard `DEL heartbeat`), (b) `release` retry branch success
  (1 × `EVALSHA` of `RELEASE_SCRIPT`), (c) `release` dead-letter branch
  success (1 × `EVALSHA` of `RELEASE_SCRIPT` — Q1=A load-bearing
  assertion).

- [X] T013 [P] [US1] Create
  `packages/orchestrator/src/services/__tests__/redis-queue-adapter.attemptcount-preservation.test.ts`
  (SC-005 + SC-006). Real ioredis. Three test blocks: (a) 100 repeated
  lease-expiry cycles `enqueueIfAbsent → claim → requeueForResume → claim`,
  assert `parsed.attemptCount` bit-identical pre-/post- each cycle (FR-003,
  SC-005); (b) 100 cycles `enqueueIfAbsent → claim → release-retry → claim`,
  assert `attemptCount` increments by exactly one per cycle (FR-004);
  (c) single cycle `enqueueIfAbsent → claim → release × maxRetries`, assert
  dead-letter fires on exactly the `maxRetries`-th call and item is `SREM`'d
  from `IN_FLIGHT_KEY` (SC-006).

- [X] T014 [US1] Extend
  `packages/orchestrator/src/services/__tests__/redis-queue-adapter.script-wiring.test.ts`
  (FR-012). For each new script (`REQUEUE_FOR_RESUME_SCRIPT`,
  `RELEASE_SCRIPT`) add: static text assertions (contains `HGET`, `HDEL`,
  `ZADD`, `DEL`, and — for `RELEASE_SCRIPT` — `SREM` in correct order);
  `KEYS[N]` / `ARGV[N]` positional-reference assertions matching the
  contracts; `defineCommand('requeueForResumeItem', { numberOfKeys: 3, lua: REQUEUE_FOR_RESUME_SCRIPT })`
  and `defineCommand('releaseItem', { numberOfKeys: 5, lua: RELEASE_SCRIPT })`
  wire-up assertions using the existing minimal-mock harness pattern at
  `:77-158`; return-tuple shape assertion (script text contains
  `return {1, ...}` / `return {2, ...}` / `return {0, -1}` on the correct
  branches).

- [X] T015 [US1] Run the full `redis-queue-adapter.*` suite to verify no
  regressions in the existing files
  (`redis-queue-adapter.enqueueIfAbsent.test.ts`,
  `redis-queue-adapter.orphan-reclaim.test.ts`,
  `redis-queue-adapter.enqueue-invariant.test.ts`,
  `queue-adapter-parity.test.ts`, `redis-queue-adapter.reclaim-lua.test.ts`).
  SC-007 target: zero new failing tests. Invocation per
  `quickstart.md § Test invocation`:
  `pnpm --filter @generacy-ai/orchestrator test -- redis-queue-adapter`.

---

## Phase 4: Verification

<!-- Phase boundary: Complete Phases 1-3 before publishing. -->

- [X] T016 [US1] Verify SC-008 (`git diff packages/orchestrator/src/types/monitor.ts`
  shows no changes touching `release` or `requeueForResume`). Both methods
  MUST retain `Promise<void>` return contract per FR-008 — the fix is
  adapter-internal only.

- [X] T017 [US1] Deterministic-interleave baseline demonstration per
  `quickstart.md § Deterministic-interleave baseline`: `git worktree add ../generacy-1069-baseline HEAD~1`,
  `pnpm install`, `pnpm --filter @generacy-ai/orchestrator test -- redis-queue-adapter.release-atomic 2>&1 | tee ../1069-baseline-failure.log`
  (expected: deterministic-interleave `describe` block FAILS with
  `expect(ZCARD pending).toBe(1)` receiving `2`); switch back to the fixed
  worktree and re-run — expected: all pass. Copy the baseline-failure log
  into the PR description as reviewer evidence (Clarifications Q4 → C).
  Clean up: `git worktree remove ../generacy-1069-baseline`.

- [X] T018 [US1] Author `.changeset/1069-atomic-release-requeue-resume.md`
  with bump `'@generacy-ai/orchestrator': patch` per Decision 9 in
  `research.md`. Verify with `pnpm changeset status` (working-tree state;
  `pnpm changeset status --since=origin/develop` won't see the file until
  committed). If `pnpm why @generacy-ai/orchestrator` reveals a monorepo
  sibling that depends on the two methods' specific timing or log-line-count
  behaviour, upgrade to `minor` (not expected per SC-007 preserving
  existing behavioural coverage).

---

## Dependencies & Execution Order

**Phase boundaries** (sequential):

- **Phase 1 → Phase 2**: script constants + `ensureXCommand()` guards must
  exist before callers can invoke `(this.redis as any).releaseItem(...)` /
  `(this.redis as any).requeueForResumeItem(...)`.
- **Phase 2 → Phase 3**: caller rewrites must be in place before integration
  tests can exercise the end-to-end atomic path.
- **Phase 3 → Phase 4**: regressions verified before publishing / changeset.

**Sequential within Phase 1** (all in one file — `redis-queue-adapter.ts`):

- T001 → T002 → T003 → T004 → T005 → T006. Same file; sequential edits.

**Sequential within Phase 2**:

- T007 and T008 both edit `redis-queue-adapter.ts` (different methods but
  same file) — do sequentially. **T009 is `[P]`** (audits a different file,
  `in-memory-queue-adapter.ts`, and no source change expected).

**Parallel within Phase 3**:

- **T010, T011, T012, T013 are `[P]`** — four independent new test files, no
  shared dependencies. May run concurrently.
- **T014** modifies the existing `redis-queue-adapter.script-wiring.test.ts`
  — separate file from T010–T013 but touches a shared test file. Not marked
  `[P]` with the new files to avoid concurrent edits with any test-tooling
  refactor; sequential is fine.
- **T015** depends on T010 + T011 + T012 + T013 + T014 landing first — it's
  the "run everything" verification pass.

**Sequential within Phase 4**:

- T016 → T017 → T018 (verify interface diff → baseline demonstration →
  author changeset).

---

*Generated by speckit `/tasks` from `plan.md` on 2026-07-28.*
