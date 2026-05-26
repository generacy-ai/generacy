# Tasks: Handle `tier-limit-exceeded` PollResponse Variant

**Input**: Design documents from `/specs/726-problem-generacy-cloud-700/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = orchestrator surface, US2 = deploy surface, US3 = shared wording)

## Phase 1: Setup

- [ ] T001 Add `@generacy-ai/activation-client` (`workspace:*`) to `dependencies` in `packages/generacy/package.json`. The CLI's deploy command already imports from this package; this promotes the existing edge to an explicit declaration so the launch command can import the shared formatter (per research Decision 5).

## Phase 2: Foundation (Shared schema, error code, formatter)

These changes underlie every user story — schema must accept the variant before any caller can branch on it; the formatter must exist before any caller can produce a consistent message.

- [ ] T010 [US1, US2, US3] Extend `PollResponseSchema` discriminated union in `packages/activation-client/src/types.ts` with the `tier-limit-exceeded` variant: `{ status: z.literal('tier-limit-exceeded'), cap: z.number().int().min(0), requested: z.number().int().min(1), tier: z.string() }`. See data-model.md §`PollResponseSchema (modified)`.

- [ ] T011 [P] [US1] Extend the `ActivationErrorCode` union in `packages/activation-client/src/errors.ts` with `'TIER_LIMIT_EXCEEDED'`. Additive union member only; no other changes to the `ActivationError` class.

- [ ] T012 [P] [US1, US2, US3] Create `packages/activation-client/src/format-tier-limit-error.ts` exporting `TierLimitErrorInput` interface (`{ requested: number; cap: number; tier: string }`) and `formatTierLimitError(input)` function. Title-case the tier name via `tier.charAt(0).toUpperCase() + tier.slice(1)`. Output format: `Worker count of <requested> exceeds your <Tier> plan limit of <cap>. Upgrade your plan or retry with --workers=<cap>.` See contracts/format-tier-limit-error.md.

- [ ] T013 Re-export `formatTierLimitError` and the `TierLimitErrorInput` type from `packages/activation-client/src/index.ts` so orchestrator and CLI consumers can import them from the package root.

- [ ] T014 [US1, US2] Add `case 'tier-limit-exceeded': return response;` branch to the `switch (response.status)` statement in `packages/activation-client/src/poller.ts` (alongside `approved` and `expired`). Terminal pass-through, no logging. Update the `pollForApproval` JSDoc to enumerate `'tier-limit-exceeded'` alongside `'approved'` and `'expired'` as terminal statuses.

## Phase 3: User Story Surfaces

Both branches gate on the same status and use the same formatter; they can land in parallel because they touch different files.

- [ ] T020 [P] [US1] In `packages/orchestrator/src/activation/index.ts`, after the `pollForApproval` call (~line 79) and **before** the existing `if (pollResult.status === 'approved')` check, add an `if (pollResult.status === 'tier-limit-exceeded')` branch that throws `new ActivationError(formatTierLimitError({ requested: pollResult.requested, cap: pollResult.cap, tier: pollResult.tier }), 'TIER_LIMIT_EXCEEDED')`. The existing try/catch in `server.ts` catches it and pushes an `error` status via the relay (no `server.ts` change required).

- [ ] T021 [P] [US2] In `packages/generacy/src/cli/commands/deploy/activation.ts`, after the `pollForApproval` call (~line 59) and **before** the existing `if (pollResult.status === 'approved')` check, add an `if (pollResult.status === 'tier-limit-exceeded')` branch that calls `console.error(formatTierLimitError({ ... }))` and then `process.exit(1)`. Do **not** throw — bypass the existing `DeployError` wrapping (per research Decision 9, to avoid `Activation failed: ...` double-prefix).

- [ ] T022 [US3] Refactor `packages/generacy/src/cli/commands/launch/worker-count-resolver.ts` to replace the inline `throw new Error('--workers=N exceeds tier cap of M…')` (~lines 47–52) with `throw new Error(formatTierLimitError({ requested, cap, tier }))`. Drop the context-dependent CLI-fallback suffix from the rejection message — the fallback warning is still emitted separately via `WorkerCountResolution.warnings` (per research Decision 4).

## Phase 4: Tests

All tests can run in parallel after the production code lands; they touch independent test files.

- [ ] T030 [P] [US1, US2] Extend `packages/activation-client/tests/unit/types.test.ts` with a case asserting `PollResponseSchema.parse({ status: 'tier-limit-exceeded', cap: 5, requested: 10, tier: 'basic' })` succeeds and exposes the fields. Add a negative case (e.g., missing `cap`) to confirm Zod rejects malformed variants.

- [ ] T031 [P] [US1, US2] Extend `packages/activation-client/tests/unit/poller.test.ts` with a case asserting that when `pollDeviceCode` returns `{ status: 'tier-limit-exceeded', ... }`, `pollForApproval` returns the response immediately (no re-poll, no log line). Covers FR-008 / SC-001.

- [ ] T032 [P] [US3] Create `packages/activation-client/tests/unit/format-tier-limit-error.test.ts` covering: (a) exact message body for sample inputs (`basic`, `pro`, `enterprise`); (b) title-casing of the first character only; (c) graceful behavior on multi-word tiers like `pro-plus` → `Pro-plus`. Covers FR-009.

- [ ] T033 [P] [US3] Update existing over-cap assertions in `packages/generacy/src/cli/commands/launch/__tests__/worker-count-resolver.test.ts` to expect the new shared message from `formatTierLimitError(...)`. Add a negative grep / assertion verifying no inline `"tier cap"` or `"plan limit"` string interpolation remains in the resolver (supports SC-002).

## Dependencies & Execution Order

**Sequential gates**:
- T001 (Phase 1) → T012 (Phase 2): formatter file can be created independently, but T020/T021/T022 cannot import from `@generacy-ai/activation-client` in the CLI workspace until T001 lands.
- T010, T011, T012, T013 (Phase 2 foundation) → T020, T021, T022 (Phase 3 callers): each caller imports the schema variant, the error code, and the formatter.
- T014 (poller branch) → T031 (poller test): test asserts the new switch behavior.
- T013 (index re-export) → T020/T021/T022: callers import `formatTierLimitError` from `@generacy-ai/activation-client`.
- T022 (resolver refactor) → T033 (resolver test): test assertion follows refactor.

**Parallel opportunities**:
- T011 ‖ T012: errors.ts and format-tier-limit-error.ts are independent files.
- T020 ‖ T021: orchestrator and deploy callers live in different packages.
- T022 may also run in parallel with T020/T021 once Phase 2 is complete (different file).
- All Phase 4 tests (T030, T031, T032, T033) run in parallel once their respective production code lands.

**Suggested order for a single agent**:
1. T001 — package.json dep
2. T010, T011, T012 — schema, error code, formatter (any order)
3. T013 — index re-export
4. T014 — poller switch branch
5. T020, T021, T022 — caller branches (any order; can parallelize across agents)
6. T030, T031, T032, T033 — tests (parallel)

## Acceptance Mapping

| Spec acceptance criterion / FR / SC | Covered by tasks |
|--------------------------------------|------------------|
| FR-001 (schema variant) / SC-001 | T010 |
| FR-002 (poller terminal branch) | T014 |
| FR-003 (poller JSDoc) | T014 |
| FR-004 (orchestrator throws `ActivationError('TIER_LIMIT_EXCEEDED')`) / SC-003 | T011, T013, T020 |
| FR-005 (deploy exits 1 on stderr) | T013, T021 |
| FR-006 (shared formatter exported from `@generacy-ai/activation-client`) | T012, T013 |
| FR-007 (resolver refactored to formatter) / SC-002 | T001, T013, T022 |
| FR-008 (poller regression test) | T030, T031 |
| FR-009 (formatter unit test) | T032 |
| SC-004 (existing happy paths unchanged) | T014 (additive switch case), T030/T031 (covers existing cases via existing tests) |
