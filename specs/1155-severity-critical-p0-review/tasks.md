# Tasks: Review executor must fail (not falsely pass) on CLI failure, timeout, or missing findings

**Input**: Design documents from `/specs/1155-severity-critical-p0-review/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, clarifications.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup

- [ ] T001 [P] Add changeset `.changeset/1155-review-executor-phantom-clean.md` — `@generacy-ai/orchestrator` **patch** (`workflow:speckit-bugfix` defect fix; new helpers are internal worker surface, not re-exported from the package public `index.ts`, so `patch` per CLAUDE.md). Summary: review executor no longer reports a phantom `clean` verdict on CLI failure / timeout / missing-fresh-candidate; propagates the real exit code and reads a separate candidate sidecar path.

## Phase 2: Core Implementation — `review-artifact.ts` (US2, US3)
<!-- The executor (Phase 3) depends on the helpers + return-type change added here. -->

- [ ] T002 [US2] In `packages/orchestrator/src/worker/review-artifact.ts` add `getReviewCandidateRelPath(workflowId): string` returning `.generacy/review-candidate-<sanitizeWorkflowId(workflowId)>.json` (mirror `getReviewArtifactRelPath`, prefix `review-candidate-`, same `[^a-zA-Z0-9_-] → _` sanitization). Pure.
- [ ] T003 [US2] In `packages/orchestrator/src/worker/review-artifact.ts` add `getReviewCandidatePath(checkoutPath, workflowId): string` = `path.join(checkoutPath, getReviewCandidateRelPath(workflowId))` (mirror `getReviewArtifactPath`). Pure.
- [ ] T004 [US3] In `packages/orchestrator/src/worker/review-artifact.ts` add `clearReviewCandidate(checkoutPath, workflowId): Promise<void>` = `fs.unlink(getReviewCandidatePath(...))`; idempotent — swallow `ENOENT`, rethrow any other error (mirror `clearReviewArtifact`).
- [ ] T005 [US2] In `packages/orchestrator/src/worker/review-artifact.ts` change `readCandidateFindings(checkoutPath, workflowId, round)` to read `getReviewCandidatePath(...)` (was `getReviewArtifactPath`) and return `Promise<ReviewFinding[] | null>`: `null` on missing / unreadable / invalid-JSON / schema-invalid (no proof of review); `ReviewFinding[]` (possibly `[]`) on a valid `CandidateArtifactSchema` parse. Keep stamping unchanged (per-finding `round ?? <round arg>`, `status ?? 'open'`; ignore agent-claimed top-level `verdict`/`round`). Never throws. This is the root-cause fix — `[]`-on-everything must no longer conflate "agent died" with "reviewed, zero findings".

## Phase 3: Core Implementation — `review-executor.ts` (US1)
<!-- Depends on Phase 2 helpers + the readCandidateFindings null contract. -->

- [ ] T006 [US1] In `packages/orchestrator/src/worker/review-executor.ts` set the charter write target `sidecarRelPath = getReviewCandidateRelPath(workflowId)` (was `getReviewArtifactRelPath`). Caller-supplied value change only — do NOT edit charter prompt text (Out of Scope). Satisfies INV-5 (agent only ever writes the candidate path).
- [ ] T007 [US1] In `packages/orchestrator/src/worker/review-executor.ts` add a pre-spawn `await clearReviewCandidate(checkoutPath, workflowId)` immediately before spawning the CLI, so any candidate present after the spawn is provably written this round (guards against a stale candidate lingering from a crashed prior round).
- [ ] T008 [US1] In `packages/orchestrator/src/worker/review-executor.ts` replace the hardcoded normal-exit return `{ success: true, exitCode: 0 }` (`:259-265`) with the post-exit gate. Read `const findings = await readCandidateFindings(...)` (now `ReviewFinding[] | null`). Single gate: `if (exitCode !== 0 || findings === null)` ⇒ persist NOTHING and return `{ phase: 'review', success: false, exitCode: exitCode ?? -1, durationMs, output }` (prior-round artifact incl. `round`/`remediationCount` left exactly as-is; `round` does not advance). Mirror `remediate-executor.ts:225-231`. Satisfies FR-001, FR-002 (incl. exit-0-no-candidate gap), INV-1/INV-2/INV-3.
- [ ] T009 [US1] In `packages/orchestrator/src/worker/review-executor.ts` implement the success branch of the gate (exit 0 AND fresh candidate, possibly `[]`): `verdict = computeVerdict(findings, blockingSeverity)`; `lastReviewedCommitSha = await context.github.getCurrentCommitSha()`; `await writeReviewArtifact(..., { findings, verdict, round, lastReviewedCommitSha, remediationCount: priorRound?.remediationCount ?? 0 })` (round advances, remediationCount carried forward); `await clearReviewCandidate(...)`; return `{ phase: 'review', success: true, exitCode: 0, durationMs, output }`. Preserve untouched: #1131 empty-window short-circuit (`:90-105`), spawn-failure return (`:155-170`), wait-error return (`:208-222`). Satisfies FR-007, INV-4.

## Phase 4: Regression Tests (FR-006)
<!-- Depend on Phases 2-3 implementation. T010 and T011 touch different test files → parallel. -->

- [ ] T010 [P] [US2] In `packages/orchestrator/src/worker/__tests__/review-artifact.test.ts` add/adjust tests for the new candidate surface: `getReviewCandidateRelPath`/`getReviewCandidatePath` produce the sanitized `review-candidate-<id>.json` path distinct from the engine artifact path; `clearReviewCandidate` is idempotent (no throw on missing file); `readCandidateFindings` returns `null` for missing / unreadable / invalid-JSON / schema-invalid candidate, `[]` for a valid empty-findings candidate, and `ReviewFinding[]` for populated findings (the null-vs-`[]` split from data-model.md). Covers SC-002 root cause.
- [ ] T011 [US1] In `packages/orchestrator/src/worker/__tests__/review-executor.test.ts` add the FR-006 regression cases from quickstart.md: (a) **missing sidecar** — agent exits 0 writes no candidate ⇒ `success: false`, no artifact, no `clean`; (b) **non-zero exit** — exits 1 ⇒ `success: false, exitCode: 1`, no artifact; (c) **timeout** — SIGTERM/SIGKILL ⇒ `success: false`, no artifact; (d) **round ≥ 2 no-op** — prior engine artifact exists, agent writes no candidate ⇒ `readCandidateFindings → null`, `success: false`, prior artifact + `remediationCount` untouched (SC-002/SC-003); (e) **crash window** — engine artifact intact, candidate half-written/invalid ⇒ engine artifact + `remediationCount` preserved, candidate → `null` → `success: false` (SC-003). Covers SC-001.
- [ ] T012 [US1] Update the existing SC-004 no-regression test in `packages/orchestrator/src/worker/__tests__/review-executor.test.ts` (engine recomputes verdict, ignoring agent-claimed `verdict`): repoint the fake launcher's write target from `getReviewArtifactPath` to the new candidate path, and assert the happy path still produces a byte-identical artifact + `success: true` (FR-007, SC-004). Do NOT weaken the recompute assertion — repoint the write target only.

## Phase 5: Verification

- [ ] T013 Build + run the affected suites green: `pnpm --filter @generacy-ai/orchestrator build`, `pnpm --filter @generacy-ai/orchestrator test review-executor`, `pnpm --filter @generacy-ai/orchestrator test review-artifact`. Confirm all FR-006 regression cases pass and pre-existing review-executor/phase-loop tests remain green (SC-004 no diff). Verify the changeset file is a newly ADDED `.changeset/*.md` (CI gate greps `--diff-filter=A`).

## Dependencies & Execution Order

**Sequential chain**:
- **Phase 1 (T001)** is independent — can be done any time (marked `[P]`).
- **Phase 2 (T002–T005)** must land before **Phase 3 (T006–T009)**: the executor consumes the new candidate-path helpers and the `readCandidateFindings` `null` contract.
  - T002 → T003 (T003 calls T002). T004 depends on T003. T005 depends on T002/T003.
- **Phase 3 (T006–T009)** must land before **Phase 4 tests (T011, T012)**: the regression + SC-004 tests exercise the new executor behavior.
  - T006, T007, T008, T009 all edit the same file (`review-executor.ts`) — do them in order in one session, not in parallel.
- **Phase 4**: T010 (review-artifact.test.ts) is `[P]` with T011/T012 (review-executor.test.ts) — different files. T011 and T012 share `review-executor.test.ts` → sequential.
- **Phase 5 (T013)** last — verifies everything.

**Parallel opportunities**:
- T001 (changeset) alongside any implementation task.
- T010 in parallel with T011/T012 (distinct test files).

**Suggested next step**: `/speckit:implement` to begin execution.
