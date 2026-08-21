# Tasks: Wire the PR review-posting + draft/ready lifecycle (readFindingsArtifact never supplied)

**Input**: Design documents from `/specs/1156-severity-critical-p0-entire/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

All paths are relative to `packages/orchestrator/src/worker/`. All line refs at develop `155b3464`.

## Phase 1: Setup

- [ ] T001 [P] Add changeset `.changeset/1156-wire-review-posting-lifecycle.md` — `@generacy-ai/orchestrator` **patch** (`workflow:speckit-bugfix`; wires an already-shipped-but-dead path, no new public exports). Required by the CI changeset gate.

## Phase 2: Foundational (shared prerequisite — blocks US3 cross-run persistence)

- [ ] T002 [US3] In `review-artifact.ts`: add `markedReadyByEngine: z.boolean().default(false)` to `ReviewArtifactSchema` (FR-006; `.default(false)` is load-bearing so pre-#1156 artifacts still `safeParse`). Add `setMarkedReadyByEngine(checkoutPath, workflowId, value)` helper — read via `readReviewArtifact`, spread `{ ...artifact, markedReadyByEngine: value }`, atomic `writeReviewArtifact`; null-safe no-op when no artifact exists (D-6).

## Phase 3: Components (parallelizable — distinct files)

- [ ] T003 [P] [US1] NEW `review-findings-bridge.ts`: pure module (zero I/O). Export `synthesizeMarker(file, title)` = `createHash('sha256').update(`${file}\0${title}`).digest('hex').slice(0, 24)` (FR-003, D-3) and `bridgeReviewArtifact(artifact, blockingSeverity): FindingsArtifact` (FR-002, D-2). Per finding: `marker = synthesizeMarker(file, title)`, `text = `${title}\n\n${detail}``, `severity = SEVERITY_RANK[severity] >= SEVERITY_RANK[blockingSeverity] ? 'blocking' : 'advisory'` (reuse exported `SEVERITY_RANK` from `review-artifact.ts:272`), `anchor = line !== undefined ? { file, line } : undefined`, `resolved = status === 'resolved'`. Pass `verdict` through. Never drop a finding (SC-002), never throw on schema-valid input. See `contracts/review-findings-bridge.md`.

- [ ] T004 [P] [US3] In `review-poster.ts`: change `ReviewPosterDeps.prNumber: number` → `getPrNumber: () => number | undefined` (FR-004, D-4). At the top of **both** `postRound` and `resolveResolvedThreads`: `const prNumber = this.getPrNumber(); if (prNumber === undefined) { this.logger.debug(...); return; }`. Replace every internal `this.prNumber` (3× in `postRound`, 1× in `resolveResolvedThreads`) with the resolved local. Public method surface unchanged (SC-003). See `contracts/review-poster.md`.

- [ ] T005 [US3] In `review-executor.ts`: in the round-rewrite explicit-object write (`review-executor.ts:244-250`), add `markedReadyByEngine: priorRound?.markedReadyByEngine ?? false` so the flag is carried forward and not reset each re-review pass (D-7). Depends on T002.

- [ ] T006 [US3] In `pr-manager.ts`: add optional `workflowId?` ctor arg. On `markReadyForReview` success → set in-memory flag `true` **and** call `setMarkedReadyByEngine(checkoutPath, workflowId, true)` (best-effort, skipped if either path component absent). In `convertToDraftIfEngineMarkedReady`: when the in-memory flag is `false` but `checkoutPath`+`workflowId` present, reconstruct from `readReviewArtifact(...)?.markedReadyByEngine`; on successful convert set in-memory `false` **and** `setMarkedReadyByEngine(..., false)`. Never demote a human-marked-ready PR (FR-007 — sidecar flag is only ever written `true` by the engine's own `markReadyForReview`). Depends on T002.

## Phase 4: Integration wiring

- [ ] T007 [US1] In `phase-loop.ts` review side-effect block (`:1591-1607`): re-key to the new reader shape. `const read = await deps.readFindingsArtifact(context); if (read) { const { artifact, round } = read; await deps.reviewPoster.postRound(artifact, round); if (round >= 2) await deps.reviewPoster.resolveResolvedThreads(artifact); if (artifact.verdict === 'clean') await prManager.markReadyForReview(context.linkedPRs); }`. Round now comes from the sidecar (FR-005), not the loop-local `reviewRound`. Guard unchanged (`phase === 'review' && result.success && deps.readFindingsArtifact && deps.reviewPoster`). See `contracts/read-findings-artifact.md` §Block consumption. Depends on T003.

- [ ] T008 [US1] In `claude-cli-worker.ts` wiring site (`:848-898`): (a) construct `ReviewPoster` with `getPrNumber: () => prManager.getPrNumber()` (FR-004); (b) pass `workflowId` (`${owner}/${repo}#${issueNumber}`) to `PrManager` (FR-006); (c) supply the `readFindingsArtifact` closure (FR-001) — read `readReviewArtifact(ctx.checkoutPath, `${ctx.item.owner}/${ctx.item.repo}#${ctx.item.issueNumber}`)`, return `null` on null, else `{ artifact: bridgeReviewArtifact(artifact, blockingSeverity), round: artifact.round }`. Resolve `blockingSeverity` once via `resolveWorkflowOverrides(effectiveConfig, orchSettings, item.workflowName).review.blockingSeverity` and close over it. Depends on T003, T004, T006.

