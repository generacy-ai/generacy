# Tasks: Zero-question clarify phase must not strand an issue

**Input**: Design documents from `/specs/1246-problem-if-clarify-phase/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/has-pending-clarifications.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [ ] T001 [US1] Narrow the `readFileSync` catch in `hasPendingClarifications`
  (`packages/orchestrator/src/worker/clarification-poster.ts:495`): add an optional
  trailing `logger?: Logger` parameter (the pino-style `Logger` already imported from
  `./types.js`), and inside the existing catch discriminate on
  `(err as NodeJS.ErrnoException).code === 'ENOENT'`. On `ENOENT` → emit one info log
  `{ issueNumber, clarificationsPath }` with message
  `no clarifications.md — clarify produced no questions; gate will skip` and `return false`
  (FR-001, FR-002). Any other/absent `code` → `return true` (FR-004, #958 fail-closed).
  Leave all other branches untouched: missing spec dir → `true` (FR-003), empty file →
  `false` (FR-006), non-empty-zero-parse → `true` (FR-005). Decision table:
  `contracts/has-pending-clarifications.md`.

- [ ] T002 [US1] Pass the phase-loop logger at the gate call site
  (`packages/orchestrator/src/worker/phase-loop.ts:1976`): change
  `hasPendingClarifications(context.checkoutPath, context.item.issueNumber)` to
  `hasPendingClarifications(context.checkoutPath, context.item.issueNumber, this.logger)`.
  No other change to the `on-questions` gate — it stays a pure boolean check (FR-002).

## Phase 2: Tests

- [ ] T003 [US1] [US2] Update the #958 unit suite
  (`packages/orchestrator/src/worker/__tests__/has-pending-clarifications.test.ts`):
  - **New** (FR-001): `readFileSync` throws an error with `code: 'ENOENT'`, spec dir present
    → asserts `false`.
  - Update the existing "readFileSync throws" case to set `(err as any).code = 'EACCES'`
    explicitly so it exercises the real discriminator — still `true` (FR-004).
  - Add an un-coded plain `Error` case (no `code`) → still `true` (FR-004, falls through
    to fail-closed).
  - Keep every other assertion unchanged (missing dir → `true` FR-003, non-empty-zero-parse
    → `true` FR-005, empty file → `false` FR-006, pending/answered/placeholder) (SC-003).

- [ ] T004 [US1] [US2] Add the gate-level regression case to
  `packages/orchestrator/src/worker/__tests__/phase-loop.resume-gates.integration.test.ts`:
  create the spec dir `specs/<issue>-*/` with **no** `clarifications.md`, run the clarify
  phase against the real temp checkout, and assert (a) `waiting-for:clarification` /
  `agent:paused` are **not** applied (gate skipped), (b) the loop proceeds past clarify
  toward `plan`, (c) no `completed:clarification` override label is needed (SC-001, SC-004).
  Fallback if the harness proves disproportionate: a focused mocked-fs gate-branch test
  asserting the gate boolean + skip log (noted in plan.md Change 4, not preferred).

## Phase 3: Release

- [ ] T005 [P] [US1] Add the changeset (required CI gate — non-test `src/` change in
  `packages/orchestrator`). Create **new** file
  `.changeset/1246-zero-question-clarify-gate.md` with a `patch` bump for
  `@generacy-ai/orchestrator` (defect fix, speckit-bugfix workflow) and the body from
  plan.md Change 5 (missing clarifications.md with spec dir present ⇒ no pending questions;
  non-ENOENT errors / missing spec dirs / unparseable files still fail closed).

## Phase 4: Verification

- [ ] T006 [US1] [US2] Rebuild and verify: `pnpm --filter @generacy-ai/orchestrator build`
  (cross-package imports resolve to built `dist/`), then run the two affected suites —
  `has-pending-clarifications.test.ts` and `phase-loop.resume-gates.integration.test.ts` —
  and confirm all FR/SC criteria pass (SC-001..SC-004). Confirm the changeset is a newly
  added file in the diff (`git status`).

## Dependencies & Execution Order

- **T001 → T002**: the logger parameter must exist before the call site passes it.
- **T001 → T003, T004**: tests assert the new ENOENT behaviour, so the implementation lands
  first (per bugfix: land behaviour, then pin tests to the new contract).
- **T005 [P]**: the changeset is independent of code/tests and can be written any time.
- **T006** runs last — it depends on T001–T005 being complete.

**Parallel opportunities**:
- T003 and T004 touch different test files and can run in parallel once T001/T002 land.
- T005 can proceed in parallel with any task.

## Suggested next step

`/speckit:implement` to begin execution.
