# Tasks: Flag-matrix guardrails (#1165)

**Input**: Design documents from `/specs/1165-severity-major-p2-feature/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which corner (C1–C4) / requirement this task belongs to

Corners (from spec):
- **C1** = Corner 1 — flag-OFF one-shot validate-fix fallback (D1=A / FR-001 / FR-002)
- **C2** = Corner 2 — `blocked:stuck-feedback-loop` doc reconcile (D2=A / FR-003 / FR-004)
- **C3** = Corner 3 — speckit-bugfix `on-ci-green` gate under the flag (D3=A / FR-005 / FR-006)
- **C4** = Corner 4 — `getPhaseSequence` fallback gating (D4=A / FR-008)

---

## Phase 1: Setup

- [ ] T001 [P] Confirm baseline is green before touching anything: run the affected
  orchestrator test suites and record the pre-change pass state.
  `pnpm --filter @generacy-ai/orchestrator test -- phase-loop get-phase-sequence config pr-feedback`

- [ ] T002 Add the changeset for the sole production change (Corner 1 + Corner 4 land
  under `packages/orchestrator/src/`). Create **new** file
  `.changeset/1165-flag-matrix-guardrails.md` → `@generacy-ai/orchestrator` **patch**
  (`workflow:speckit-feature`, but this is a defect fix with no new public export).
  Corner 2 doc edit and all test files are changeset-exempt.

---

## Phase 2: Corner 4 — `getPhaseSequence` fallback gating (smallest, unblocks C1 loop-safety)

<!-- Phase boundary: independent single-point fix; do first so the review↔remediate loop cannot be entered by an unknown workflow during C1 work -->

- [ ] T010 [C4] Modify `getPhaseSequence` in
  `packages/orchestrator/src/worker/types.ts:85-91`. When
  `WORKFLOW_PHASE_SEQUENCES[workflowName] === undefined` (unknown/custom workflow),
  return `PHASE_SEQUENCE` with `review` **always** filtered out, regardless of
  `reviewPhaseEnabled`. Known workflows keep the existing flag-conditional behavior
  (byte-identical). `remediate` is already off-sequence — no extra filter needed.
  See `contracts/get-phase-sequence.md`.

- [ ] T011 [C4] Add test file
  `packages/orchestrator/src/worker/__tests__/get-phase-sequence.test.ts` (or extend the
  existing types test if one exists) covering the six assertions in
  `contracts/get-phase-sequence.md`:
  - unknown workflow + `true` ⇒ excludes `review` (the changed row)
  - unknown workflow + `false` ⇒ excludes `review`
  - `speckit-feature` + `true` ⇒ includes `review` (regression guard)
  - `speckit-feature` + `false` ⇒ excludes `review` (regression guard)
  - `speckit-epic` (any flag) ⇒ never includes `review`
  - purity: same input ⇒ same output, no mutation of the source arrays (INV-3).

---

## Phase 3: Corner 1 — flag-OFF one-shot validate-fix fallback

<!-- Phase boundary: depends on Phase 2 (unknown-workflow loop safety) and is the core behavioral change -->

- [ ] T020 [C1] Factor the `changes-required` review-artifact synthesis currently inline
  in the flag-ON validate-fix block (`phase-loop.ts:1038-1075`) into a shared private
  helper on `PhaseLoop` (e.g. `synthesizeValidateReviewArtifact(context, ...)`). It must
  produce exactly one `critical` open `ReviewFinding` citing `effectiveValidateCommand`
  with fenced/bounded validate stdout+stderr, carrying `remediationCount` and
  `markedReadyByEngine` forward from any prior artifact. Refactor the flag-ON block to
  call the helper (behavior byte-identical — INV-3). See `contracts/flag-off-validate-fix.md`
  step 2 + `data-model.md` E2.

- [ ] T021 [C1] Add the block-local flag `flagOffValidateFixAttempted: boolean`
  (initialized `false`) in `executeLoopInner` alongside the existing
  `pendingValidateRemediation` (see `data-model.md` E3).

- [ ] T022 [C1] Insert the flag-OFF fallback branch in `phase-loop.ts` **after** the
  flag-ON validate-fix block (`:971-1090`) and **before** the escalation fall-through
  (`:1092`). Guard: fire iff **all** of `phase === 'validate'`,
  `config.reviewPhaseEnabled !== true`, `flagOffValidateFixAttempted === false`,
  `deps.remediateExecutor` defined. On fire (per `contracts/flag-off-validate-fix.md`):
  1. set `flagOffValidateFixAttempted = true`;
  2. synthesize the artifact via the T020 helper;
  3. `remediateResult = await deps.remediateExecutor.execute(context)`;
  4. push-gate `shouldPush = remediateResult.exitCode === 0 || remediateResult.timedOut === true`
     — if push: `commitPushAndEnsurePr('remediate')`, honor `pushRefused` abort
     (`return { results, completed: false, lastPhase: 'remediate', gateHit: false }`),
     persist post-bump `remediationCount` to Redis mirror best-effort;
     else revert working tree via `context.github.discardWorkingTreeChanges(['.generacy'])`
     (abort loop if the revert throws);
  5. `i--`; 6. `continue`.
  If the guard fails, fall through to the existing escalation unchanged.

- [ ] T023 [C1] Add integration test
  `packages/orchestrator/src/worker/__tests__/phase-loop.flag-off-validate-fix.test.ts`
  covering the four assertions in `contracts/flag-off-validate-fix.md`:
  - flag OFF + validate fails once + remediate succeeds + validate re-run passes ⇒
    loop completes, no `failed:validate`, exactly **one** `remediateExecutor.execute` call;
  - flag OFF + validate fails + remediate runs + validate fails again ⇒ exactly one
    `remediateExecutor.execute` call, then `failed:validate` escalation (guard now false);
  - flag OFF + `deps.remediateExecutor` undefined ⇒ escalates immediately, no attempt;
  - flag ON path (`:971-1090`) and non-validate phases unaffected (regression guard for
    INV-3 / INV-4).

---

## Phase 4: Corner 3 — speckit-bugfix `on-ci-green` gate (test-only pin)

<!-- Phase boundary: no production change; independent of C1/C4 -->

- [ ] T030 [P] [C3] Add test file
  `packages/orchestrator/src/worker/__tests__/config.bugfix-ci-gate.test.ts`. Parse
  `WorkerConfigSchema` with `ciMergeGateEnabled: false` and again with `true`
  (otherwise-default config) and assert the speckit-bugfix `implementation-review` gate
  matches the table in `contracts/bugfix-ci-gate.md`:
  - `false` ⇒ `{ phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'on-request' }`
    (byte-identical to today — INV-2 / SC-006 / FR-009);
  - `true` ⇒ `{ phase: 'validate', gateLabel: 'waiting-for:implementation-review', condition: 'on-ci-green' }`
    (via the #1133 transform at `config.ts:229-247` — INV-1);
  - other speckit-bugfix gates (clarification, merge-conflicts, remediation-limit)
    unaffected by the flag (INV-3).
  No production code change — the transform already produces this.

---

## Phase 5: Corner 2 — `blocked:stuck-feedback-loop` doc reconcile

<!-- Phase boundary: doc + test-only; independent of C1/C3/C4 -->

- [ ] T040 [P] [C2] Correct the migration-guide line at
  `docs/docs/guides/generacy/review-remediate-migration.md:140`. Scope the
  "retired/replaced" claim to the **epic review/remediate path**, and affirm that
  `blocked:stuck-feedback-loop` retains its bounded-stop role on the **flag-OFF
  PR-feedback legacy path**. Preserve the two load-bearing facts from
  `contracts/stuck-loop-doc-reconcile.md`:
  1. `waiting-for:remediation-limit` supersedes the label **only on the epic path**;
  2. the label is still active and load-bearing on the flag-OFF PR-feedback path
     (the monitor skips all `blocked:*` labels).

- [ ] T041 [C2] Add/extend a test that pins the flag-OFF stuck-loop behavior the corrected
  docs now describe (e.g.
  `packages/orchestrator/src/worker/__tests__/pr-feedback-stuck-loop.test.ts`): assert
  `BLOCKED_STUCK_FEEDBACK_LOOP_LABEL` (`pr-feedback-handler.ts:45`) is still applied at
  `:632` on `(!cliSelfCommitted && (!success || !hasChanges))` — i.e. it still bounds the
  loop on the legacy path (SC-003). No new behavior; the test pins the existing bounded stop.

---

## Phase 6: Verification

<!-- Phase boundary: run after all edits land -->

- [ ] T050 Run the full affected suites and confirm green:
  `pnpm --filter @generacy-ai/orchestrator test -- phase-loop.flag-off-validate-fix get-phase-sequence config.bugfix-ci-gate pr-feedback-stuck-loop`
  Plus the pre-existing phase-loop / gate / config suites to confirm no regression (FR-009).

- [ ] T051 Typecheck + lint the orchestrator package and build the docs site to confirm
  the Corner 2 edit has no broken links (`onBrokenLinks:'throw'`):
  `pnpm --filter @generacy-ai/orchestrator typecheck && pnpm --filter @generacy-ai/orchestrator lint`
  and the docs build command.

- [ ] T052 Confirm the changeset gate is satisfied: `.changeset/1165-flag-matrix-guardrails.md`
  is a newly-added file listing `@generacy-ai/orchestrator`. Verify with
  `pnpm changeset status`.

---

## Dependencies & Execution Order

**Sequential phases**:
- Phase 1 (Setup) → Phase 2 (C4) → Phase 3 (C1) → Phase 6 (Verification).
  C1 (Phase 3) depends on C4 (Phase 2) only for loop-safety ordering; the code edits are
  in different regions of the same file (`types.ts` vs `phase-loop.ts`) so there is no
  merge conflict, but do C4 first so an unknown workflow can never enter the
  review↔remediate loop while C1 is in flight.
- Phase 4 (C3) and Phase 5 (C2) are **fully independent** of C1/C4 and of each other —
  they can be done any time after Phase 1 and in parallel with Phase 2/3.

**Parallel opportunities**:
- T001 [P] setup check is independent.
- T030 [P] (C3 test), T040 [P] (C2 doc) touch disjoint files from each other and from
  C1/C4 — can run concurrently.
- Within Phase 3, T020 → T021 → T022 are sequential (same file, data dependency);
  T023 (test) follows T022.

**Critical path**: T001 → T010/T011 → T020 → T021 → T022 → T023 → T050/T051/T052.

## Summary

- **Total tasks**: 15 (T001–T002, T010–T011, T020–T023, T030, T040–T041, T050–T052).
- **Phase breakdown**: Setup 2, C4 2, C1 4, C3 1, C2 2, Verification 3.
- **Parallel opportunities**: T001, T030, T040 (+ the two test-only corners run alongside
  the code corners).
- **Mode**: Standard (fine-grained).
- **Only production change**: `packages/orchestrator/src/worker/{types.ts,phase-loop.ts}`
  → one `@generacy-ai/orchestrator` patch changeset. Everything else is tests or docs.

**Next step**: `/speckit:implement` to begin execution.