## Phase 5: Tests

- [ ] T009 [P] [US1] NEW `__tests__/review-findings-bridge.test.ts` (SC-002): every input finding lands in output (`findings.length` equal); severity-threshold matrix (`critical/major/minor` × `blockingSeverity ∈ {critical, major, minor}`, per `contracts/review-findings-bridge.md`); anchor present iff `line` present; `status:'resolved'` → `resolved:true`; marker stable across `line`/`detail` drift and distinct across differing `title`/`file`.

- [ ] T010 [P] [US3] NEW `__tests__/review-poster.get-pr-number.test.ts` (SC-003): getter returning `undefined` → no `createReview` / `getPRReviewThreads` / `resolveReviewThread` call; getter returning a real number mid-flow → post/resolve targets that number; never PR #0.

- [ ] T011 [P] [US3] NEW `__tests__/review-artifact.marked-ready.test.ts`: round-trip persist/read of `markedReadyByEngine`; a pre-#1156 artifact with no field parses with `false` (back-compat); carry-forward across a simulated executor rewrite.

- [ ] T012 [P] [US3] NEW `__tests__/pr-manager.cross-run-draft.test.ts` (SC-005/SC-006): fresh `PrManager` (in-memory flag `false`) + sidecar `markedReadyByEngine:true` → `convertPullRequestToDraft` fires; sidecar flag `false` (human ready) → convert no-ops.

- [ ] T013 [US1] [US2] [US3] MOD `__tests__/phase-loop.review-side-effects.test.ts`: reader now returns `{ artifact, round }`. SC-001 clean verdict → exactly one `createReview` with `event:'COMMENT'` + `markReadyForReview` called (US2). SC-004 re-entry with sidecar `round >= 2` → fresh post (no dedupe-skip) + `resolveResolvedThreads` invoked. Depends on T007, T008.

- [ ] T014 [US1] Update existing tests in lockstep for the two surface changes (getter + `{ artifact, round }`): `phase-loop.review-clean.integration.test.ts`, `phase-loop.merge-conflict-scoped-review.*`, `phase-loop.review-remediate.*`, `phase-loop.review-remediate-convergence.*`, `phase-loop.remediation-cap.*`, and `__tests__/helpers/bugfix-harness.ts` (`makeFindingsReader`). Each constructs `new ReviewPoster({ ...prNumber... })` and/or injects `readFindingsArtifact` returning a bare `FindingsArtifact` — convert to the getter + `{ artifact, round }` return. Depends on T004, T007, T008.

## Phase 6: Verification

- [ ] T015 Run `pnpm --filter @generacy-ai/orchestrator build && pnpm --filter @generacy-ai/orchestrator test`; confirm all new/updated tests green and no type errors. Verify the changeset is a newly-added file (`changeset status`). Sanity-check FR-009 inertness holds (block no-ops when `reviewPhaseEnabled=false` or no sidecar produced).

## Dependencies & Execution Order

**Sequential backbone**:
- T002 (schema field + helper) blocks T005, T006 (both call the new helper / field).
- T003 (bridge) blocks T007 (block re-key) and T008 (worker closure).
- T004, T006 block T008 (worker constructs poster with getter + passes workflowId).
- T007, T008 block T013, T014 (integration tests exercise the wired flow).

**Parallel opportunities**:
- T001 (changeset) is independent — do any time.
- Phase 3 components T003 / T004 are `[P]` (distinct files, no shared deps); T005 and T006 both depend on T002 but touch different files, so they can run in parallel with each other once T002 lands.
- Phase 5 unit tests T009 / T010 / T011 / T012 are `[P]` (distinct new files, each pins one component); they only need their respective component tasks done (T003 / T004 / T002 / T006).

**Suggested flow**: T001 → T002 → (T003 ‖ T004 ‖ T005 ‖ T006) → T007 → T008 → (T009 ‖ T010 ‖ T011 ‖ T012) → T013 → T014 → T015.
