# Tasks: Validate-origin remediation must consume budget and have a reliable stop

**Input**: Design documents from `/specs/1158-severity-major-p1-validate/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

All paths under `packages/orchestrator/src/worker/` unless noted. Line refs are at develop `155b3464` and are approximate — locate by symbol, not line.

## Phase 1: Setup & pre-deletion verification

- [X] T001 Grep `ValidateFixIntent` and `validate-fix` across **all** packages (`packages/`) to enumerate every reference before deletion. Confirm the only live consumers are `validate-fix-handler.ts`, its construction/injection in `claude-cli-worker.ts`, the `case 'validate-fix'` launch branch + `ValidateFixIntent` type in `@generacy-ai/generacy-plugin-claude-code`, and their tests. Record the list for Phase 5 (research.md "Open verification items" #1).
- [X] T002 [P] Confirm `child.exitPromise` reject-vs-resolve behavior on SIGKILL in the launcher `ProcessFactory` so `timedOut` is reported on whichever terminal path fires (normal-exit vs wait-error `catch`). Note the finding to inform T010/T011 (research.md open item #2, executor-timeout-signal.md "Note on the wait-error path").
- [X] T003 [P] Confirm `commitPushAndEnsurePr('remediate')` is a no-op when the executor produced no diff (clean-run non-zero exit, no partial work on disk), so the seam's `shouldPush` skip is redundant-safe rather than load-bearing (research.md open item #3).

## Phase 2: Foundational shape changes (blocks Phase 3)

- [X] T004 [US3] Add optional `timedOut?: boolean` to `PhaseResult` in `types.ts` (~:179) with the doc comment from data-model.md Entity 1 (SIGTERM→grace→SIGKILL kill vs clean-run non-zero exit; undefined ⇒ not timed out).
- [X] T005 [US2] Extend `buildErrorEvidence` in `phase-loop.ts` (~:2388) to accept an optional 5th `explicitReason?: string`. Set `const reason = classifier ? message : explicitReason;` and include `reason` only when defined. Invariant: `classifier` still wins when both present; no existing call site passes `explicitReason`, so all current evidence stays byte-identical (data-model.md Entity 2, validate-fingerprint-reason.md).

## Phase 3: Core implementation

### US2 — Stable fingerprint reason (P1)

- [X] T006 [US2] In `phase-loop.ts`, import `hashValidationEvidence` from `evidence-hash.ts` (previously imported by the retired handler).
- [X] T007 [US2] At the validate failure-routing block (`phase-loop.ts:~988`), build the stable reason `` `${effectiveValidateCommand} :: ${hashValidationEvidence(validateEvidence.stdout).hash}` `` and pass it as the new `explicitReason` arg to `buildErrorEvidence`. Depends on T005, T006, and T012 (hoisted `effectiveValidateCommand`). Verifies FR-004/FR-005 (validate-fingerprint-reason.md F1/F2).

### US4 — Effective command threading (P2)

- [X] T012 [US4] Hoist `effectiveValidateCommand` out of the `else if (phase === 'validate')` execution block (`phase-loop.ts:~696`) to per-iteration scope: declare `let effectiveValidateCommand = config.validateCommand;` before the phase-execution if/else, assign the targeted value inside the validate branch. Confirm no shadow re-declaration remains (plan RISK-3 / research.md Decision 4 scope caveat).
- [X] T013 [US4] Use `effectiveValidateCommand` in place of `config.validateCommand` at the fingerprint/alert evidence (`:~988-989`) and the synthesized finding's `file` (`:~1035`). Depends on T012. Verifies FR-008 (validate-fingerprint-reason.md F3).

### US3 — Executor timeout signal (P1)

- [X] T010 [US3] In `RemediateExecutor.execute` (`remediate-executor.ts`), track a `timedOut` flag in the `execute` scope; set it `true` inside the existing timeout timer callback (`:~171-186`) before `child.kill('SIGTERM')`. Depends on T004 (executor-timeout-signal.md).
- [X] T011 [US3] Return `timedOut` on both terminal paths of `RemediateExecutor.execute`: normal-exit (`:~225-231`) and wait-error `catch` (`:~200-207`, SIGKILL may land here). Leave the spawn-failure path (`:~146-153`) with `timedOut` undefined. Preserve the every-return-path `bumpRemediationCount` bump (`:141`, `:195`, `:216`) and leave `round`/`lastReviewedCommitSha` untouched (executor-timeout-signal.md invariants). Depends on T010.

### US1 — Unified remediate seam + shared budget (P1)

- [X] T008 [US1] Collapse the remediate seam in `phase-loop.ts` (`:~1708-1775`) so **both** origins call `deps.remediateExecutor?.execute(context)` (fallback `runStubPhase('remediate')`), removing the `pendingValidateRemediation` dispatch of `ValidateFixHandler` and the `runStubPhase` synthetic-success branch (remediate-seam.md "After"). Verifies FR-001/FR-003/G1/G2/G5.
- [X] T009 [US1] In the collapsed seam, gate commit/push on `const shouldPush = remediateResult.exitCode === 0 || remediateResult.timedOut === true;` — only then call `commitPushAndEnsurePr('remediate')`, honoring the `pushRefused` abort and setting `context.prUrl` from `outcome.prUrl`. Depends on T008, T011. Verifies FR-007/G3/G4 (remediate-seam.md truth table; RISK-2: this also converges review-origin commit/push — call out in PR).
- [X] T014 [US1] Remove the now-dead `pendingValidateRemediation` state variable and its assignment in `phase-loop.ts` (payload `evidence`/`prNumber`/`baseBranch` had no consumer after the adapter is retired). Confirm the carried-forward `remediationCount` synthesis (`:~1041-1055`) no longer silently resets the budget (FR-002). Depends on T008. **RESOLUTION**: the adapter *payload* was dropped, but the bare boolean `pendingValidateRemediation` is RETAINED — it is still consumed at `phase-loop.ts:602` to skip the #1129 review-convergence scaffolding + real review executor on a validate-origin backtrack (running either would overwrite the synthesized changes-required finding). Removing it entirely would break that skip. FR-002 (no silent budget reset) is satisfied by the carried-forward synthesis. Do NOT strip the variable.

## Phase 4: Retire `ValidateFixHandler` and its intent

- [X] T015 [US1] Delete `validate-fix-handler.ts` (file + `ValidateFixHandler` / `ValidateFixIntent` / `ValidateFailureEvidence` / `ValidateFixContext`). Depends on T008 (no invocation site remains). Accepted loss: the per-file sibling-overlap guard (`collectSiblingOwnedFiles` + revert-on-overlap) — plan RISK-1, flag for reviewer sign-off.
- [X] T016 [US1] Drop `validateFixHandler` construction + injection into `PhaseLoopDeps` in `claude-cli-worker.ts`. Depends on T015.
- [X] T017 [US1] Remove `ValidateFixIntent` type and the `case 'validate-fix'` launch branch in `@generacy-ai/generacy-plugin-claude-code` (grep-confirmed by T001). Depends on T001, T015. Note: `generacy-plugin-claude-code` public surface — factor into changeset (T024).

## Phase 5: Tests

- [X] T018 [P] [US1] `__tests__/` — seam routing test: a validate-origin failure dispatches through `RemediateExecutor` (not the stub/handler) and each dispatch increments `remediationCount` exactly once; a mixed review+validate loop is bounded by the single `maxRemediations` cap and pauses at `on-remediation-limit` (`waiting-for:remediation-limit` + `agent:paused`). Verifies SC-001 / US1-AC1..AC4.
- [X] T019 [P] [US2] `__tests__/` — stable-reason fingerprint test: two `validateEvidence` payloads differing only in timings/ordering produce identical `reason` → identical `computeFailureFingerprint`; the `-repeated` backstop escalates at `REPEAT_FAILURE_THRESHOLD` on a nondeterministic validate loop. Verifies SC-002 / SC-003.
- [X] T020 [P] [US3] `__tests__/` — `timedOut` gating tests: (a) hung fixer double killed at timeout, `timedOut === true`, partial work committed/pushed, loop continues (SC-004); (b) clean-run non-zero fixer exit (`exitCode !== 0 && !timedOut`) leaves the branch untouched — no commit/push (SC-005). Cover the SIGKILL wait-error path from T002/T011.
- [X] T021 [P] [US4] `__tests__/` — effective-command test: for speckit-bugfix where `resolveTargetedValidate` narrows the command, the fingerprint reason, failure alert, and synthesized finding `file` cite `effectiveValidateCommand`, not `config.validateCommand`. Verifies FR-008.
- [X] T022 [P] [US1] `__tests__/` — flag-OFF regression: with `reviewPhaseEnabled` OFF, the validate-routing block never runs and behavior is byte-identical to pre-change. Verifies SC-006 / FR-009.
- [X] T023 [US1] Update/remove the retired-handler tests enumerated in T001 (`validate-fix-handler` tests, any `ValidateFixIntent`/`validate-fix` plugin-branch tests). Depends on T015, T017.

## Phase 6: Verification & release

- [X] T024 [US1] Add a changeset `.changeset/1158-validate-origin-remediation.md`: `@generacy-ai/orchestrator` **patch** (internal seam/fingerprint/timeout fix, no new public exports) + `@generacy-ai/generacy-plugin-claude-code` **patch** (removes `ValidateFixIntent` / `validate-fix` launch branch). `workflow:speckit-bugfix` → patch bump. Newly-added file in the PR diff (changeset gate greps `--diff-filter=A`).
- [X] T025 [US1] Run `pnpm --filter @generacy-ai/orchestrator test -- phase-loop` and `pnpm --filter @generacy-ai/orchestrator test -- remediate-executor`, plus typecheck/build for both touched packages. Confirm all six success criteria assertions (SC-001..SC-006) pass.

## Dependencies & Execution Order

**Phase gates (sequential):**
- Phase 1 (verification) → Phase 2 (shapes) → Phase 3 (implementation) → Phase 4 (retirement) → Phase 5 (tests) → Phase 6 (release).
- Phase 1 and Phase 2 can overlap: T002/T003 are read-only probes; T004/T005 are independent edits to `types.ts` and `buildErrorEvidence`. But Phase 3 depends on both completing.

**Critical path within Phase 3:**
- T004 → T010 → T011 → T009 (timeout signal must exist before the seam can gate on it).
- T012 → {T007, T013} (hoist before use).
- T005 + T006 + T012 → T007 (stable reason).
- T008 → {T009, T014} → Phase 4.

**Parallel opportunities:**
- T002, T003 in parallel (both read-only, different concerns).
- T004 [P] and T005 [P] touch different files/functions — parallel.
- Within Phase 3, the US2/US4 fingerprint chain (T006, T012, T013, T007) is independent of the US3 executor chain (T010, T011) until they converge at the seam (T008/T009). Run the two chains in parallel.
- All Phase 5 test files T018–T022 are marked [P] (separate test files, no shared state). T023 depends on the Phase 4 deletions.

**Risks to surface in the PR description:**
- RISK-1: loss of the per-file sibling-overlap guard on the validate-origin path (accepted scope reduction; reviewer sign-off).
- RISK-2: `shouldPush` gating also changes the review-origin commit/push behavior (intended Q3=B convergence, but broader than validate-origin).
- RISK-3: `effectiveValidateCommand` hoist must not shadow-redeclare and must still resolve for non-bugfix workflows.
