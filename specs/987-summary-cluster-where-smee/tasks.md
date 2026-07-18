# Tasks: Flip monitors to webhook mode after smee receiver connects

**Input**: Design documents from `/specs/987-summary-cluster-where-smee/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/setter-contract.md, contracts/smee-receiver-contract.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = flip on connect; US2 = staleness/recovery safety net)

## Phase 1: Setup

- [ ] T001 [P] Add `SetWebhooksConfiguredOptions` interface + `setWebhooksConfigured(true, opts?)` method signature stubs in each monitor service file (empty method bodies) to unlock parallel work on FR-002 wiring. Files: `packages/orchestrator/src/services/label-monitor-service.ts`, `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`, `packages/orchestrator/src/services/merge-conflict-monitor-service.ts`, `packages/orchestrator/src/services/clarification-answer-monitor-service.ts`. Export the interface from each module (per data-model.md §"SetWebhooksConfiguredOptions").
- [ ] T002 [P] Update `MonitorState` JSDoc for `webhooksConfigured` and `lastWebhookEvent` fields in `packages/orchestrator/src/types/monitor.ts:187-211` to reflect the new runtime-mutation semantics (per data-model.md §"MonitorState").

## Phase 2: Core Implementation — FR-001 (runtime setter on all four monitor services)

- [ ] T010 [P] [US1] Implement `setWebhooksConfigured(configured: true, opts?)` body in `packages/orchestrator/src/services/label-monitor-service.ts`. Postconditions per contracts/setter-contract.md §"Postconditions": sets `state.webhooksConfigured = true`; sets both `state.basePollIntervalMs` and `state.currentPollIntervalMs` to `opts.basePollIntervalMs ?? state.basePollIntervalMs`; does NOT touch `options.adaptivePolling`. Add a one-line comment referencing Q1/Q2 rationale (per plan.md Constitution Check "load-bearing comment").
- [ ] T011 [P] [US1] Implement `setWebhooksConfigured(configured: true, opts?)` body in `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`. Same contract as T010.
- [ ] T012 [P] [US1] Implement `setWebhooksConfigured(configured: true, opts?)` body in `packages/orchestrator/src/services/merge-conflict-monitor-service.ts`. Same contract as T010.
- [ ] T013 [P] [US1] Implement `setWebhooksConfigured(configured: true, opts?)` body in `packages/orchestrator/src/services/clarification-answer-monitor-service.ts`. Same contract as T010.

## Phase 3: FR-003 — ClarificationAnswerMonitorService symmetry

- [ ] T020 [US1] In `packages/orchestrator/src/services/clarification-answer-monitor-service.ts`, extend the constructor (`:102-137`) with a 10th optional-with-default parameter `webhooksConfigured: boolean = false` (per data-model.md §"ClarificationAnswerMonitorService constructor"). Replace the hardcoded `webhooksConfigured: false` at `:135` with `webhooksConfigured,` (reading from the new parameter). No other constructor changes.
- [ ] T021 [US1, US2] In the same file, rewrite `recordWebhookEvent()` and `updateAdaptivePolling()` (`:404-432`) to delegate to `decideAdaptivePoll` from `packages/orchestrator/src/services/adaptive-poll-controller.ts`, matching the pattern used in `label-monitor-service.ts:574-621` (see research.md §"Question 6"). This makes FR-005's `webhook-stale` / `webhook-recovered` / `quiet` reasons reachable on the clarification monitor; without it, the flip is inert here.

## Phase 4: FR-002 + FR-004 — SmeeWebhookReceiver extensions

- [ ] T030 [US1, US2] In `packages/orchestrator/src/services/smee-receiver.ts`, extend `SmeeReceiverOptions` (`:23-37`) with:
  - `onConnected?: () => void` (per contracts/smee-receiver-contract.md §"`onConnected` callback"),
  - `prFeedbackMonitor?: PrFeedbackMonitorService`,
  - `mergeConflictMonitor?: MergeConflictMonitorService`,
  - `clarificationAnswerMonitor?: ClarificationAnswerMonitorService`.
  Store each new option on a `private readonly` field in the constructor (mirrors existing `monitorService` pattern). Add `private connectedOnceFired = false`.
- [ ] T031 [US1] In the same file, at the connect path (immediately after the existing `Connected to smee.io channel` log line at `:143`), invoke `this.options.onConnected?.()` guarded by `!this.connectedOnceFired`, then set `this.connectedOnceFired = true`. Wrap the call in `try/catch`; log a `warn` on thrown error and continue (per contracts/smee-receiver-contract.md §"Failure modes"). Subsequent reconnects must NOT re-fire.
- [ ] T032 [US2] In `processSSEEvent` in the same file, after the existing SSE-event-type / JSON / body / repo / `watchedRepos` guards (`:190-194` and following), fan out `recordWebhookEvent()` to all four monitor refs: `this.monitorService`, and each optional monitor ref if defined. Fan-out is unconditional on `x-github-event` type (per contracts/smee-receiver-contract.md §"Broad `recordWebhookEvent()` fan-out"). This must fire BEFORE any per-event processing dispatch so a processing error does not disable adaptive-poll health tracking.
- [ ] T033 [US1] In `processSSEEvent`, add per-event processing dispatch after the fan-out:
  - `x-github-event === 'pull_request_review' && action === 'submitted'` → build `PrReviewEvent` (payload shape per data-model.md §"pull_request_review") and call `this.prFeedbackMonitor?.processPrReviewEvent(event)`. Do NOT apply the assignee filter at the smee layer.
  - `x-github-event === 'pull_request_review_comment' && action === 'created'` → same `PrReviewEvent` shape sourced from `payload.pull_request`, same dispatch.
  - `x-github-event === 'issue_comment' && action === 'created'` → apply the existing smee-receiver assignee filter (`:224-241`), then build `ClarificationAnswerEvent` (payload shape per data-model.md §"issue_comment.created"; `source: 'poll'`) and call `this.clarificationAnswerMonitor?.processClarificationAnswerEvent(event)`.
  Existing `x-github-event === 'issues' && action === 'labeled'` label dispatch stays unchanged. Merge-conflict processing dispatch is intentionally NOT added (per research.md §"Question 5").

## Phase 5: Server wiring join point

- [ ] T040 [US1] In `packages/orchestrator/src/server.ts`:
  - At the `ClarificationAnswerMonitorService` construction site (`:649-659`), pass `config.smee.channelUrl != null` as the 10th positional argument, mirroring the `server.ts:493` pattern used for the other three (per FR-003).
  - At the `SmeeWebhookReceiver` construction site (`:503-507`), pass the three new optional monitor refs (`prFeedbackMonitor`, `mergeConflictMonitor`, `clarificationAnswerMonitor`) plus an `onConnected` callback.
  - Hold references to all four constructed monitors in a scope reachable from the `startSmeePipeline` closure.
  - In the `onConnected` callback, invoke `setWebhooksConfigured(true, { basePollIntervalMs: config.smee.fallbackPollIntervalMs })` on each of the four monitor refs (per FR-002 + plan.md §"Summary" step 2). Call unconditionally — the setter is idempotent (per contracts/setter-contract.md §"Idempotence").
  - `startSmeePipeline` continues to be called on all channel-source paths (static, persisted, provisioned) as today — no callsite-count change.

## Phase 6: Tests

- [ ] T050 [P] [US1, US2] In `packages/orchestrator/src/services/__tests__/label-monitor-service.test.ts`, add the six test cases enumerated in contracts/setter-contract.md §"Test cases":
  1. Flip flips flag (state fields update to expected values).
  2. `adaptivePolling` untouched after flip.
  3. Staleness still reachable post-flip (`reason: 'webhook-stale'`, `transition: 'to-fast'`, current interval = fast).
  4. Recovery still reachable (`reason: 'webhook-recovered'`, `transition: 'to-base'`, current = base).
  5. Idempotent double-flip (state after 2nd call === state after 1st call).
  6. Type-level `false` rejection via `@ts-expect-error`.
- [ ] T051 [P] [US1, US2] Add the same six test cases to `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts`.
- [ ] T052 [P] [US1, US2] Add the same six test cases to `packages/orchestrator/src/services/__tests__/merge-conflict-monitor-service.test.ts`.
- [ ] T053 [P] [US1, US2] Add the same six test cases to `packages/orchestrator/src/services/__tests__/clarification-answer-monitor-service.test.ts` PLUS a regression case for T021 (post-rewrite `updateAdaptivePolling` / `recordWebhookEvent` emit the `reason` strings expected by FR-005; the previous inline logic did not).
- [ ] T054 [US1, US2] Extend `packages/orchestrator/src/services/__tests__/smee-receiver.test.ts` with the seven test cases from contracts/smee-receiver-contract.md §"Test cases":
  1. `onConnected` fires exactly once across connect / disconnect / reconnect.
  2. `onConnected` never fires when receiver never connects (`fetch` rejects).
  3. Thrown `onConnected` callback is caught; receiver continues processing subsequent events.
  4. Broad fan-out: on any watched-repo event, `recordWebhookEvent()` called on all four monitor mocks.
  5. No fan-out on unwatched repo.
  6. `pull_request_review.submitted` → `prFeedbackMonitor.processPrReviewEvent` called with contract-correct payload shape.
  7. `pull_request_review_comment.created` → same dispatch.
  8. `issue_comment.created` on assigned issue → `clarificationAnswerMonitor.processClarificationAnswerEvent` called.
  9. `pull_request.synchronize` → `mergeConflictMonitor.recordWebhookEvent` called; NO processing call to any monitor (fan-out only).
  10. Optional monitors absent → no crashes; only required label monitor gets `recordWebhookEvent`.
- [ ] T055 [US1] Add an integration test (colocated with existing server tests under `packages/orchestrator/src/__tests__/`) that constructs `createServer()` with the auto-provisioned smee path (`config.smee.channelUrl = null`, `SmeeChannelResolver` stubbed to resolve a channel URL asynchronously), fires the `onConnected` callback via a stubbed receiver, and asserts (a) all four monitors report `state.webhooksConfigured === true`, (b) `state.currentPollIntervalMs === config.smee.fallbackPollIntervalMs`, (c) `state.basePollIntervalMs === config.smee.fallbackPollIntervalMs`, (d) no monitor emitted `reason: 'webhooks-not-configured'` after the flip. This is the SC-001 / SC-002 regression gate.

## Phase 7: Changeset

- [ ] T060 Add `.changeset/987-monitors-webhook-flip-on-connect.md` with a `patch` bump for `@generacy-ai/orchestrator` (defect fix per CLAUDE.md §Changesets and plan.md Constitution Check). Body: one-line description referencing #987 and the four monitors affected. Must be a newly added file in the PR diff (the changeset-bot gate greps `--diff-filter=A`).

## Phase 8: Verification

- [ ] T070 Run `pnpm -r --filter @generacy-ai/orchestrator build && pnpm -r --filter @generacy-ai/orchestrator test` locally. All four new setter test suites, the smee-receiver extension tests, and the integration test must pass.
- [ ] T071 Run `pnpm changeset status` and verify the new changeset is picked up. Confirm `.changeset/987-monitors-webhook-flip-on-connect.md` shows as an addition in `git status --diff-filter=A`.
- [ ] T072 Smoke-check via `quickstart.md` steps (if present in the spec directory) — construct a receiver + all four monitors in a test harness, fire a synthetic connect and a synthetic `pull_request_review.submitted`, assert the flip and dispatch paths behave per the SC-001 / SC-004 targets.

## Dependencies & Execution Order

**Sequential phase boundaries**:
- Phase 1 (setup — signature stubs + JSDoc) must complete before Phase 2 (bodies).
- Phase 2 (FR-001 bodies on all four services) + Phase 3 (FR-003 clarification symmetry) can proceed in parallel — different files.
- Phase 4 (smee-receiver extensions) depends on Phase 2 setters existing so the fan-out call sites compile (Phase 1 stubs unblock this, but Phase 4 tests will fail until Phase 2 bodies land).
- Phase 5 (server.ts wiring) is the join point — depends on Phase 2, Phase 3, and Phase 4 all having landed API-compatibly.
- Phase 6 (tests) depends on Phase 5 for the integration test; per-service unit tests can start after Phase 2 / Phase 3 / Phase 4 respectively land.
- Phase 7 (changeset) can be authored at any time but must be committed before opening the PR.
- Phase 8 (verification) runs last.

**Parallel opportunities within phases**:
- T001 + T002 in Phase 1 are independent.
- T010, T011, T012, T013 in Phase 2 are independent (four different files, identical shape).
- T020 + T021 in Phase 3 touch the same file — sequential (T020 first, then T021).
- T030 through T033 in Phase 4 touch the same file — sequential.
- T050 through T053 in Phase 6 are independent (four different test files).

**Critical path**:
T001 → T010/T011/T012/T013 (parallel) → T030 → T031 → T032 → T033 → T040 → T055 → T070 → T071 → T072.

*Generated by speckit*
