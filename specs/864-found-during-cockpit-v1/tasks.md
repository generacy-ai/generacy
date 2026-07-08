# Tasks: Pre-Phase Base Merge (#864)

**Input**: Design documents from `/specs/864-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/ (base-merge-runner.md, merge-conflict-evidence-block.md, merge-conflict-gate-label.md, plan-dependency-warning.md), quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 = validate against merged tree; US2 = actionable conflict pauses; US3 = queue-time dependency warning

## Phase 1: Foundational Types & Config

These are the schema-shape changes every other worker-side task depends on. Land these first, in one commit, so downstream tasks compile against the extended shapes.

- [X] T001 [US2] Extend `errorEvidence` on `StageCommentData` in `packages/orchestrator/src/worker/types.ts` to a discriminated union: existing `{ command, exitDescriptor, stderrTail }` variant OR new `{ mergeConflict: { baseRef: string; conflictedPaths: string[] } }` variant. All existing fields become optional at the top level per data-model.md §`StageCommentData.errorEvidence`.
- [X] T002 [US1] Add `'on-merge-conflict'` to `GateDefinitionSchema.condition` enum in `packages/orchestrator/src/worker/config.ts` (existing pattern set by `'on-sibling-review'` from #692).
- [X] T003 [US1] Append two default gate entries to both `speckit-feature` and `speckit-bugfix` workflow gate defaults in `packages/orchestrator/src/worker/config.ts`: `{ phase: 'implement', gateLabel: 'waiting-for:merge-conflicts', condition: 'on-merge-conflict' }` and the matching entry for `phase: 'validate'`. Do NOT add to `speckit-epic` (see contracts/merge-conflict-gate-label.md — epic workflows stop at `tasks`).
- [X] T004 [P] [US1] Add `BaseMergeResult`, `BaseMergeOptions`, and `BaseMergeRunner` type declarations to a new `packages/orchestrator/src/worker/base-merge.ts` stub (exports only — implementation lands in T010). Matches data-model.md §`BaseMergeResult`/`BaseMergeOptions`/`BaseMergeRunner`.

## Phase 2: Git Primitives on RepoCheckout

Extend the existing subprocess wrapper before wiring the runner. These are pure additions — no existing callers change.

- [X] T005 [US1] Add `fetchBase(checkoutPath: string, baseBranch: string): Promise<void>` to `packages/orchestrator/src/worker/repo-checkout.ts`. Runs `git fetch origin <baseBranch>` via the existing `execFileAsync('git', ...)` pattern used by `switchBranch`. `baseBranch` is the un-prefixed name (e.g. `main`, not `origin/main`).
- [X] T006 [US1] Extract `resetToBranchTip(checkoutPath: string, branch: string): Promise<void>` from the current inline `git reset --hard origin/<branch>` inside `switchBranch` in the same file. `switchBranch` calls the new helper (no behavior change); new callers (base-merge.ts) also call it directly.
- [X] T007 [P] [US1] Unit test in `packages/orchestrator/src/worker/__tests__/repo-checkout.base.test.ts` — stub `execFileAsync`, assert `fetchBase('/w', 'main')` invokes `git fetch origin main` and `resetToBranchTip('/w', '864-…')` invokes `git reset --hard origin/864-…`.

## Phase 3: Base-Merge Runner (US1)

Pure orchestration on top of the git primitives. All logic here — phase-loop just calls it.

- [X] T008 [US1] Implement `resolveBaseBranch(github, prManager, checkoutPath, owner, repo, logger): Promise<string>` in `packages/orchestrator/src/worker/base-merge.ts`. Reuses (or hoists from) `packages/orchestrator/src/worker/product-diff.ts:resolveBaseRef` — call `gh pr view --json baseRefName` first, fall back to `origin/HEAD` (repo default). Return value is always `origin/<name>`. Per FR-011 + research.md §"base ref from PR".
- [X] T009 [US1] Implement `performBaseMerge(checkoutPath, branch, baseRef, opts, logger): Promise<BaseMergeResult>` in `packages/orchestrator/src/worker/base-merge.ts` following contracts/base-merge-runner.md §Behavior exactly:
  1. `resetToBranchTip` + `git clean -fd`,
  2. `fetchBase` (strip the `origin/` prefix off `baseRef`),
  3. `git merge --no-ff [--no-commit if !opts.commit] <baseRef>`,
  4. on non-zero: `git diff --name-only --diff-filter=U` → paths, `git merge --abort`, return `{ ok: false, baseRef, conflictedPaths }`,
  5. on success + `commit: true`: `git rev-parse HEAD` → `mergeSha`, return `{ ok: true, baseRef, mergeSha }`; on success + `commit: false`: return `{ ok: true, baseRef }`.
  Non-conflict failures (network / bad ref) throw `Error` — do NOT convert to `{ ok: false }` (contracts/base-merge-runner.md §"Error propagation"). Guarantee `conflictedPaths` non-empty on `ok: false` by inserting `['<unknown: merge failed without conflict list>']` when git reports no conflicts (data-model.md §Validation).
- [X] T010 [US1] Unit tests for `performBaseMerge` in `packages/orchestrator/src/worker/__tests__/base-merge.test.ts`. Stub `execFileAsync`; assert command sequence + result shape for: (a) clean merge with `commit: true` (has `mergeSha`), (b) clean merge with `commit: false` (no `mergeSha`), (c) conflict path (returns `ok: false` + paths from `diff --name-only --diff-filter=U`), (d) non-conflict git failure throws, (e) idempotent double-invocation.
- [X] T011 [P] [US1] Unit test for `resolveBaseBranch` in the same file — happy path (PR present → returns `origin/<baseRefName>`), fallback (no PR → returns `origin/HEAD`-derived default).

## Phase 4: Stage-Comment Renderer (US2)

- [X] T012 [US2] Extend `renderStageComment` (and `appendEvidenceBlock` if separated) in `packages/orchestrator/src/worker/stage-comment-manager.ts` to branch on the presence of `errorEvidence.mergeConflict`. When set, emit the byte layout from contracts/merge-conflict-evidence-block.md §"Byte layout (variant B)":
  ```
  ---
  **Merge conflict during base-sync**
  **Base**: `<baseRef>`

  <details><summary>Conflicted paths (N)</summary>

  - `path/one`
  - `path/two`

  </details>
  ```
  Path list order = the order returned by `git diff --name-only --diff-filter=U`. Empty `conflictedPaths` renders `- (no paths reported — merge failed for a non-conflict reason)` with header count `0`. Backticks-in-paths escaped identically to #847's `stderrTail` handling. Dev-mode assert: both variants populated simultaneously = programmer bug.
- [X] T013 [P] [US2] Add renderer tests in `packages/orchestrator/src/worker/__tests__/merge-conflict-evidence-block.test.ts` covering: (a) canonical marker string `**Merge conflict during base-sync**` present (SC-004), (b) `**Base**: \`origin/main\`` line rendered, (c) all supplied paths appear bulleted in order, (d) header count matches path count, (e) byte layout above `---` unchanged vs. the existing #847-variant renderer output (regression guard for #847 consumers), (f) empty-conflict-paths fallback string rendered.

