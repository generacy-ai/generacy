# Tasks: Engage adaptive polling for clusters with no configured webhook

**Input**: Design documents from `/specs/953-summary-updateadaptivepolling/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/adaptive-poll-controller.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to — all tasks map to US1 (single-story bugfix)

## Phase 1: Types & State Model

- [X] T001 [US1] Add `webhooksConfigured: boolean` to `MonitorState` in `packages/orchestrator/src/types/monitor.ts` (per data-model.md §`MonitorState`; JSDoc distinguishes from `webhookHealthy`).

## Phase 2: Shared Helper (Contract-First)

<!-- Phase boundary: T001 must land first — helper imports `MonitorState` shape indirectly via param object -->

- [X] T002 [P] [US1] Create `packages/orchestrator/src/services/adaptive-poll-controller.ts` exporting `AdaptivePollParams`, `AdaptivePollDecision`, `AdaptivePollReason`, `decideAdaptivePoll()`, and `computeFastInterval()` per `contracts/adaptive-poll-controller.md`. Pure function — no `Date.now()`, no I/O, `nowMs` on params.
- [X] T003 [P] [US1] Create `packages/orchestrator/src/services/__tests__/adaptive-poll-controller.test.ts` covering the 7-row test matrix from contract §Test Matrix plus the recovery-path row. MUST include a base+divisor combination where `basePoll / divisor > minPoll` so the clamp does not bind (recommended `basePoll=60_000, divisor=3, min=10_000 → fast=20_000`).

## Phase 3: Per-Service Integration

<!-- Phase boundary: T002 must land — all three services import `decideAdaptivePoll` -->

- [X] T004 [US1] Modify `packages/orchestrator/src/services/label-monitor-service.ts`: add `webhooksConfigured` constructor arg, initialize `state.webhooksConfigured`, replace body of `updateAdaptivePolling()` (line ~588) with a call to `decideAdaptivePoll()`, apply decision to `state` (interval + `webhookHealthy`), emit existing log line only when `transition !== 'none'`. Update `recordWebhookEvent()` (line ~571) to also delegate to `decideAdaptivePoll()` for the recovery path. Preserve `ADAPTIVE_DIVISOR = 3`.
- [X] T005 [US1] Modify `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`: add `webhooksConfigured` constructor arg (callers pass `false`), same three edits as T004. Preserve `ADAPTIVE_DIVISOR = 2` and existing per-service log string ("increasing PR feedback poll frequency").
- [X] T006 [US1] Modify `packages/orchestrator/src/services/merge-conflict-monitor-service.ts`: add `webhooksConfigured` constructor arg (callers pass `false`), same three edits as T004. Preserve `ADAPTIVE_DIVISOR = 2` and existing per-service log string ("increasing merge-conflict poll frequency"). Note: `recordWebhookEvent()` at line ~332 has no callers, but keep the delegate for symmetry/future feeder.

## Phase 4: Config Schema & Server Wiring

<!-- Phase boundary: Services must accept the new arg (T004–T006) before server passes it -->

- [X] T007 [P] [US1] Flip `PrMonitorConfigSchema.adaptivePolling` default from `true` to `false` in `packages/orchestrator/src/config/schema.ts` (line ~143). Add inline comment: `// #953: silently doubled GH API load; opt-in via PR_MONITOR_ADAPTIVE_POLLING=true`. `MonitorConfigSchema.adaptivePolling.default(true)` stays.
- [X] T008 [US1] Wire `webhooksConfigured` at all three constructor callsites in `packages/orchestrator/src/server.ts` (lines ~464-529): LabelMonitor gets `config.smee.channelUrl != null`; PrFeedback gets `false` with `// #953: no reliable feeder signal available at construction`; MergeConflict gets `false` with `// #953: recordWebhookEvent() has no callers anywhere`. Do not touch the `server.ts:469-471` smee-configured override (already sets `adaptivePolling: false` on that path).

## Phase 5: Per-Service Adaptive Tests

<!-- Phase boundary: T004–T008 must land — tests exercise the integrated services -->

- [X] T009 [P] [US1] Create/modify `packages/orchestrator/src/services/__tests__/label-monitor-adaptive.test.ts`: `webhooksConfigured=false, adaptivePolling=true` → `state.currentPollIntervalMs === basePoll / 3` (clamped) on cycle 1, exactly one `info` log line. `webhooksConfigured=false, adaptivePolling=false` → interval stays at base indefinitely. `webhooksConfigured=true, lastWebhookEvent=null` → no-op (grace preserved). Use clamp-safe base (e.g., 60s, not the default 30s) for the divide assertion.
- [X] T010 [P] [US1] Create/modify `packages/orchestrator/src/services/__tests__/pr-feedback-adaptive.test.ts`: default `adaptivePolling=false` → interval stays at 60s. Opt-in `adaptivePolling=true` → interval drops to `basePoll / 2` (clamped to min) on cycle 1, one log line. Verify divisor is 2, not 3.
- [X] T011 [P] [US1] Create/modify `packages/orchestrator/src/services/__tests__/merge-conflict-adaptive.test.ts`: mirror of T010 with merge-conflict log string ("increasing merge-conflict poll frequency").
- [X] T012 [US1] Grep existing tests for log strings that assert on the pre-fix "no data, healthy" silence on `LabelMonitor`; update any that break (plan.md §Risks item 3 estimates fewer than 10 files). Run `pnpm --filter @generacy-ai/orchestrator test` and confirm green.

## Phase 6: Changeset & Release Notes

<!-- Phase boundary: All source changes must land — changeset describes the shipped delta -->

- [X] T013 [US1] Add `.changeset/953-adaptive-polling.md` — `patch` bump for `@generacy-ai/orchestrator`. Body MUST call out the two operator-visible facts: (a) `PrMonitorConfigSchema.adaptivePolling` default flips `true → false` (opt in via `PR_MONITOR_ADAPTIVE_POLLING=true`); (b) smee-less LabelMonitor clusters now emit a `to-fast` transition log line on cycle 1 where previously they emitted nothing. Copy the shape of a comparable existing changeset in `.changeset/`.

## Dependencies & Execution Order

**Sequential phase boundaries**:
- Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6

**Parallelizable within phases**:
- Phase 2: T002 and T003 in parallel (different files; TDD ordering is optional — helper impl and tests can co-develop).
- Phase 3: T004, T005, T006 sequentially by convention (touch related three files; can also run in parallel if reviewers can hold three service PRs simultaneously — but a single PR ships all three per this bugfix's scope).
- Phase 4: T007 and T008 in parallel (schema file vs. server file).
- Phase 5: T009, T010, T011 in parallel (three separate test files). T012 sequential after them.

**Critical dependencies**:
- T001 blocks T002 (helper's params reference state shape).
- T002 blocks T004, T005, T006 (services import the helper).
- T004–T006 block T008 (server passes the new constructor arg).
- T004–T008 block T009–T012 (integration tests exercise the wired code).
- All source tasks block T013 (changeset describes the final delta).

**Testing gate**: T003 (helper unit tests) is the load-bearing regression per FR-007 and contract §Test Matrix. Land it green before merging service changes.
