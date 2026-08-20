# Tasks: Route validate failures into the remediate loop

**Input**: Design documents from `/specs/1129-context-worker-validate-fix/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Thin adapter reduction (independent file)

- [ ] T001 [US3] Reduce `packages/orchestrator/src/worker/validate-fix-handler.ts` to a thin
      remediate adapter (FR-005 / contracts/thin-adapter-contract.md). Keep the `handle(item,
      checkoutPath, { prNumber, baseBranch }, evidence, github, workflowName)` signature unchanged.
      **Preserve** (FR-010): evidence→fix prompt, commit, sibling-owned-file enumeration (open PRs
      against the same `baseBranch` → collect changed files → instruct fixer not to recreate them),
      and the revert-on-overlap guard. **Remove as live gates**: the one-attempt-per-evidence-hash
      cap (superseded by `maxRemediations`), the `resumeReason === 'base-advance'` coupling, and
      any application of `failed:*` escalation labels (the phase loop owns escalation now). On
      throw, do not swallow into escalation — let it propagate so the loop's best-effort handling
      (T007) applies.

## Phase 2: Validate-failure routing in phase-loop.ts (sequential — same file)
<!-- Phase boundary: T001 may proceed in parallel; T002–T007 all edit phase-loop.ts and must run in order -->

- [ ] T002 [US1] In `packages/orchestrator/src/worker/phase-loop.ts`, add the block-local one-shot
      control `pendingValidateRemediation` (Entity 3, data-model.md) to `executeLoop`: type
      `undefined | { evidence: ValidateEvidence; prNumber: number; baseBranch: string }`, initialized
      `undefined` at loop start. Not persisted, not on `WorkerContext`.

- [ ] T003 [US1] In `phase-loop.ts`, replace the legacy validate-fix block (old `phase-loop.ts:843-887`,
      the `resumeReason === 'base-advance'` #892 path) with the routed validate-failure branch guarded
      on `phase === 'validate' && result.success === false && reviewPhaseEnabled === true`
      (contracts/validate-remediation-routing.md Step 1 + Decision 6). Build `evidence` from the
      `PhaseResult` (`stdout: result.capturedStdout ?? ''`, `stderr: result.capturedStderr ??
      result.error?.output ?? ''`, `exitCode`). Delete the direct `validateFixHandler.handle()` call
      from this branch — the handler is invoked only at the remediate seam (T006), giving structural
      mutual exclusion (FR-008 / SC-003). Remove the `base-advance` precondition (FR-004).

- [ ] T004 [US2] In the routed branch (`phase-loop.ts`), implement fingerprint-first escalation
      (research.md Decision 5, contracts Step 1, FR-006 / FR-009): compute `fingerprint =
      computeFailureFingerprint({ phase: 'validate', evidence })` and `occurrence =
      countPriorOccurrences(owner, repo, issue, fingerprint) + 1`; call `postFailureAlert({ stage,
      runId, phase: 'validate', evidence, fingerprint, occurrence })`. Do **not** call
      `labelManager.onError('validate')` (so `failed:validate` is never applied — FR-009). If
      `occurrence >= REPEAT_FAILURE_THRESHOLD` → `labelManager.onRepeatedError('validate')`
      (`failed:validate-repeated`) and return `{ results, completed: false, lastPhase: 'validate',
      gateHit: false }` (terminal). Add the defensive fallback: if `prNumber` is absent, fall back to
      the pre-existing escalation rather than routing (contracts Step 3).

- [ ] T005 [US1] In `phase-loop.ts`, implement the synthesize-and-backtrack path (contracts Steps 2–3,
      research.md Decisions 1–3, data-model.md Entity 1). Read prior artifact via
      `readReviewArtifact(checkoutPath, workflowId)`; compute `round = (prior?.round ?? 0) + 1`;
      append one synthesized `critical`/`open` finding (`file: <validateCommand>`, `title: 'validate
      phase failed'`, `detail: boundTail(evidence)`, `round`); write via `writeReviewArtifact` with
      `verdict: 'changes-required'`, `round`, and `lastReviewedCommitSha: <HEAD>`. Set
      `pendingValidateRemediation = { evidence, prNumber, baseBranch }` (`baseBranch` `'origin/'`-stripped),
      then `i = sequence.indexOf('review') - 1; continue;`.

