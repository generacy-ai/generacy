# Tasks: Spec-stage commits must not carry repo-root agent-context files; fix the dead #899 drift guard

**Input**: Design documents from `/specs/1218-problem-two-gaps-let/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup

- [X] T001 Baseline build so cross-package imports resolve: `pnpm install` then
  `pnpm --filter @generacy-ai/workflow-engine build` (orchestrator resolves `GitHubClient`
  from workflow-engine's built `dist/`; rebuild after every interface change — see
  quickstart.md).

## Phase 2: workflow-engine client — `revertPaths` (US1)
<!-- Blocks Phase 3: pr-manager calls this method. -->

- [X] T002 [US1] Add `revertPaths(paths: string[]): Promise<void>` declaration to the
  `GitHubClient` interface in
  `packages/workflow-engine/src/actions/github/client/interface.ts`, with the doc comment from
  data-model.md (tracked → restore to HEAD; untracked/staged-new → delete; empty array is a
  no-op). Confirm the interface is re-exported from the package public `index.ts` (drives the
  `minor` bump).
- [X] T003 [US1] Implement `revertPaths` in `GhCliGitHubClient`
  (`packages/workflow-engine/src/actions/github/client/gh-cli.ts`) following research.md D5:
  (1) return early on empty; (2) `git reset -q HEAD -- <paths>`; (3) partition via
  `git ls-files -- <paths>`; (4) `git checkout -- <tracked>`; (5) `rm -f` untracked via
  `node:fs/promises`. Throws on git failure (caller treats as non-fatal).
- [X] T004 [P] [US1] NEW behavioral test
  `packages/workflow-engine/src/actions/github/client/__tests__/gh-cli.revert-paths.test.ts`
  (real temp git repo, following the Layer-2 pattern in `managed-file-disjointness.test.ts`):
  tracked-modified restored; untracked deleted; staged-new unstaged-then-deleted; mixed call;
  empty call is a no-op (SC-001 client half).
- [X] T005 [US1] Rebuild workflow-engine (`pnpm --filter @generacy-ai/workflow-engine build`)
  so the new `revertPaths` member is visible to orchestrator typechecking/tests.

## Phase 3: orchestrator pr-manager guard (US1)
<!-- Phase boundary: Phase 2 must complete (revertPaths must exist on the client). -->

- [X] T006 [US1] Add the spec-stage exclude-and-revert guard to `commitAndPush` in
  `packages/orchestrator/src/worker/pr-manager.ts` (plan.md sketch): derive
  `isSpecStage = PHASE_TO_STAGE[phase] !== 'implementation'` (from `worker/types.ts`); import
  `EXCLUDED_EXACT_PATHS` from `worker/product-diff.ts` (do not duplicate — FR-001); partition
  the existing sidecar-filtered candidates into `excluded` (spec-stage only) vs `toStage`;
  stage/commit `toStage` exactly as today; then, when `excluded.length > 0`, log an
  `logger.warn` naming the reverted paths (FR-003) and call `this.github.revertPaths(excluded)`
  in its own try/catch (non-fatal — FR-002, D4). An exclusion-emptied commit proceeds as a
  normal `no-changes` outcome (FR-001/Q3).
- [X] T007 [US1] Add the Q2 limitation comment beside the filter in `pr-manager.ts`: this is a
  staging filter only — commits the phase agent made directly are pushed as-is; the prompt-side
  pin lives in agency (agency#511) (FR-004).
- [X] T008 [P] [US1] NEW test
  `packages/orchestrator/src/worker/__tests__/pr-manager.agent-context-revert.test.ts` (mock
  `GitHubClient`, same style as `pr-manager.staging-filter.test.ts`) covering plan.md test plan
  (SC-001/SC-004): plan phase dirty `CLAUDE.md` + `specs/x/stack.md` → only `stack.md`
  staged/committed, `revertPaths(['CLAUDE.md'])`, warn logged; all four `EXCLUDED_EXACT_PATHS`
  across staged/unstaged/untracked → none staged, all reverted; `specify`/`clarify`/`tasks`
  guarded identically; `implement` phase dirty `CLAUDE.md` → committed unchanged, `revertPaths`
  never called; exclusion-emptied commit → no stage/commit, `revertPaths` called, warn logged,
  outcome `no-changes`; `revertPaths` rejects → product commit + push still complete, warn
  logged.

## Phase 4: Dead #899 Layer-1 guard removal & documentation (US2)
<!-- Independent of Phases 2-3; can run in parallel with them. -->

- [X] T009 [P] [US2] Remove the `Layer 1 — static-grep drift guard` describe block (the
  `operations/plan.ts` / `buildPlanPrompt` grep) from
  `packages/workflow-engine/src/actions/builtin/speckit/__tests__/managed-file-disjointness.test.ts`;
  retain Layer 2 (merge-tree simulation) verbatim (FR-005/FR-007). Rewrite the test file header
  comment to state the prompt-side invariant is pinned in agency (`agency-plugin-spec-kit`
  tests, agency#511) and the engine-side invariant is the pr-manager revert + its behavioral
  unit tests (FR-006). Result: zero references to `operations/plan.ts` / `buildPlanPrompt`
  (SC-003).
- [X] T010 [P] [US2] Update
  `specs/899-found-during-cockpit-v1/contracts/merge-tree-invariant.md` to re-document where
  each layer of the invariant now lives (prompt-side → agency; engine-side → pr-manager revert
  + behavioral tests; Layer 2 merge-tree simulation retained) (FR-006).
- [X] T011 [P] [US2] Update the `CLAUDE.md` pointer paragraph (lines 5–11, "Per-feature
  technology notes") with a single line noting spec-stage phase commits exclude/revert repo-root
  agent-context files (FR-008; keep it one line per CLAUDE.md's own rules; no `docs/` hits per
  research.md D7).

## Phase 5: Verification & release plumbing
<!-- Phase boundary: all code/test/doc edits complete. -->

- [X] T012 [P] Add NEW changeset `.changeset/1218-agent-context-guard.md` (FR-009 — CI gate):
  `@generacy-ai/workflow-engine: minor` (new public `revertPaths` on `GitHubClient`),
  `@generacy-ai/orchestrator: patch` (defect fix). Body from quickstart.md.
- [X] T013 Run the full targeted suite (rebuild workflow-engine first): 
  `pnpm --filter @generacy-ai/workflow-engine test -- gh-cli.revert-paths`,
  `pnpm --filter @generacy-ai/workflow-engine test -- managed-file-disjointness`,
  `pnpm --filter @generacy-ai/orchestrator test -- pr-manager`. Confirm SC-001, SC-003, SC-004
  pass and SC-002 (`pr-manager.staging-filter.test.ts`, #1162) passes unmodified.

## Dependencies & Execution Order

**Sequential backbone**:
- T001 (setup) → T002 → T003 → T005 (build) → T006 → T007 → T013 (final verify).
- T006/T007 depend on `revertPaths` existing on the built client (T002–T005).

**Parallel opportunities**:
- T004 [P] (client temp-repo test) can be written alongside T003 (same feature, distinct file).
- T008 [P] (pr-manager test) can be written alongside T006/T007 (distinct file).
- Phase 4 (T009, T010, T011) is fully independent of Phases 2–3 and its three tasks touch
  different files — all `[P]`, runnable in parallel with the core implementation.
- T012 [P] (changeset) can be authored any time before the final verify.

**Blocking notes**:
- Cross-package: after any edit to `interface.ts`/`gh-cli.ts`, rebuild workflow-engine before
  orchestrator typecheck/test or `revertPaths` shows as "no exported member" (quickstart.md).
- No playbook (`packages/claude-plugin-cockpit/commands/*.md`) files are edited by this issue,
  so no `playbook-verification.test.ts` re-pin task is required.
