# Tasks: Fix double-space in `formatTierLimitError` when tier name is unknown

**Input**: Design documents from `/specs/728-symptom-cli-s-resolver/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [ ] T001 [US1] Update `formatTierLimitError` in `packages/activation-client/src/format-tier-limit-error.ts` to conditionally omit the tier-name segment when `tier` is falsy. Build the qualifier as a local: `const planQualifier = tier ? \`${tier.charAt(0).toUpperCase() + tier.slice(1)} plan\` : 'plan';`, then return a single template literal `\`Worker count of ${requested} exceeds your ${planQualifier} limit of ${cap}. Upgrade your plan or retry with --workers=${cap}.\``. Preserve current title-case behavior for non-empty `tier`. (FR-001, FR-002)

## Phase 2: Test Updates

- [ ] T002 [US1] Update the existing `'handles empty tier (degenerate, degrades acceptably)'` test in `packages/activation-client/tests/unit/format-tier-limit-error.test.ts` to assert the new well-formed output (no double space): `Worker count of 5 exceeds your plan limit of 2. Upgrade your plan or retry with --workers=2.`. Add a regression assertion (in the same test or as a new sibling test) that the result does not contain the substring `'  '` (two consecutive spaces). Verify existing non-empty-tier tests and the "is pure" test pass unmodified. (FR-003, SC-003)

## Phase 3: Validation

- [ ] T003 [US1] [US2] Run `pnpm --filter @generacy-ai/activation-client test` and `pnpm -w typecheck` from the repo root. Confirm all tests in `format-tier-limit-error.test.ts` pass (including the updated empty-tier assertion and the new no-double-space regression), and that no call sites need changes (`worker-count-resolver.ts`, orchestrator activation, deploy command remain untouched per FR-004). (SC-001, SC-002)

## Dependencies & Execution Order

**Sequential dependency chain** (single-file fix, no parallel work):
- T001 (source change) → T002 (test update reflects new behavior) → T003 (validate)

T001 and T002 touch different files and could in principle run in parallel, but T002's assertions are derived directly from T001's chosen template — running them in order keeps the assertion text aligned with the implementation. No `[P]` markers are used.

## Notes

- Scope is intentionally tiny: ~3 LOC of source change in one file, one test update, one regression assertion. The fix is strictly subtractive in behavior (removes a stray space) and additive only in a single conditional branch.
- Out-of-scope (do NOT touch in this feature): adding `tier` to cloud `launch-config`, changing `TierLimitErrorInput.tier` to `string | undefined`, any call-site edits in `worker-count-resolver.ts`, orchestrator activation, or the `deploy` command.