- [ ] T006 [US1] In `phase-loop.ts`, gate the `review` re-entry and dispatch the remediate seam on
      `pendingValidateRemediation` (contracts Steps 4–6, research.md Decisions 2 & 4). On the `review`
      re-entry while set: skip `runReviewConvergence(...)` and `reviewExecutor.execute(...)`, set
      `result = runStubPhase('review')` (synthetic success, leaving the synthesized artifact intact for
      the `on-remediation-limit` gate + `remediateTrigger`). At the remediate seam while set: run
      `validateFixHandler.handle(item, checkoutPath, { prNumber, baseBranch }, evidence, github,
      workflowName)` (converting engine-marked-ready PRs to draft as review-origin does), then clear
      `pendingValidateRemediation = undefined`; else `runStubPhase('remediate')` (review-origin,
      unchanged). Confirm the second `review` re-entry (cleared) runs the real delta-scoped executor,
      then `validate` re-runs (FR-003). Verify `hasBaseMergedThisCycle` block-local re-init still holds
      one base-merge per cycle across the backtrack (FR-007 / research.md Decision 7 — no code change
      expected, assert in T009).

- [ ] T007 [US3] In `phase-loop.ts`, wrap the remediate-seam adapter call (T006) so an adapter throw is
      logged and the loop continues (contracts/thin-adapter-contract.md "Behavior on adapter failure"):
      the subsequent delta-scoped `review` re-run + `validate` re-run, or a repeated-identical failure →
      fingerprint backstop, provides the terminal safety net. The adapter is best-effort interim
      behavior, not a hard dependency of the routing.

## Phase 3: Tests
<!-- Phase boundary: Complete Phase 1–2 before Phase 3 -->

- [ ] T008 [P] [US3] Create `packages/orchestrator/src/worker/__tests__/validate-fix-handler.adapter.test.ts`
      (FR-005 / FR-010): assert the reduced adapter still builds the fix prompt from evidence, commits,
      enumerates sibling-owned files and reverts-on-overlap, and that the one-attempt-per-evidence-hash
      cap and `failed:*` label application are gone.

- [ ] T009 [P] [US1] Create
      `packages/orchestrator/src/worker/__tests__/phase-loop.validate-remediate.integration.test.ts`
      (SC-001 / SC-004 / SC-005): assert a failing `validate` drives
      `remediate → review → validate-green` end-to-end with the phase order observed; assert the
      `#914` per-iteration base-merge guard holds at most one merge per cycle across the backtrack
      (SC-004); assert that with `reviewPhaseEnabled = false` behavior is byte-identical to pre-change
      (SC-005).

- [ ] T010 [P] [US2] Create `packages/orchestrator/src/worker/__tests__/phase-loop.validate-fingerprint.test.ts`
      (SC-002 / SC-003): reproduce the same validate evidence across remediations and assert fingerprint
      escalation applies `failed:validate-repeated` at `REPEAT_FAILURE_THRESHOLD`; assert `failed:validate`
      is never applied on the routed path (FR-009); assert the legacy handler is invoked at exactly one
      site (remediate seam) and never both paths for one failure (SC-003 / FR-008).

## Phase 4: Changeset & verification
<!-- Phase boundary: Complete Phase 3 before Phase 4 -->

- [ ] T011 [US1] Add `.changeset/1129-validate-remediate-routing.md`: `@generacy-ai/orchestrator`
      **patch** — internal phase-loop/handler behavior change (`workflow:speckit-bugfix`), no new public
      exports, no new label vocabulary (`waiting-for:remediation-limit` and `failed:validate-repeated`
      already exist). Must be a newly added file per the changeset CI gate.

- [ ] T012 [US1] Run the orchestrator test + typecheck suite (`pnpm --filter @generacy-ai/orchestrator
      test` and build/typecheck) and confirm existing flag-off phase-loop suites still pass unchanged
      (SC-005) alongside T008–T010.

## Dependencies & Execution Order

**Sequential spine (all edit `phase-loop.ts`)**: T002 → T003 → T004 → T005 → T006 → T007.

**Parallel opportunities**:
- T001 (edits `validate-fix-handler.ts`) can run in parallel with the Phase 2 phase-loop spine — but
  the remediate-seam dispatch (T006) depends on the reduced adapter surface, so land T001 before T006.
- T008, T009, T010 are independent test files and can run in parallel once Phase 1–2 land.

**Phase boundaries (sequential)**: Phase 1/2 → Phase 3 → Phase 4.

**Story coverage**:
- US1 (self-heal through remediate loop): T002, T005, T006, T007(support), T009, T011, T012.
- US2 (repeated failures still escalate): T004, T010.
- US3 (exactly one recovery path): T001, T003, T007, T008, T010.
