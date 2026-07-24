# Tasks: Deterministic branch/spec-slug + PR dedup on speckit workflow re-entry

**Input**: Design documents from `/specs/1043-summary-when-speckit-feature/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/issue-branch-resolver.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = re-entry lands on original branch/PR; US2 = deterministic spec-slug; US3 = deferred per Q3-A)

Scope this PR: **US1 + US2 only**. US3 (FR-006, SC-004) is deferred to a follow-up gated on #849 (see `plan.md` §Deferred Clarifications and `spec.md` Clarifications Q3 → A).

---

## Phase 1: Resolver (T-1)

- [ ] T001 [US1][US2] Create `packages/workflow-engine/src/actions/builtin/speckit/lib/issue-branch-resolver.ts` exporting:
  - `ResolvedIssueBranch` type per `data-model.md` §Types added (`branchName`, `source: 'oldest-open-pr' | 'oldest-remote-branch'`, `anchoringPrNumber?`, `candidateBranchCount`, `candidatePrCount`).
  - `resolveIssueBranch({ issueNumber, owner, repo, github, git, logger? }): Promise<ResolvedIssueBranch | null>` per `contracts/issue-branch-resolver.md` §Signature.
  - Behavior: filter regex `new RegExp('^' + issueNumber + '-')`; step 1 `github.listOpenPullRequests(owner, repo)` filter + sort by `created_at` ascending; step 2 `github.listBranches(owner, repo)` filter + `git.raw(['log','-1','--format=%ct','refs/remotes/origin/<branch>'])` for timestamps, sort ascending, final tiebreak on `branchName` alphabetical.
  - Tiebreak: ≥1 PR → `oldest-open-pr`; else ≥1 branch → `oldest-remote-branch`; else `null`.
  - Error handling per contract §Error handling: `listOpenPullRequests` throws → `warn { event: 'issue-branch-resolver-pr-list-failed' }`, continue to step 2. `listBranches` throws → `warn { event: 'issue-branch-resolver-branch-list-failed' }`, return step 1 result or `null`. `git log` failure per-branch → treat that branch's timestamp as `Infinity`. Never throws.

- [ ] T002 [US1][US2] Create `packages/workflow-engine/tests/actions/speckit/issue-branch-resolver.test.ts` — 5 scenarios per `plan.md` §Testing Strategy and `contracts/issue-branch-resolver.md` §Test scenarios:
  1. Zero candidates → `null`.
  2. Branch-only, single → `{ source: 'oldest-remote-branch', candidateBranchCount: 1, candidatePrCount: 0 }`.
  3. Branch-only, multiple → oldest by commit timestamp wins; final alphabetical tiebreak validated.
  4. PR wins over branch-only → PR's branch, `source: 'oldest-open-pr'`.
  5. **The #1038 regression**: two `<N>-*` branches (`1038-issue-1038` earlier, `1038-part-cockpit-remote-gates` later), two open PRs (#1039, #1041) → returns `{ branchName: '1038-issue-1038', source: 'oldest-open-pr', anchoringPrNumber: 1039 }`.
  - Also cover: `123` filter regex does NOT match `1234-` (contract §Determinism guarantees).
  - Also cover: error-swallowing paths (both enumeration calls throw → returns `null`, no throw).

## Phase 2: `createFeature` wiring (T-2)

<!-- Depends on T-1: types + resolver must exist before wiring the callback. -->

- [ ] T003 [P] [US2] Modify `packages/workflow-engine/src/actions/builtin/speckit/types.ts` — add:
  - `export type ResolveExistingBranchCallback = (issueNumber: number) => Promise<string | null>;`
  - Optional field on `CreateFeatureInput`: `resolveExistingBranch?: ResolveExistingBranchCallback;`
  - JSDoc per `data-model.md` §`ResolveExistingBranchCallback` — return value validated against `FEATURE_NAME_PATTERN`; malformed returns treated as `null` with a warn log.

- [ ] T004 [US1][US2] Modify `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts` — in `createFeature()` (~line 273):
  - Before `buildBranchNameFromPattern()` at `feature.ts:303`, when `input.number` is present and `input.resolveExistingBranch` is defined, invoke the callback.
  - When the callback returns a non-null value that passes `FEATURE_NAME_PATTERN` validation, use it as `branchName` and skip `buildBranchNameFromPattern()`.
  - On invalid return, log `warn { event: 'issue-branch-resolver-invalid-return', returned, issueNumber }` and fall through to `buildBranchNameFromPattern()`.
  - On happy path (callback returned canonical branch and it differs from what `buildBranchNameFromPattern` would have produced), emit info log `event: 'workflow-reentry-branch-reused'` with fields `{ issueNumber, canonicalBranch, wouldHaveDerived, source?, anchoringPrNumber? }` per `data-model.md` §Structured log events. `source`/`anchoringPrNumber` are optional at this call-site (the callback returns just a string); leave them undefined if not surfaced through the callback.
  - Preserve existing idempotency check at `feature.ts:320` — under the fix, on re-entry the canonical branch is used, so the check now matches on the first attempt and re-scaffold is skipped.
  - Zero LOC touched in `generateConfigurableSlug()` / `buildBranchNameFromPattern()` (Q4-A / Constitution Check).

- [ ] T005 [US1][US2] Wire the resolver callback in the `create_feature` action wrapper — modify `packages/workflow-engine/src/actions/builtin/speckit/operations/create-feature.ts` (or, if the wrapper lives at `actions/builtin/speckit/` action-index level, that file). Concretely:
  - Where `ActionContext.github` is in scope, construct a closure `resolveExistingBranch: async (issueNumber) => { const r = await resolveIssueBranch({ issueNumber, owner, repo, github: ctx.github, git, logger }); return r?.branchName ?? null; }` and pass it via `CreateFeatureInput.resolveExistingBranch` to `executeCreateFeature`.
  - `owner` / `repo` derived from `ActionContext` per existing conventions.
  - `git` is a `simpleGit(cwd)` on the action's cwd (matches existing `feature.ts` usage).
  - Non-orchestrator callers (ad-hoc MCP tool paths) leave the field `undefined` — existing behavior preserved.

- [ ] T006 [US1][US2] Extend `packages/workflow-engine/tests/actions/speckit/deterministic.test.ts` with one new scenario per `plan.md` §Testing Strategy step 2:
  - Call `executeCreateFeature({ number: 1038, description: 'part cockpit remote gates', resolveExistingBranch: async () => '1038-issue-1038' })` on a fixture repo that already has `specs/1038-issue-1038/`.
  - Assert: no new branch cut (`git.checkoutLocalBranch` NOT called with `1038-part-cockpit-remote-gates`); `git.checkout('1038-issue-1038')` used instead; existing `specs/1038-issue-1038/` re-used; return payload's `branch_name === '1038-issue-1038'`.
  - Assert log line: `event: 'workflow-reentry-branch-reused'` emitted with `{ issueNumber: 1038, canonicalBranch: '1038-issue-1038', wouldHaveDerived: '1038-part-cockpit-remote-gates' }`.
  - Additional assertion: when the callback returns a value failing `FEATURE_NAME_PATTERN` (e.g., `'not-a-slug!'`), createFeature falls back to slug derivation AND emits the `issue-branch-resolver-invalid-return` warn.

## Phase 3: `PrManager` defense-in-depth (T-3)

<!-- Depends on T-1 only; parallel-safe with Phase 2. -->

- [ ] T007 [P] [US1] Modify `packages/orchestrator/src/worker/pr-manager.ts::ensureDraftPr()` (~line 139):
  - Before `findPRForBranch(currentBranch)` at `pr-manager.ts:149`, call `resolveIssueBranch({ issueNumber: this.issueNumber, owner: this.owner, repo: this.repo, github: this.github, git: simpleGit(this.cwd), logger: this.logger })`. (Use the fields already on the class; add `simple-git` import if not already present — package already depends on it.)
  - If the resolver returns a `ResolvedIssueBranch` whose `branchName !== await this.github.getCurrentBranch()`: emit `event: 'workflow-reentry-branch-mismatch'` with all fields per `data-model.md` (`issueNumber`, `currentBranch`, `canonicalBranch`, `source`, `anchoringPrNumber?`, `action`), then call `findPRForBranch(canonicalBranch)`. If that PR exists, adopt it (return the PR object; `action: 'adopted'`). If it does not exist, log `warn` and fall through with `action: 'no-op'` — do NOT open a new PR in the mismatch case.
  - If the resolver returns `null` OR returns a `branchName === currentBranch`: existing behavior (`findPRForBranch(currentBranch)`; if null → `createPullRequest`).
  - Auto-adopt is the D-3 choice (`plan.md` §D-3): never throw, never open a duplicate PR when the resolver disagrees.
  - No new constructor args or public methods (`data-model.md` §Modified types).

- [ ] T008 [US1] Create `packages/orchestrator/src/__tests__/pr-manager-issue-dedup.test.ts` — 1+ scenarios per `plan.md` §Testing Strategy step 3:
  - Fake `GitHubClient` reports two open PRs on `<N>-*` branches (mirror the #1038 shape: PRs on `1038-issue-1038` and `1038-part-cockpit-remote-gates`, current branch is the newer one).
  - Assert: `ensureDraftPr()` returns the older PR; `createPullRequest` is NEVER called; `event: 'workflow-reentry-branch-mismatch'` emitted with `action: 'adopted'`.
  - Additional case: resolver returns a canonical branch whose `findPRForBranch` returns null → log `warn`, `action: 'no-op'`, still no `createPullRequest` call.
  - Additional case: resolver returns `null` → existing behavior preserved; no mismatch event; `findPRForBranch(currentBranch)` reached.

## Phase 4: Changeset (T-4)

<!-- Depends on Phases 2 and 3 (both source edits must exist before the changeset lists them). -->

- [ ] T009 [US1][US2] Create `.changeset/1043-deterministic-branch-pr-dedup.md` per CLAUDE.md gate and `plan.md` §Constitution Check:
  - `@generacy-ai/workflow-engine`: **minor** (new public capability — optional `resolveExistingBranch` callback on `CreateFeatureInput`).
  - `@generacy-ai/orchestrator`: **patch** (internal fix to `PrManager.ensureDraftPr()`; no new exports).
  - Body: one-line summary of the fix + link to #1043.
  - MUST be a newly added file in the diff (`--diff-filter=A`), not an edit to an existing changeset.

## Phase 5: Verification

<!-- Runs after all source + test edits. Non-source verification only. -->

- [ ] T010 [US1][US2] Run the three test suites listed in `quickstart.md` §Unit-level:
  ```
  pnpm --filter @generacy-ai/workflow-engine test issue-branch-resolver
  pnpm --filter @generacy-ai/workflow-engine test deterministic
  pnpm --filter @generacy-ai/orchestrator test pr-manager-issue-dedup
  ```
  All three MUST be green. Fix any failures at the source (do not weaken assertions to make tests pass).

- [ ] T011 [US1][US2] Verify Constitution Check items pass (`plan.md` §Constitution Check):
  - Changeset file is newly added and lists both packages with correct bump levels.
  - Zero LOC touched in `generateConfigurableSlug()` / `buildBranchNameFromPattern()` (Q4-A).
  - No new dependencies added to any `package.json`.
  - Resolver never reads cockpit claim state (Observer independence, upheld from #1015).

- [ ] T012 [US1][US2] Structured-log smoke check per `quickstart.md` §Structured log queries — inspect the two events wired in T004 and T007 fire with the exact shapes documented in `data-model.md` §Structured log events (`workflow-reentry-branch-reused` from `createFeature`; `workflow-reentry-branch-mismatch` from `PrManager`). The test assertions in T006 and T008 satisfy this; this task is a manual review that the field names match `data-model.md` verbatim (grep-friendly for SC-003 / SC-005 alerting).

## Dependencies & Execution Order

**Sequential phases**: Phase 1 → (Phase 2, Phase 3 in parallel) → Phase 4 → Phase 5.

**Within Phase 1**: T001 before T002 (test imports the resolver).

**Within Phase 2**: T003 (types) before T004 (feature.ts) before T005 (action wiring) before T006 (tests). T003 is `[P]`-eligible against T007 in Phase 3 (disjoint files).

**Within Phase 3**: T007 before T008. T007 is `[P]`-eligible against T003/T004/T005/T006 in Phase 2 (disjoint files).

**Phase 4**: T009 waits on both Phase 2 and Phase 3 completing so the changeset accurately lists every touched package.

**Phase 5**: T010–T012 run after all source and test files exist. Deferred: US3 tasks (regression test for gate re-cycle) are NOT in this PR per Q3-A.

## Parallel Opportunities

- T003 (types.ts) ‖ T007 (pr-manager.ts) — disjoint files, both depend only on T001.
- T006 (deterministic.test.ts) ‖ T008 (pr-manager-issue-dedup.test.ts) — disjoint test files.

## Explicitly Out of Scope (from `spec.md` §Out of Scope + `plan.md` §Out of Scope for This PR)

- US3 / FR-006 acceptance test — deferred to follow-up gated on #849.
- Cleanup of pre-existing duplicate `specs/<N>-*` directories on historical branches.
- Backfill renames on branches created before this fix ships.
- Changes to `cockpit_merge` picker logic or `cockpit_status` behavior.
- Slug-generation algorithm changes (Q4-A: reuse existing derivation).
