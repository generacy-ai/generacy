# Tasks: Keep engine bookkeeping sidecars out of PR branches

**Input**: Design documents from `/specs/1162-severity-major-p1-engine/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

All work is orchestrator-internal under `packages/orchestrator/src/worker/`. Line refs are on
this branch (not spec line refs).

## Phase 1: Foundation — shared sidecar predicate

<!-- Phase boundary: Complete Phase 1 before starting Phase 2 -->

- [ ] T001 [US1] In `packages/orchestrator/src/worker/product-diff.ts`, add the single source
  of truth for the three sidecar patterns and fold it into the product-diff exclusion (FR-001,
  FR-004, Decision 1):
    - `export const ENGINE_SIDECAR_PREFIXES = ['.generacy/review-findings-', '.generacy/review-candidate-', '.generacy/pause-context-'] as const;`
    - `export function isEngineSidecar(p: string): boolean` → `ENGINE_SIDECAR_PREFIXES.some(prefix => p.startsWith(prefix))`.
    - Extend `EXCLUDED_PATH_PREFIXES` to `['specs/', ...ENGINE_SIDECAR_PREFIXES]` so
      `isProductFile()` returns `false` for any sidecar path but keeps `.generacy/config.yaml`
      and `.generacy/epics/*` as product files (Q3). Keep literal `startsWith` — no glob/regex.

## Phase 2: Staging filter (US1 primary) + product-diff exclusion tests

<!-- Phase boundary: T001 must land before Phase 2. T002/T004 are parallel (different files). -->

- [ ] T002 [US1] In `packages/orchestrator/src/worker/pr-manager.ts`, `commitAndPush` (~`:125`,
  `stageAll()` at ~`:136`): replace the unscoped `stageAll()` with a targeted, filtered stage
  (FR-001, FR-002, contract `staging-filter.md`, Decision 2):
    - `const status = await this.github.getStatus();`
    - `const toStage = [...status.unstaged, ...status.untracked].filter(p => !isEngineSidecar(p));`
    - Commit only when `toStage.length > 0` (call `stageFiles(toStage)` then `commit(message)`
      and set `committed = true`); a sidecar-only phase must produce **no** commit (G3, no empty
      commits).
    - Deletions in `status.unstaged` are staged by `git add <path>` — do not drop them (G2).
    - Leave the downstream unpushed-commit detection + #1051 push guard (`:148-161`) unchanged (G5).
    - Import `isEngineSidecar` from `product-diff.ts`.

- [ ] T003 [US1] Add `packages/orchestrator/src/worker/__tests__/pr-manager.staging-filter.test.ts`
  (SC-001, SC-004, contract `staging-filter.md`):
    - Sidecars (`review-findings-*`, `review-candidate-*`, `pause-context-*`) reported in
      status are never passed to `stageFiles` / never committed (SC-001).
    - Genuine product edits (modify, add, delete) are still staged and committed (SC-004, G2).
    - Sidecar-only phase ⇒ `stageFiles` called with `[]` (or not called) and **no** commit (G3).
    - `.generacy/config.yaml` modification ⇒ staged and committed (G4).

- [ ] T004 [P] [US1] Add `packages/orchestrator/src/worker/__tests__/product-diff.test.ts`
  (SC-002): each sidecar prefix ⇒ `isProductFile` returns `false` / `isEngineSidecar` returns
  `true`; `.generacy/config.yaml` and `.generacy/epics/foo.md` remain product files; assert the
  raw-validate-stderr-carrying findings sidecar is excluded from the review-round diff so the
  stderr tail never reaches the reviewed files (SC-002).

## Phase 3: Redis-backed remediation counter (US2)

<!-- Phase boundary: Phase 3 is independent of Phase 2's staging change but both depend on T001's exports only for imports; sequence T005 → T006 (T006 uses seedRemediationCount). -->

- [ ] T005 [US2] In `packages/orchestrator/src/worker/review-artifact.ts`, add
  `seedRemediationCount(checkoutPath, workflowId, count)` mirroring `bumpRemediationCount` /
  `resetRemediationCount` (disk read → set `remediationCount := count` → atomic temp+rename).
  Keep the file Redis-free (FR-003 G5, Decision 3). Preserve `.default(0)` back-compat parsing.

- [ ] T006 [US2] In `packages/orchestrator/src/worker/phase-loop.ts`, add the Redis mirror +
  reconcile + reset for `remediationCount`, keyed
  `remediation-count:${owner}:${repo}:${issueNumber}:${branch}` (`branch = context.branch ?? 'no-branch'`),
  TTL `PHASE_START_REF_TTL_SECONDS`, via `deps.phaseTracker` — best-effort no-op when Redis is
  down (FR-003, contract `remediation-count-key.md`, Decision 3). Mirror the existing
  `review-findings:` pattern at ~`:1985`:
    - **Mirror (write)**: immediately after the remediate executor returns in the seam (~`:1751`),
      read the post-bump disk count via `readReviewArtifactSync` and
      `await deps.phaseTracker?.setValueRaw(key, String(count), TTL)`.
    - **Reconcile (re-entry)**: at the top of the `on-remediation-limit` gate check (~`:1428`,
      before `readReviewArtifactSync`), `redis = getValueRaw(key)`; if present and `redis > disk`,
      `seedRemediationCount(disk := redis)` so the synchronous gate reader observes the durable
      count (`max(disk, redis)`; never lowers a spent budget — G2/G4).
    - **Reset**: in the `completed:remediation-limit` gate-resume branch (~`:1545-1558`), alongside
      the existing `resetRemediationCount`, `await deps.phaseTracker?.clearRaw(key)` (G3 reset).

- [ ] T007 [US2] Add `packages/orchestrator/src/worker/__tests__/phase-loop.remediation-persist.test.ts`
  (SC-003, contract `remediation-count-key.md`):
    - Persist count = N via the mirror; simulate re-clone (delete disk sidecar); on gate entry
      the reconciled count = N and the cap fires at the same effective attempt (G1).
    - Redis-down (`getValueRaw` returns null) ⇒ gate falls back to disk value, no crash (G3).
    - `completed:remediation-limit` resume ⇒ disk = 0 **and** `clearRaw` invoked (reset).

## Phase 4: Pre-shipped repo disposition (US3)

<!-- Phase boundary: Independent of code changes; can run any time after Phase 1. -->

- [ ] T008 [P] [US3] Verify `specs/1162-severity-major-p1-engine/scripts/cleanup-committed-sidecars.sh`
  (already scaffolded) removes committed `.generacy/review-findings-*`, `review-candidate-*`, and
  `pause-context-*` via `git rm`, and that `quickstart.md` documents it as the one-time manual
  step (FR-005/Q4=C). No automated engine `git rm` — the FR-004 exclusion (T001) already
  neutralizes pre-existing committed sidecars at review time.

## Phase 5: Verification & release gate

<!-- Phase boundary: After Phases 1–4. -->

- [ ] T009 Add `.changeset/1162-engine-sidecar-staging.md` — `@generacy-ai/orchestrator`
  **patch** (`workflow:speckit-bugfix`; internal commit-path + product-diff + phase-loop fix,
  no new public exports). Newly added file in the PR diff — required by the CI changeset gate
  (the three touched `src/` files are non-test). Single package.

- [ ] T010 Run `pnpm --filter @generacy-ai/orchestrator test` (the three new test files) and
  `pnpm --filter @generacy-ai/orchestrator typecheck`/`lint`; confirm SC-001..SC-004 pass and
  no existing phase-loop / pr-manager tests regress. Confirm the research open items:
  `GitStatus.unstaged` reports deletions so filtered staging still commits removals; the
  empty-stage caveat is covered; `PhaseTracker.clearRaw` exists and is best-effort.

## Dependencies & Execution Order

**Sequential backbone**:
- T001 (shared predicate + exclusion) → everything that imports `isEngineSidecar`.
- T002 (staging filter) → T003 (its test).
- T005 (`seedRemediationCount`) → T006 (phase-loop mirror/reconcile/reset) → T007 (its test).
- T009 changeset + T010 verification last.

**Parallel opportunities**:
- **[P] T004** (product-diff test) runs parallel to T002/T003 — different file.
- **[P] T008** (cleanup-script/doc verification) is independent of all code changes.
- Phase 2 (staging, US1) and Phase 3 (counter, US2) touch disjoint files after T001 and can
  proceed concurrently; only shared dependency is T001's exports (imports only).

**Story coverage**:
- US1 → T001, T002, T003, T004.
- US2 → T005, T006, T007.
- US3 → T008 (+ T001's FR-004 exclusion).
