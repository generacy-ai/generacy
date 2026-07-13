# Tasks: Pair resume-event dedupe with pause lifecycle so same-gate re-visits are not stranded

**Input**: Design documents from `/specs/849-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/clear-resume-dedupe-callback.md, contracts/on-gate-hit-pairing.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, or blank for cross-cutting infra)

## Phase 1: Type + Interface Changes (Core)

- [X] T001 [US1] Add `ClearResumeDedupeCallback` exported type alias to `packages/orchestrator/src/worker/label-manager.ts` (JSDoc-annotated per data-model.md §New types). Signature: `(gate: string) => Promise<void>`.
- [X] T002 [US1] Extend `LabelManager` constructor in `packages/orchestrator/src/worker/label-manager.ts:15-22` with new optional last-position `readonly clearResumeDedupe?: ClearResumeDedupeCallback` parameter. Preserves backwards-compat with `label-manager.test.ts:21` and any other construction sites.
- [X] T003 [US1] Extend `ClaudeCliWorkerDeps` interface in `packages/orchestrator/src/worker/claude-cli-worker.ts:107-114` with optional `phaseTracker?: PhaseTracker` field (import `PhaseTracker` from `../types/monitor.js` — same path as `label-monitor-service.ts`). Store on `this.phaseTracker` in the constructor.

## Phase 2: `onGateHit` Paired-Clear Implementation (Core)

- [X] T010 [US1] Modify `LabelManager.onGateHit()` in `packages/orchestrator/src/worker/label-manager.ts:78-97` per plan.md §Design Overview §onGateHit. After `await this.retryWithBackoff(...)` returns success:
  - Guard `if (this.clearResumeDedupe)`.
  - Derive `gateSuffix` from `gateLabel` (strip `waiting-for:` prefix if present; fall back to raw `gateLabel` — defensive per plan.md).
  - Wrap `await this.clearResumeDedupe(gateSuffix)` in a try/catch (FR-010: one-shot best-effort; FR-003: never blocks pause).
  - On success: `logger.info({ phase, gateLabel, owner, repo, issueNumber }, 'Cleared paired resume dedupe on pause')` (FR-011).
  - On catch: `logger.warn({ phase, gateLabel, owner, repo, issueNumber, error: String(error) }, 'Failed to clear paired resume dedupe on pause (non-fatal, TTL backstop will absorb)')` (FR-011).
  - **Ordering (FR-009)**: MUST run AFTER `retryWithBackoff` returns; if `addLabels` exhausts retries and throws, this code path never executes.

## Phase 3: Wiring (Core)

- [X] T020 [US1] Modify `ClaudeCliWorker` at `packages/orchestrator/src/worker/claude-cli-worker.ts:406` (the `new LabelManager(...)` site) to pass a paired-clear closure per plan.md §Worker wiring:
  - When `this.phaseTracker` is present: pass `(gateSuffix: string) => this.phaseTracker!.clear(item.owner, item.repo, item.issueNumber, `resume:${gateSuffix}`)` as the 6th constructor arg.
  - When `this.phaseTracker` is `undefined`: pass `undefined` (pre-fix behavior; paired-clear skipped).
- [X] T021 [US1] Modify `packages/orchestrator/src/server.ts` worker-mode boot branch (~line 291) to instantiate `PhaseTrackerService` when `redisClient` is available and thread it into `ClaudeCliWorker` via `ClaudeCliWorkerDeps.phaseTracker`. Mirrors the full-mode instantiation at line 347. Both instances share the same Redis keyspace, so worker-mode `clear(resume:<gate>)` invalidates the key written by full-mode `markProcessed(resume:<gate>)`.

## Phase 4: Unit Tests — `label-manager.test.ts`

- [X] T030 [US1] In `packages/orchestrator/src/worker/__tests__/label-manager.test.ts`, extend `createLabelManager()` helper (or add a variant) so tests can pass a `vi.fn()` stub for `clearResumeDedupe`. Keep the no-callback path (default) available for existing tests.
- [X] T031 [US1] Add test "invokes clearResumeDedupe with gate suffix after successful onGateHit" — call `onGateHit('implement', 'waiting-for:implementation-review')`; assert stub called exactly once with `'implementation-review'` AFTER `github.addLabels` succeeded. Covers FR-001, FR-002 (first call), contract §Semantic contract step 2.
- [X] T032 [US1] Add test "invokes clearResumeDedupe on every onGateHit call (second pause in same cycle)" — call `onGateHit` twice with identical `(phase, gateLabel)`; assert stub fired on BOTH calls. Covers FR-002 second-pause safety.
- [X] T033 [US1] Add test "does NOT invoke clearResumeDedupe when addLabels exhausts retries" — mock `github.addLabels` to throw on all 3 retries; assert `onGateHit` rejects AND stub was never called. Covers FR-009 asymmetric partial failure.
- [X] T034 [US1] Add test "swallows clearResumeDedupe rejection and still resolves" — stub rejects with synthetic error; assert `onGateHit` resolves (no re-throw); assert `logger.warn` called with fields `{ phase, gateLabel, owner, repo, issueNumber, error }` and message matching `'Failed to clear paired resume dedupe on pause'`. Covers FR-003, FR-010, FR-011 warn path, SC-004.
- [X] T035 [US1] Add test "logs info on successful paired-clear" — stub resolves; assert `logger.info` called with fields `{ phase, gateLabel, owner, repo, issueNumber }` and message `'Cleared paired resume dedupe on pause'`. Covers FR-011 info path, SC-002 log-grep gate.
- [X] T036 [US3] Add test "absent callback → no paired-clear, no log, pause unchanged" — construct `LabelManager` without the 6th arg; call `onGateHit`; assert labels applied AND no info/warn line matching the paired-clear message emitted. Backwards-compat regression guard.
- [X] T037 [US1] Strips prefix correctly: verify the derivation logic — call with `gateLabel: 'waiting-for:clarify-review'` → stub called with `'clarify-review'`; call with `gateLabel: 'clarify-review'` (no prefix) → stub called with `'clarify-review'`. Guards the `startsWith('waiting-for:')` defensive check in plan.md.

## Phase 5: Unit Tests — `phase-tracker-service.test.ts`

- [X] T040 [P] [US3] In `packages/orchestrator/src/services/__tests__/phase-tracker-service.test.ts`, add case "clear() then isDuplicate() returns false" — call `markProcessed(owner, repo, issue, 'resume:foo')`, assert `isDuplicate → true`, call `clear(owner, repo, issue, 'resume:foo')`, assert `isDuplicate → false`. Backstop-of-the-backstop for SC-003 / FR-006. (Added to pre-existing test at `packages/orchestrator/tests/unit/services/phase-tracker-service.test.ts` rather than creating a duplicate file.)

## Phase 6: Integration Test — `pr-feedback-integration.test.ts`

- [X] T050 [US1] In `packages/orchestrator/src/__tests__/pr-feedback-integration.test.ts`, add the FR-007 / SC-001 scenario per plan.md §Technical Context. Sequence (using existing `ioredis-mock` wiring in that suite):
  1. Drive the workflow to pause at `waiting-for:implementation-review` (cycle 1).
  2. Simulate `completed:implementation-review` label → resume enqueues → assert `markProcessed('resume:implementation-review')` wrote the key.
  3. Drive worker to pause at `waiting-for:address-pr-feedback`.
  4. Simulate `completed:address-pr-feedback` → resume enqueues.
  5. Drive worker to pause at `waiting-for:implementation-review` **again** (cycle 2). Assert paired-clear ran (key absent post-`onGateHit`).
  6. Simulate `completed:implementation-review` → **assert the second resume enqueues** (no "Duplicate event detected" log line, no `isDuplicate` short-circuit).
  (Landed as a dedicated integration file at `packages/orchestrator/src/__tests__/paired-resume-dedupe-clear.integration.test.ts` so the scenario stays isolated from the address-pr-feedback webhook fixtures. Uses real `PhaseTrackerService` + `ioredis-mock` + real `LabelMonitorService.processLabelEvent` + real `LabelManager.onGateHit`.)
- [X] T051 [US3] In the same integration file, add the FR-008 single-cycle non-regression case: after step 5 above (pause 2), fire two back-to-back `completed:implementation-review` events; assert the FIRST enqueues, the SECOND is deduped. Guards single-cycle dedupe protection (FR-008, SC-003).

## Phase 7: Validation / Polish

- [X] T060 [P] Run `pnpm -r typecheck` (or workspace-scoped equivalent for `packages/orchestrator`) — must pass with zero new errors. Result: exit 0.
- [X] T061 [P] Run `pnpm --filter @generacy-ai/orchestrator test` — must pass, including the new test cases from Phase 4/5/6. Result: all new tests pass (label-manager 28/28, phase-tracker-service 10/10, paired-resume-dedupe integration 2/2). Verified 18 pre-existing unrelated failures (activation/relay-bridge/webhook-setup) are present before AND after this change (confirmed via `git stash` + re-run) — zero new failures introduced.
- [ ] T062 [manual] Manually verify the log-grep gate for SC-002: with the fix built and running against a repro cluster (per quickstart.md), assert `'Cleared paired resume dedupe on pause'` appears on every `waiting-for:*` label application. Manual step; not a test file.

## Dependencies & Execution Order

**Sequential dependencies**:
- Phase 1 (T001, T002, T003) → Phase 2 (T010) → Phase 3 (T020, T021)
  - T010 depends on T001+T002 (new type + ctor arg must exist before it can be called).
  - T020 depends on T002+T003 (needs both the `LabelManager` new arg and the `ClaudeCliWorkerDeps.phaseTracker` field).
  - T021 depends on T003 (needs `ClaudeCliWorkerDeps.phaseTracker` in the type).
- Phase 4 (T030–T037) depends on T010 (tests exercise the new `onGateHit` code path).
- Phase 6 (T050, T051) depends on Phase 3 (integration test exercises the wired-up worker with a real `PhaseTrackerService`).
- Phase 7 (T060, T061) depends on Phases 1–6 being complete.
- T062 depends on the build being green (T060+T061).

**Parallel opportunities**:
- T001, T002, T003 can be edited in any order but touch two files (`label-manager.ts`, `claude-cli-worker.ts`) — a single commit is cleaner.
- T031–T037 (label-manager tests) are all in the same file — write serially in one editing session, but each case is independent behavior.
- T040 [P] (phase-tracker-service.test.ts) is fully independent of the label-manager work — can be written and run in parallel with Phase 4.
- T060 [P] and T061 [P] are independent CI checks.

**Critical path**: T001 → T002 → T010 → T020 → T021 → T050 → T061 → T062. Estimated ~180 LOC total (40 production, 140 tests) per plan.md §Scale/Scope.

**Non-changes to guard (regression risk)**:
- `PhaseTrackerService` interface + implementation UNCHANGED.
- `label-monitor-service.ts:273-282` (`process` clear pattern) UNCHANGED (FR-005).
- `label-monitor-service.ts:339` (`markProcessed` after enqueue) UNCHANGED.
- Default TTL 86400s UNCHANGED (FR-006).
- Redis key layout UNCHANGED.

---

*Generated by speckit — tasks phase for #849.*