## Phase 5: Phase-Loop Integration (US1 + US2)

Wire the runner into the phase loop. This is the load-bearing step — it's the seam where clean-merge vs. conflict-pause is decided.

- [X] T014 [US1] In `packages/orchestrator/src/worker/phase-loop.ts`, add `baseMergeRunner: BaseMergeRunner` to `PhaseLoopDeps` (default = `performBaseMerge` from base-merge.ts). Import types from `./base-merge.js` (matches package conventions).
- [X] T015 [US1] In the same file, insert the pre-phase base-merge step for `phase === 'implement'` after the existing label-update + stage-comment steps (plan.md §"Phase Ordering Inside PhaseLoop.executeLoop" step 2) and before the phase's own command runs:
  - call `resolveBaseBranch(...)` to get `baseRef`,
  - call `baseMergeRunner(checkoutPath, branch, baseRef, { commit: true }, logger)`,
  - on `{ ok: true }` proceed with existing implement flow,
  - on `{ ok: false }` handle per T017.
- [X] T016 [US1] In the same file, insert the same pre-phase base-merge for pre-validate AND validate inside the existing `phase === 'validate'` branch: run once immediately before pre-validate install, then once immediately before the validate command. Both invocations use `{ commit: false }` (FR-006 — ephemeral, never pushed). The next phase's `resetToBranchTip` in T009 discards any leftover un-committed merge state so no explicit cleanup here is required.
- [X] T017 [US2] In the same file, on `{ ok: false }` from any of the three call sites in T015/T016, build `errorEvidence: { mergeConflict: { baseRef, conflictedPaths } }`, call `stageCommentManager.updateStageComment(...)` with status `in_progress` (not `error` — this is a pause, not a hard failure, per contracts/merge-conflict-gate-label.md §"Trigger semantics"), call `labelManager.onGateHit(phase, 'waiting-for:merge-conflicts')`, and return `{ results, completed: false, lastPhase: phase, gateHit: true }` — reusing the existing gate-return path so #849's paired resume-dedupe clear applies symmetrically (FR-005).
- [X] T018 [US1] Add integration tests in `packages/orchestrator/src/worker/__tests__/phase-loop.merge.test.ts` covering:
  - clean merge → implement phase proceeds and the returned `mergeSha` is present ahead of the phase's own push,
  - clean merge in pre-validate → phase proceeds, `opts.commit === false` on the runner call,
  - clean merge in validate → same as pre-validate,
  - conflict in implement → `waiting-for:merge-conflicts` label applied, stage-comment `errorEvidence.mergeConflict` populated, `gateHit: true` returned, no push attempted,
  - conflict in pre-validate → same pause behavior with label + evidence,
  - conflict in validate → same pause behavior,
  - hook ordering: pre-phase base-merge fires BEFORE the phase command (implement's Claude CLI, pre-validate install, validate command),
  - discriminant: implement runner call is `{ commit: true }`, pre-validate/validate calls are `{ commit: false }`.
  Inject a `BaseMergeRunner` fake via `PhaseLoopDeps` — do NOT exercise real git.
- [X] T019 [P] [US1] Add a fallback test in the same file: no PR present → `resolveBaseBranch` returns the default-branch fallback and the runner is still invoked with the resolved `origin/<default>`. Covers FR-011 fallback branch.

## Phase 6: Plan-Dependency Extractor (US3)

Independent of everything above — pure function, no orchestrator state.

- [X] T020 [P] [US3] Implement `extractPlanDependencies(planMarkdown, defaultOwner, defaultRepo): DependencyRef[]` in a new `packages/generacy/src/cli/commands/cockpit/plan-dependency-extractor.ts`. Heuristic per contracts/plan-dependency-warning.md §Extractor:
  - `TRIGGER_VERBS = ['must be merged', 'must merge first', 'depends on', 'depends-on', 'requires', 'extends', 'blocked by', 'prerequisite']`,
  - for every line containing a trigger, scan that line + the immediately following line for `#\d+` (→ `{ defaultOwner, defaultRepo, N }`) and `[\w-]+/[\w-]+#\d+` (→ cross-repo),
  - skip content inside fenced code blocks (` ``` `) and inline code (`` ` ``),
  - de-duplicate by `owner/repo/number`, preserve first-occurrence order,
  - populate `originatingText` from the trigger line, bounded to 120 chars (data-model.md §DependencyRef).
- [X] T021 [P] [US3] Table-driven tests in `packages/generacy/src/cli/commands/cockpit/__tests__/plan-dependency-extractor.test.ts`. Fixtures should include: bare `#2` mention on a `must be merged first` line, cross-repo `owner/repo#42` mention on `depends on` line, wrap across the line-following boundary, duplicate mention collapsed, fenced-code-block negative case (must NOT extract), inline-backtick negative case, trigger-verb absent (no extraction), `blocked by` + `prerequisite` + `extends` positive cases, `originatingText` truncation at 120 chars.

## Phase 7: Queue Integration (US3)

- [X] T022 [US3] Extend `QueueRow` in `packages/generacy/src/cli/commands/cockpit/queue.ts` with the optional `dependencyWarnings?: { ref: DependencyRef; state: 'unresolved' | 'closed-unmerged' }[]` field per data-model.md §`QueueRow.warnings`.
- [X] T023 [US3] In the same file, after `classifyRow` sets `eligibility.kind === 'eligible'` and only when the phase heading matches `/implement/i`:
  1. Fetch plan.md via `cockpitGh.runCmd(['gh', 'api', 'repos/<owner>/<repo>/contents/specs/<slug>/plan.md', '--jq', '.content'])` (base64-decode; tolerate 404 → skip check for this row),
  2. call `extractPlanDependencies(planMd, ref.owner, ref.repo)`,
  3. for each `DependencyRef`, call `cockpitGh.fetchIssueState` (or the closest existing helper) and classify: merged/closed-with-merged-PR → OK (no warning), closed-with-no-merged-PR → `'closed-unmerged'`, open or not-found → `'unresolved'`,
  4. attach non-empty results to `QueueRow.dependencyWarnings`.
  Per contracts/plan-dependency-warning.md §"Queue integration".
- [X] T024 [US3] Extend `renderPreview` in the same file to emit one indented warning line per `dependencyWarnings` entry, positioned directly under the eligible-row line:
  ```
    owner/repo#3  Title of issue (process:speckit-feature, assignee: someone)
      [WARN: depends-on owner/repo#2 not yet merged]
  ```
  Indent = row-indent + 2 spaces. Warnings do NOT change eligibility or exit code (FR-009 warning-only).
- [X] T025 [US3] Extend the queue test suite (existing `packages/generacy/src/cli/commands/cockpit/__tests__/queue.test.ts` if present, or new `queue.dependency-warnings.test.ts`) with fixtures that mock `cockpitGh.runCmd` returning canned plan.md content + issue states. Cover: warning rendered for open dep, warning rendered for closed-unmerged dep, no warning for merged dep, `--yes` proceeds unaffected by warnings (exit 0), missing plan.md silently skipped, non-implement phases skip the check entirely.

## Phase 8: Manual Verification & Polish

- [ ] T026 [manual] Replay the christrudelpw/sniplink#3 pre-repair state locally against a modified worker (per plan.md §Verification): confirm `performBaseMerge` conflicts on `CLAUDE.md`, `package.json`, `package-lock.json`, and that the rendered stage comment enumerates all three under the `**Merge conflict during base-sync**` heading.
- [ ] T027 [P] [manual] Confirm SC-004 end-to-end: trigger a merge-conflict pause on a scratch issue, verify `cockpit status` output distinguishes it from other `waiting-for:*` pauses (label naming alone should already satisfy this — the assertion is that no cockpit-side changes are required).
- [ ] T028 [P] [manual] Confirm SC-002 sample: pick 2–3 recently merged PRs, replay pre-merge branch tip against pre-merge base to verify the new pre-validate step would have caught (or cleanly passed) each. Document results inline in the PR description.

## Dependencies & Execution Order

**Sequential backbone**:
- Phase 1 (T001–T004) MUST land first — schema changes downstream tasks compile against.
- Phase 2 (T005–T007) unblocks Phase 3.
- Phase 3 (T008–T011) unblocks Phase 5.
- Phase 4 (T012–T013) unblocks Phase 5's error-path assertions.
- Phase 5 (T014–T019) is the integration seam for US1 + US2.
- Phase 6 (T020–T021) is independent of Phases 1–5; can start any time after Phase 1 lands the type shells.
- Phase 7 (T022–T025) depends only on Phase 6.
- Phase 8 (T026–T028) is post-integration validation.

**Parallel opportunities within phases**:
- T004 runs parallel to T001–T003 (different file).
- T007 parallel to T005/T006 (test file, no dependency).
- T011 parallel to T010 (same file but independent test cases; can be authored concurrently).
- T013 parallel to T012 (test-vs-impl split).
- T019 parallel to T018 (same file, independent cases).
- T020 + T021 parallel to all worker-side Phases 2–5 (different package).
- T027 + T028 parallel to each other (both post-merge validation).

**Whole-phase parallelism**:
- Phase 6 + Phase 7 (cockpit-queue track) parallel to Phase 2–5 (worker track) once Phase 1 lands — different packages, no shared files.

**Not parallel**:
- Any task inside Phase 5 (T014–T017) — same file, phase-loop.ts, must be serialized.
- T023 must land after T022 (same file, `QueueRow` shape referenced).
