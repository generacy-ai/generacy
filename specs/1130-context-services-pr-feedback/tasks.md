# Tasks: PR-feedback monitor — exclude engine threads, route external feedback into remediate

**Input**: Design documents from `/specs/1130-context-services-pr-feedback/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1/US2/US3)

## Phase 1: Setup & Pre-flight Verification

- [ ] T001 [Setup] Confirm the feature-flag default: `reviewPhaseEnabled` (env `WORKER_REVIEW_PHASE_ENABLED`) defaults to `false` in `packages/orchestrator/src/worker/config.ts` (or its schema). The new routing path must be unreachable when off (plan Risks: rolling-deploy skew). Note the exact default in the PR body.
- [ ] T002 [P] [Setup] Grep the monorepo for remaining references to the label constant before any deletion: `stuck-feedback-loop`, `STUCK_FEEDBACK_LOOP`, `blocked:stuck-feedback-loop`. Enumerate every consumer (cockpit label maps/precedence, orchestrator handler apply-site, tests) so US3 can migrate/remove them in the same PR (research Decision 6, plan Risks).
- [ ] T003 [P] [Setup] Confirm the reused engine-marker helpers are exported and importable from `packages/orchestrator/src/worker/review-poster.ts`: `commentCarriesEngineAuthoredReviewMarker`, `matchEngineAuthoredReviewMarker`, `ENGINE_AUTHORED_REVIEW_MARKERS` (#1127 surfaces — compose, do not re-implement).
- [ ] T004 [P] [Setup] Confirm the reused review-artifact surfaces exist and their signatures in `packages/orchestrator/src/worker/review-artifact.ts`: `computeVerdict(findings, blockingSeverity)`, `writeReviewArtifact`, `readReviewArtifact`, `clearReviewArtifact`, the `FindingsArtifact` finding shape, and the `[^a-zA-Z0-9_-] → _` workflowId sanitizer used by the path helper (#1124 surfaces). Confirm `ReviewExecutor` constructor/`execute(context)` shape for the wrapper delegate.

---

## Phase 2: Foundational — External-feedback seed module (blocks US2)

**Blocking prerequisite for US2**: both the seed-aware wrapper and the worker adapter import this module.

- [ ] T005 [Foundation] Create `packages/orchestrator/src/worker/external-feedback-seed.ts` implementing the contract in `contracts/external-feedback-seed.md`:
  - `interface ExternalFeedbackSeed { version: 1; prNumber: number; seededAt: string; findings: ExternalFeedbackFinding[] }` and `interface ExternalFeedbackFinding { id: string; body: string; author: string; path?: string; line?: number }` (per data-model.md).
  - Zod schemas: `version: z.literal(1)`, `findings: z.array(ExternalFeedbackFindingSchema).min(1)`.
  - `getExternalFeedbackSeedPath(checkoutPath, workflowId)` → `<checkoutPath>/.generacy/external-feedback-<sanitize(workflowId)>.json`, reusing the same `[^a-zA-Z0-9_-] → _` sanitizer as `review-artifact.ts`.
  - `writeExternalFeedbackSeed(...)` atomic write (temp + rename), mirroring `writeReviewArtifact`.
  - `readExternalFeedbackSeed(...)` → `null` on missing/malformed/unknown-version (fail-open, same conservatism as `readReviewArtifact`).
  - `clearExternalFeedbackSeed(...)` best-effort unlink, no-op if absent.
- [ ] T006 [P] [Foundation] Unit tests `packages/orchestrator/src/worker/__tests__/external-feedback-seed.test.ts`: round-trip write→read; `null` on missing file, malformed JSON, and `version !== 1`; path helper sanitization; write refuses / is never called with empty `findings` (contract invariant: `findings.length >= 1`); `clear` is a no-op when absent.

---

## Phase 3: User Story 1 — Engine's own review threads never re-trigger the monitor (P1)

**Independent**: touches only the monitor service; no dependency on the seed module. Can proceed in parallel with Phase 2.

- [ ] T007 [US1] Add the engine-authored exclusion guard in `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` trust-filter loop (~264-286), per `contracts/monitor-engine-exclusion.md` Change 1:
  - Exclude a thread from the trusted-unresolved count **iff** `thread.comments.every(c => commentCarriesEngineAuthoredReviewMarker(c.body))` (FR-010 / Q4→A — all-or-nothing; any external trusted comment keeps the thread live).
  - Import the marker helper from `worker/review-poster.ts`; pass the **raw** `comment.body` unmodified (helper owns the match rule — do not re-implement, FR-001).
  - Apply the guard **in addition to**, not in place of, `isTrustedCommentAuthor` (FR-002 — human trust stays authorship-based).
  - Leave Case A `blocked:*` skip guard, Case B untrusted-notice episode, Case C `fixerTimeoutRetryCount` reset, the `address-pr-feedback` enqueue, and the webhook/adaptive-interval logic byte-identical on their inputs (FR-009).
- [ ] T008 [US1] Tests in `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.*.test.ts` (extend existing suite): a thread whose comments are ALL engine-authored contributes 0 to the trusted-unresolved count and causes NO enqueue (SC-001/SC-003); a mixed thread with ≥1 external trusted comment still triggers as today (FR-010); a `> `-quoted marker does NOT exclude (relies on helper rule).
- [ ] T009 [US1] Run the full existing `pr-feedback-monitor-service` test suite and confirm untrusted-notice, `blocked:*` skip, and adaptive-interval tests stay green (SC-006 regression oracle).

**Checkpoint**: US1 is independently shippable — the monitor stops racing on engine-authored threads even before US2 lands.

---

## Phase 4: User Story 2 — External trusted feedback enters the shared remediate loop (P1)

**Depends on**: Phase 2 (seed module).

- [ ] T010 [US2] Create `packages/orchestrator/src/worker/seed-aware-review-executor.ts` (plan D-1, `contracts/external-feedback-seed.md` Module 2):
  - `class SeedAwareReviewExecutor` with ctor `{ delegate: ReviewExecutor; logger }` and `async execute(context): Promise<PhaseResult>`.
  - **Seed present**: resolve `blockingSeverity` from the workflow review config; map `seed.findings` → findings-artifact findings (`status: 'open'`, `severity: blockingSeverity`); `verdict = computeVerdict(findings, blockingSeverity)` (MUST be `changes-required`); `round = (priorArtifact?.round ?? 0) + 1`; `lastReviewedCommitSha = await context.github.getCurrentCommitSha()`; `writeReviewArtifact(...)`; `clearExternalFeedbackSeed(...)` (consume-once); return synthetic success `{ phase: 'review', success: true, exitCode: 0, durationMs, output: [] }` — **no CLI spawn**.
  - **Seed absent**: `return this.delegate.execute(context)` (real review, convergence round).
- [ ] T011 [P] [US2] Reduce `packages/orchestrator/src/worker/pr-feedback-handler.ts` to expose the **retained dual-source parser** (~218-402) as a callable that extracts trusted findings from inline threads AND review bodies and maps them to `ExternalFeedbackFinding[]` (review-body items keep the `"review body (no file anchor):\n\n<body>"` prefix so body-only asks survive — FR-004). Optionally provide a small `writeSeed` helper. (Deletion of the `blocked:stuck-feedback-loop` apply-site is US3/T015 — keep it compiling here.)
- [ ] T012 [US2] Rewire the `if (item.command === 'address-pr-feedback')` branch in `packages/orchestrator/src/worker/claude-cli-worker.ts` (~299) per `contracts/monitor-engine-exclusion.md` Change 2 — no longer returns early into the legacy fixer:
  1. Ensure checkout (as today).
  2. Run the retained dual-source parser (T011) to extract trusted findings.
  3. If ≥1 finding: `clearReviewArtifact(checkoutPath, workflowId)` (D-2 counter reset, FR-006) → `writeExternalFeedbackSeed(...)` → fall through to `phaseLoop.executeLoop(context, effectiveConfig, deps, phaseSequence)` with `phaseSequence` starting at `review`.
  4. If 0 findings: no seed, no artifact clear — treat as no-op completion.
  - Inject `SeedAwareReviewExecutor` (wrapping the real `ReviewExecutor` built ~691) as `deps.reviewExecutor` for this job. Leave `remediateTrigger` wiring unchanged (it reads the artifact verdict the wrapper writes).
- [ ] T013 [US2] Unit tests `packages/orchestrator/src/worker/__tests__/seed-aware-review-executor.test.ts`: seed-present writes the findings artifact with `verdict === 'changes-required'`, deletes the seed, returns synthetic success, and spawns NO CLI (SC-004 depends on this); seed-absent delegates to the real executor; `round` derives to 1 after a prior artifact-clear.
- [ ] T014 [US2] Integration/harness test for the end-to-end route (SC-002/SC-004): a trusted external unresolved thread enqueues `address-pr-feedback`; the worker parses dual-source feedback (assert a review-body-only finding appears in the seed), seeds, and runs the phase loop at `review`; `remediateTrigger` fires (verdict `changes-required`) → remediate runs → convergence round finds no seed and delegates to the real executor. Assert the legacy fixer fix-CLI path is NOT taken (FR-003).

**Checkpoint**: US2 requires the `review` phase enabled (`WORKER_REVIEW_PHASE_ENABLED=true`) to be reachable end-to-end.

---

## Phase 5: User Story 3 — Retire the legacy fixer dead-end (P2)

**Depends on**: US2 (the shared path must be live before removing the divergent disposition).

- [ ] T015 [US3] In `packages/orchestrator/src/worker/pr-feedback-handler.ts`: delete the `blocked:stuck-feedback-loop` apply-site (~611, `addBlockedStuckFeedbackLoopLabel`) and its constant (~31), and remove the divergent disposition/enqueue logic that competed with the shared loop — the handler no longer runs a fix CLI itself (FR-007/FR-008, Q5→B one live fix path). Exhaustion now lands on `waiting-for:remediation-limit` via the existing `on-remediation-limit` gate (FR-005).
- [ ] T016 [US3] Remove the `blocked:stuck-feedback-loop` definition from `packages/workflow-engine/src/actions/github/label-definitions.ts` (FR-008). Migrate/remove every other consumer found in T002 (cockpit label maps/precedence, tests) in this same PR — do not leave a dangling reference.
- [ ] T017 [US3] Tests: exceed the remediation cap on an external-feedback route and assert the disposition is `waiting-for:remediation-limit`, never `blocked:stuck-feedback-loop` (SC-005). Update/delete any test that asserted the old `blocked:stuck-feedback-loop` behavior to the new contract — do NOT weaken coverage; migrate it to the `remediation-limit` gate assertion.
- [ ] T018 [US3] Verify a new trusted human review/comment after the cap resets the budget: the adapter re-runs (authorship-based trigger), clears the artifact, and the next seeded round derives `round = 1` (FR-006, plan D-2). Assert thread-resolution / gate-label removal alone do NOT reset it.

---

## Phase 6: Polish & Release Gate

- [ ] T019 [P] Add `.changeset/1130-pr-feedback-remediate-routing.md`: `@generacy-ai/orchestrator` **patch** (internal service/worker changes, no new public exports) + `@generacy-ai/workflow-engine` **minor** (removal of `blocked:stuck-feedback-loop` label vocabulary). Newly-added file (the changeset gate greps `--diff-filter=A`). Re-verify both bump levels against the final diff.
- [ ] T020 Run the package test suites and confirm green: `pnpm --filter @generacy-ai/orchestrator test` and `pnpm --filter @generacy-ai/workflow-engine test`. Regression oracle (SC-006): the existing `pr-feedback-monitor-service` suites (untrusted-notice, `blocked:*` skip, adaptive interval) must remain green.

---

## Dependencies & Execution Order

**Phase order (sequential where noted)**:
- Phase 1 (Setup) → informs all later phases (flag default, consumer grep, surface confirmation).
- Phase 2 (seed module) **blocks** Phase 4 (US2 imports it).
- Phase 3 (US1) is **independent** — it only edits the monitor service and can run in parallel with Phase 2/Phase 4.
- Phase 4 (US2) **must precede** Phase 5 (US3): the shared remediate path has to be live before the divergent `blocked:stuck-feedback-loop` disposition is deleted.
- Phase 6 (changeset + full test run) is last.

**Parallel opportunities**:
- T002, T003, T004 (setup verifications) run in parallel — different concerns, read-only.
- T006 (seed tests) parallels T005 authorship once the module signature is fixed; keep in the same file group.
- US1 (T007–T009) runs fully in parallel with the US2 track (different files: monitor service vs. worker/wrapper/seed).
- T011 (parser retention in `pr-feedback-handler.ts`) parallels T010 (new wrapper file) — different files. But T011 and T015 touch the SAME file (`pr-feedback-handler.ts`) and must be sequenced: T011 (retain parser, keep compiling) before T015 (delete apply-site).
- T019 (changeset) parallels test authoring but must reflect the final diff.

**Story independence**:
- **US1** is shippable alone (stops the monitor/engine race).
- **US2** is the substantive routing change and gates **US3**.
- **US3** is cleanup/retirement that requires US2's path to be live.

## Notes

- No `packages/claude-plugin-cockpit/commands/*.md` playbook is edited by this feature → no playbook-verification re-pin task required.
- No `.specify/memory/constitution.md` in the repo → constitution gate skipped.
- All new state is checkout-local, per-job, ephemeral — no Redis keys, no PR/issue markers (data-model.md).
- Feature flag `reviewPhaseEnabled` (default OFF) keeps existing clusters byte-identical until the epic is enabled.
