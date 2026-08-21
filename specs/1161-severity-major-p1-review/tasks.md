# Tasks: Collapse the triple findings-artifact schema; activate the discarded convergence engine

**Input**: Design documents from `/specs/1161-severity-major-p1-review/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

All paths are under `packages/orchestrator/src/` unless otherwise noted. Scope is
orchestrator-internal; no cloud/cluster-base/public-export change. Entire feature stays
behind `reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED` (flag-OFF = byte-identical).

---

## Phase 1: Canonical schema foundation (US2, D2)

Blocking phase — every later phase imports the canonical types, `SEVERITY_RANK`,
`computeVerdict`, and the back-compat `id` fill established here.

- [X] T001 [US2] In `worker/review-artifact.ts`, add `id: z.string().min(1)` as the first
      field of `ReviewFindingSchema` (data-model.md `ReviewFinding`). Keep `severity`,
      `file`, `line?`, `title`, `detail`, `round` (1-based positive int), `status`
      (`open|resolved`). Do NOT change `ReviewArtifactSchema`'s existing fields
      (`findings`, `verdict`, `round`, `lastReviewedCommitSha?`, `remediationCount`
      default 0, `markedReadyByEngine` default false).
- [X] T002 [US2] In `worker/review-artifact.ts`, add the deterministic id derivation
      `deriveFindingId(file, title) = sha256(file + '\0' + title).slice(0, 24)` using
      `node:crypto` (24 hex chars, matches `gate-id` convention). This is the same logic
      as the soon-deleted `review-findings-bridge.ts` `synthesizeMarker` — move it here.
- [X] T003 [US2] In `worker/review-artifact.ts`, apply the back-compat `id` fill inside
      `readReviewArtifact`, `readReviewArtifactSync`, and `readCandidateFindings`
      (whichever exist): for any parsed finding lacking `id`, default-fill via
      `deriveFindingId(file, title)` BEFORE Zod validation reaches the consumer. Readers
      still return the canonical shape or `null` and never throw (INV-5). Confirm
      `SEVERITY_RANK` (`{critical:3, major:2, minor:1}`) and `computeVerdict(findings,
      blockingSeverity)` remain the single exported copies (INV-2/INV-3).

## Phase 2: Retarget convergence engine + delete orphan schemas (US2, D1)
<!-- Phase boundary: Phase 1 canonical `id` + readers must land first -->

Convergence files import canonical types from Phase 1. Deletions and retargets here
collapse the triple schema to one (SC-001/SC-002/SC-003).

- [ ] T004 [US2] Retarget `worker/review/review-delta.ts`: import `ReviewArtifact` /
      `ReviewFinding` from `review-artifact.ts`; change the sha reader from
      `artifact.lastReviewedSha` to canonical `artifact.lastReviewedCommitSha`
      (research Decision 4). `computeReviewDelta(prior, headSha, ctx)` returns
      `ReviewDelta { changedFiles, base, round }` with `round = (prior?.round ?? 0) + 1`
      (1-based, Decision 5).
- [ ] T005 [US2] Retarget `worker/review/verification-input.ts`: `composeVerificationInput`
      operates on canonical `ReviewFinding`, enumerating all prior findings with
      `status === 'open'`.
- [ ] T006 [US2] Retarget `worker/review/findings-advance.ts` to canonical types. **Delete**
      the second `computeVerdict` (SC-002) and any `SEVERITY_ORDER` usage (SC-003); import
      `computeVerdict` + `SEVERITY_RANK` from `review-artifact.ts`. `advanceArtifact(prior,
      delta, reviewerAddressed, reviewerNewFindings)` matches by `id` within the delta,
      enforces resolved-is-terminal, carries forward unaddressed open findings. Retarget
      `filterNewFindings(candidates, round, blockingSeverity)` to 1-based `round >= 2`
      (Decision 5), importing canonical `SEVERITY_RANK`.
- [ ] T007 [US2] Delete `worker/review/findings-artifact.ts` (#1126 orphan schema, its
      `SEVERITY_ORDER`/`sev()`). Fix any remaining imports to point at canonical types.
- [ ] T008 [US2] Delete `worker/review-findings-artifact.ts` (#1125 orphan schema,
      `blocking|advisory` vocabulary). Fix remaining imports.
- [ ] T009 [US2] Delete `worker/review-findings-bridge.ts` (`bridgeReviewArtifact` /
      `synthesizeMarker`); its derivation already lives in `review-artifact.ts` from T002.
- [ ] T010 [US2] In `worker/remediate-executor.ts`, delete the local `SEVERITY_RANK`;
      import the canonical one from `review-artifact.ts` (SC-003). No behavior change.

## Phase 3: Poster re-home (US2, FR-009 regression guard)
<!-- Phase boundary: needs canonical schema (Phase 1) + deleted bridge/#1125 (Phase 2) -->

- [ ] T011 [US2] In `worker/review-poster.ts`, change input from the deleted
      `FindingsArtifact` to canonical `ReviewFinding[]` + `verdict` + `blockingSeverity`
      (contracts/poster-input.md). Render projection: `marker = finding.id`,
      `text = title + '\n\n' + detail`, `anchor = line !== undefined ? {file,line} :
      undefined`, `resolved = status === 'resolved'`, and blocking iff
      `SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[blockingSeverity]`. Preserve ALL
      #1156 output byte-for-byte: body marker `<!-- generacy-engine-review round=<N> -->`,
      inline marker `<!-- generacy-finding:<id> -->`, per-round dedupe, round>=2 thread
      resolution, draft/ready lifecycle, `markedReadyByEngine` persistence (INV-P3).

## Phase 4: Activate convergence in the executor (US1, D1 — load-bearing)
<!-- Phase boundary: needs retargeted convergence fns (Phase 2) + canonical readers (Phase 1) -->

Replaces the discarded `runReviewConvergence` pre-pass with a real in-executor merge
(contracts/convergence-merge.md, research Decision 7). This is the anti-vanish behavior
change (SC-005).

- [ ] T012 [US1] In `worker/phase-loop.ts`, delete `runReviewConvergence` and its
      `review-findings:<owner>:<repo>:<issue>:<branch>` PhaseTracker key (FR-006 — sidecar
      `round` is now the single round source; no independent counter). Retype the
      `readFindingsArtifact` seam to the canonical `ReviewArtifact`/`ReviewFinding` types.
      Remove the `settings = null` `resolveWorkflowOverrides` call site along with it
      (FR-004 / SC-004).
- [ ] T013 [US1] In `worker/claude-cli-worker.ts`, drop `bridgeReviewArtifact` usage and
      wire the canonical `readFindingsArtifact` seam to the executor (types only; the
      bridge no longer exists).
- [ ] T014 [US1] In `worker/review-executor.ts`, implement the convergence merge sequence
      (contracts/convergence-merge.md "Executor sequence"): (1) `prior =
      readReviewArtifact(...)` (null on round 1); (2) `delta = computeReviewDelta(prior,
      HEAD, ctx)` reading `prior.lastReviewedCommitSha` (FR-007); (3) build a delta-scoped
      charter feeding `buildVerificationPrompt` output — NOT discarded (FR-005); (4) spawn
      CLI, read candidate findings; (5) `merged = advanceArtifact(prior, delta,
      reviewerAddressed, reviewerNewFindings)` with REAL inputs; (6) `verdict =
      computeVerdict(merged, blockingSeverity)`; (7) `writeReviewArtifact` with
      `round = (prior?.round ?? 0) + 1`, `lastReviewedCommitSha = HEAD`, carrying forward
      `remediationCount` / `markedReadyByEngine`. Round advances only on a successful
      review (FR-006).
- [ ] T015 [US1] In `worker/review-charter.ts`, make the round >= 2 charter delta-scoped
      and verification-framed: scope to the delta window since `lastReviewedCommitSha`,
      enumerate still-open findings, restrict new findings to blocking severity. Round 1
      (`prior === null`) keeps the whole-PR `standard` profile (data-model "Round-1 special
      case"). No half-wired middle state may remain (FR-005).

## Phase 5: Consistent `blockingSeverity` resolution (US3, FR-004)
<!-- Phase boundary: the sole `settings = null` site was deleted in Phase 4 (T012) -->

- [ ] T016 [US3] Audit every verdict-relevant call site (`review-executor.ts`,
      `remediate-executor.ts`, the gate in `phase-loop.ts`, and the convergence merge) to
      confirm all resolve `blockingSeverity` via
      `resolveWorkflowOverrides(config, this.settings, workflowName)` — zero `settings =
      null` (SC-004). This is a verification/cleanup pass over Phases 2 & 4.

## Phase 6: Default + docs reconciliation (US4, FR-008, D3)

- [ ] T017 [P] [US4] In `worker/config.ts`, replace the flat
      `DEFAULT_REVIEW.blockingSeverity = 'critical'` with a per-workflow
      `defaultBlockingSeverity(workflowName)` returning `speckit-feature → 'major'`, else
      `'critical'` (mirror `defaultMaxRemediations`). Consume it in
      `resolveWorkflowOverrides` as the fallback when no explicit `review.blockingSeverity`
      override is set.
- [ ] T018 [P] [US4] In `docs/docs/reference/review-artifacts.md`, update the default
      `blockingSeverity` to `major` for `speckit-feature` (other workflows `critical`) and
      record the D3 rationale so docs and code agree (SC-007).

## Phase 7: Tests & verification (SC-001..SC-008)
<!-- Phase boundary: implementation Phases 1–6 must land first -->

- [ ] T019 [US2] Update `review/__tests__/` for `findings-advance` and `review-delta` to
      the canonical types (deleted second `computeVerdict`, canonical
      `lastReviewedCommitSha`, 1-based rounds). Fix broken imports from deleted files.
- [ ] T020 [P] [US2] Add/adjust a schema-audit test asserting exactly one findings-artifact
      schema, one `computeVerdict`, one `SEVERITY_RANK` under `worker/` (SC-001/SC-002/
      SC-003). Include a back-compat parse test: a sidecar without per-finding `id` parses
      and default-fills the deterministic id (INV-4/INV-5).
- [ ] T021 [US1] Add a convergence anti-vanish test (SC-005): a finding raised in round 1
      and omitted by the round-2 candidate stays `open`, verdict stays `changes-required`;
      a resolved finding is never reopened (monotonic, US1 AC3); round >= 2 review is
      scoped to the delta since `lastReviewedCommitSha` (US1 AC2 / FR-007).
- [ ] T022 [P] [US3] Add a `blockingSeverity` override-parity test (SC-004): with a
      per-workflow override set, the executor, remediate executor, gate, and convergence
      merge produce an identical verdict for the same findings set.
- [ ] T023 [P] [US4] Add a docs-vs-code default assertion (SC-007): the
      `defaultBlockingSeverity('speckit-feature')` constant equals the value documented in
      `docs/docs/reference/review-artifacts.md`. Add a single-source-of-round test (SC-006):
      no round counter can disagree for one review.
- [ ] T024 [P] [US2] Update `review-poster.ts` tests for the canonical `ReviewFinding[]`
      input type only; assert posting output (markers, bodies, dedupe, lifecycle) is
      byte-for-byte preserved (FR-009 / INV-P3).
- [ ] T025 [US2] Run `pnpm --filter @generacy-ai/orchestrator test` — all pre-existing
      review/remediate/lifecycle suites (#1156, #1128, #1154) green (SC-008 / FR-009). Run
      `tsc` + lint: no unused-export or dead-file warnings for the removed schemas (US2 AC3).

## Phase 8: Changeset

- [ ] T026 Add `.changeset/1161-collapse-findings-schema-activate-convergence.md`:
      `@generacy-ai/orchestrator` **patch** (`workflow:speckit-bugfix`) — internal
      consolidation + bug fix, no new public exports, no new label vocabulary. Verify with
      `pnpm changeset status`.

---

## Dependencies & Execution Order

**Phase boundaries (sequential)**:
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7 → Phase 8.

- **Phase 1 (T001–T003)** is the blocking foundation: canonical `id`, deterministic
  derivation, and back-compat readers. Everything imports these.
- **Phase 2 (T004–T010)** retargets the convergence engine and deletes the two orphan
  schemas — depends on Phase 1 canonical types. T004/T005/T006 retarget before T007/T008
  delete (retarget imports first, then remove the old files). T010 is independent within
  the phase.
- **Phase 3 (T011)** re-homes the poster — depends on Phase 1 (canonical `ReviewFinding`)
  and Phase 2 (deleted bridge + #1125 schema).
- **Phase 4 (T012–T015)** activates convergence in the executor — depends on the
  retargeted `advanceArtifact`/`computeReviewDelta`/`composeVerificationInput` (Phase 2)
  and canonical readers (Phase 1). T012 (delete `runReviewConvergence`) removes the sole
  `settings = null` site.
- **Phase 5 (T016)** is a verification pass confirming FR-004 parity after Phases 2 & 4.
- **Phase 6 (T017, T018)** default + docs — independent of the schema collapse; the two
  tasks touch different files and run in parallel `[P]`.
- **Phase 7 (T019–T025)** tests — after implementation. T020/T022/T023/T024 touch distinct
  test files and run in parallel `[P]`; T019/T021 depend on the retargeted convergence code
  and executor merge; T025 is the final gate and runs last.
- **Phase 8 (T026)** changeset — last.

**Parallel opportunities**:
- Within Phase 2: T010 (remediate-executor severity import) is independent of the
  review/* retargets.
- Phase 6: T017 and T018 are `[P]`.
- Phase 7: T020, T022, T023, T024 are `[P]` (distinct files); T025 gates the phase.

**Total**: 26 tasks across 8 phases. Feature-flag safety (flag-OFF byte-identity) holds by
construction — all changes sit inside the `review` phase path.

Suggested next step: `/speckit:implement` to begin execution.
