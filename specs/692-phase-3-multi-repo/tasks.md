# Tasks: Phase 3 Multi-Repo Review Coordination

**Input**: Design documents from `/specs/692-phase-3-multi-repo/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Type Extensions & Utilities

- [X] T001 [P] [US1] Create `packages/orchestrator/src/worker/linked-pr-url-parser.ts` — pure function `parsePRUrl(url: string): ParsedPRUrl | null` with regex `/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<number>\d+)/`. Export `ParsedPRUrl` interface (`owner`, `repo`, `number`).
- [X] T002 [P] [US1] Create `packages/orchestrator/src/worker/__tests__/linked-pr-url-parser.test.ts` — test cases: valid GitHub PR URL, HTTPS with trailing slash, non-GitHub URL returns null, malformed path returns null, cross-org URL.
- [X] T003 [P] [US2] Extend `GateDefinition.condition` union in `packages/orchestrator/src/worker/types.ts:105` — add `'on-sibling-review'` to the union type. Add optional `linkedPRs?: LinkedPR[]` to `WorkerContext` at line ~256 (import `LinkedPR` from `@generacy-ai/workflow-engine`).
- [X] T004 [P] [US2] Extend `GateDefinitionSchema` in `packages/orchestrator/src/worker/config.ts:13` — add `'on-sibling-review'` to the `z.enum()`. Add new gate entry `{ phase: 'implement', gateLabel: 'waiting-for:sibling-review', condition: 'on-sibling-review' }` to `speckit-feature` defaults at line ~38.

## Phase 2: Core Implementation

- [X] T005 [P] [US2] Create `packages/orchestrator/src/worker/sibling-review-checker.ts` — export `checkSiblingReviews(linkedPRs, github, logger): Promise<SiblingReviewResult>`. For each linked PR: parse URL with `parsePRUrl()`, call `gh pr view --json reviewDecision` via `github.executeCommand()`, check `reviewDecision === 'APPROVED'`. Return `{ allApproved, statuses[] }`. Empty/undefined `linkedPRs` → `{ allApproved: true, statuses: [] }`.
- [X] T006 [P] [US2] Create `packages/orchestrator/src/worker/__tests__/sibling-review-checker.test.ts` — test cases: all approved, one not approved, empty linkedPRs (vacuous truth), invalid URL skipped with warning, `gh pr view` failure treated as not-approved.
- [X] T007 [US2] Add `checkGates()` method to `GateChecker` in `packages/orchestrator/src/worker/gate-checker.ts` — change `find` to `filter`, return `GateDefinition[]`. Keep existing `checkGate()` for backward compat.
- [X] T008 [US2] Extend `packages/orchestrator/src/worker/__tests__/gate-checker.test.ts` — add tests for `checkGates()`: two gates on same phase both returned, single gate still works, no gates returns empty array.

## Phase 3: Integration

- [X] T009 [US1] Extend `markReadyForReview()` in `packages/orchestrator/src/worker/pr-manager.ts` — accept optional `linkedPRs?: LinkedPR[]` parameter. After marking primary PR ready, iterate linkedPRs, parse each URL with `parsePRUrl()`, call `gh pr ready <owner>/<repo> --pr <number>` (idempotent). Best-effort: log warnings on failure, don't fail workflow.
- [X] T010 [US2] Refactor gate evaluation in `packages/orchestrator/src/worker/phase-loop.ts:403-494` — replace `checkGate()` with `checkGates()`, iterate all returned gates. For `on-sibling-review` condition: call `checkSiblingReviews(context.linkedPRs)`. When gate activates, flip all siblings to ready-for-review (call `prManager.markSiblingsReadyForReview()` or inline loop) before pausing. Existing `always` and `on-questions` conditions unchanged.
- [X] T011 [US2] Thread `linkedPRs` in `packages/orchestrator/src/worker/claude-cli-worker.ts` — after phase-after handlers run (line ~449), load `linkedPRs` from workflow state store (via `WorkflowState` from `@generacy-ai/workflow-engine`). Assign to `context.linkedPRs`. Pass `context.linkedPRs` to `prManager.markReadyForReview()` at line ~490.

## Dependencies & Execution Order

**Phase 1** (T001–T004): All parallelizable — type extensions and pure utility function with no interdependencies.

**Phase 2** (T005–T008): T005 depends on T001 (imports `parsePRUrl`). T006 depends on T005. T007 and T008 are independent of T005/T006 but depend on T003/T004 for the new condition type. T005+T006 can run in parallel with T007+T008.

**Phase 3** (T009–T011): T009 depends on T001 (URL parsing). T010 depends on T005 (sibling checker) and T007 (multi-gate). T011 depends on T003 (WorkerContext type) and T009/T010 (integration wiring). T009 can start as soon as Phase 1 is done.

**Parallel opportunities**:
- T001 ∥ T002 ∥ T003 ∥ T004 (all independent)
- T005+T006 ∥ T007+T008 (different files)
- T009 can start as soon as T001 completes
