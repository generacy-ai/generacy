# Feature Specification: Fail loud when implement phase produces no product changes

**Branch**: `820-observed-generacy-ai-agency` | **Date**: 2026-07-06 | **Status**: Draft
**Source**: [generacy-ai/generacy#820](https://github.com/generacy-ai/generacy/issues/820)

## Summary

The orchestrator's phase loop already asserts that the `implement` phase produces file changes (`PHASES_REQUIRING_CHANGES` at `packages/orchestrator/src/worker/phase-loop.ts:17`), but the assertion is too weak: it accepts *any* changed file as evidence of implementation. On agency PR #376 (2026-07-06), the implement phase committed only `specs/**` artifacts, `validate` passed trivially (`pnpm test && pnpm build` with an unchanged working tree), and the PR merged with none of the issue's acceptance criteria met (no `package.json`, no changeset, no README section — the `@generacy-ai/claude-plugin-cockpit` package still 404s on npm).

The detection gap is that `hasChanges` (see `pr-manager.ts:57` `commitAndPush`) returns `true` whenever `git status` reports *anything*, including spec-only edits. `PHASES_REQUIRING_CHANGES.has('implement') && !hasChanges` therefore never fires when implement leaves specs dirty but touches no product code.

## Root Cause

`phase-loop.ts:351` gates on `hasChanges` from `prManager.commitPushAndEnsurePr(phase)`. `hasChanges` is derived from an unfiltered `git status` — spec artifacts, docs, or any other file counts. The implement phase's contract ("write code that satisfies tasks.md") requires *product* diff, but the check does not distinguish product changes from spec/doc changes.

## User Stories

### US1: Orchestrator surfaces empty-implement runs instead of silently merging them

**As** a workflow author whose agent runs `speckit-feature` or `speckit-bugfix` workflows,
**I want** the orchestrator to detect when the `implement` phase ends without touching product code,
**So that** the run halts at `agent:error` / `needs:intervention` instead of proceeding to `validate` (which trivially passes) and auto-merging a spec-only PR that fails to deliver the requested change.

**Acceptance Criteria**:
- [ ] When `implement` completes with a cumulative branch diff scoped entirely to `specs/` (the hardcoded exclusion prefix), the phase loop routes to error rather than proceeding to `validate`.
- [ ] The error surfaces on the issue via the stage comment and error label (matching the existing `PHASES_REQUIRING_CHANGES` failure path).
- [ ] Runs where `implement`'s cumulative branch diff contains at least one file outside the excluded prefix proceed normally.
- [ ] The `hasPriorImplementation` fallback (`phase-loop.ts:355–374`) is replaced by the same cumulative product-diff check; the existing commit-message heuristics (`complete ${phase} phase`, `feat: complete T`, `partial implement progress`) are removed. A resumed run whose cumulative branch diff already contains product-code changes correctly counts as satisfying implement.

### US2: Detection is independent of `validate`'s exit status

**As** the person diagnosing a failed run,
**I want** the empty-implement check to be enforced at the phase-loop level, not delegated to workflow-specific validate commands,
**So that** the guarantee holds uniformly across workflows and cannot be silently disabled by a workflow whose validate happens to succeed on an empty tree.

**Acceptance Criteria**:
- [ ] The check lives in the phase loop (or a shared post-implement hook), not in individual workflow YAML.
- [ ] It runs before `validate` starts.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | When the `implement` phase is about to transition to `validate` (phase completion, not per inner iteration), the phase loop MUST evaluate whether the branch's cumulative diff vs. the resolved base ref contains at least one changed file outside excluded paths. | P1 | Cumulative, not per-commit — a partial-implement run's earlier commits count. Intermediate spec-only increments are legitimate and MUST NOT fail the run mid-phase. |
| FR-002 | Excluded paths MUST be a hardcoded module-level constant colocated with `PHASES_REQUIRING_CHANGES` in `phase-loop.ts`, defaulting to the single prefix `specs/` (literal, not glob). No workflow-YAML or `WorkerConfig` surface is exposed. | P1 | Store as a plain prefix list (`['specs/']`); do not advertise glob syntax the matcher does not implement. `specs/README.md` correctly counts as excluded via prefix match. |
| FR-003 | When the implement phase produces zero product-diff, the phase loop MUST invoke the same error path as the existing `PHASES_REQUIRING_CHANGES` failure: `labelManager.onError('implement')`, stage-comment update, and workflow termination with a descriptive error message. | P1 | Reuse of existing path keeps observability consistent. |
| FR-004 | The existing `hasPriorImplementation` fallback at `phase-loop.ts:355–374` MUST be replaced by the same cumulative product-diff check used in FR-001. The commit-message heuristics (`complete ${phase} phase`, `feat: complete T`, `partial implement progress`) MUST be removed. A resumed run whose cumulative branch diff already contains at least one non-excluded file satisfies implement. | P1 | Cumulative diff answers exactly the question the fallback exists for; it is more truthful than per-commit inspection (a commit that adds product files later reverted nets to zero, which cumulative reports correctly). Keeping two mechanisms (walk + heuristics) for one job retains the fragile part. |
| FR-005 | The error message on empty-implement MUST identify the check ("implement phase produced no product-code changes") and point at the excluded-path filter, so operators can distinguish this from unrelated implement failures. | P2 | Aids triage. |
| FR-006 | The check MUST NOT fire on non-implement phases. `specify`/`clarify`/`plan`/`tasks` legitimately produce spec-only diffs. | P1 | Guardrail. |
| FR-007 | The base ref used for the diff MUST be resolved from the PR's `base` ref via the GitHub API (`pr-manager` already has this in hand), falling back to `origin/<default-branch>` when no PR exists yet. The comparison MUST use merge-base (triple-dot `A...B`) semantics so that rebased or long-lived branches only surface branch-local commits. | P1 | Diffing against the default branch on a stacked PR that targets a non-default base would let the base branch's own product files register as "prior implementation" — exactly the false-negative class this issue closes. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Empty-implement runs are caught before merge. | 100% of runs whose implement phase touches only `specs/**` end in `agent:error` / `needs:intervention` — none reach `validate`. | Reproduce agency#374 conditions in an integration test; assert phase-loop returns `success: false` with phase `implement`. |
| SC-002 | No regression on legitimate implement runs. | 0 false positives across the last N successful merges in the reference repos. | Backfill the check against orchestrator logs from prior successful `speckit-feature` runs. |
| SC-003 | Error is observable on the issue. | The stage comment and error label appear within one poll cycle of the check firing. | Manual repro or integration test. |

## Assumptions

- The phase loop can invoke `git diff --name-only <base>...HEAD` (triple-dot / merge-base semantics) at the point of the check. `pr-manager.commitAndPush` already runs comparable git operations and holds a GitHub client for base-ref resolution, so both inputs are available.
- The PR's `base` ref (via the GitHub API on `pr-manager`) is authoritative when a PR exists; `origin/<default-branch>` is the fallback for pre-PR runs. Merge-base semantics keep rebased branches from surfacing base-branch commits as false positives.
- `specs/` is the correct exclusion prefix for the current speckit workflows. If additional workflows produce non-code diffs that should also be excluded, promoting the constant to a config surface is a small, informed follow-up.
- The clarify gate-skip race (#818) and label interleaving noted in the issue are *related* but separate defects. This spec only addresses the empty-implement detection gap.

## Out of Scope

- Fixing the #818 clarify gate-skip race or the two-runs-on-one-branch interleaving observed in agency#374.
- Retroactively re-opening or unmerging agency PR #376 or its issue.
- Redesigning `validate` to detect zero-diff states (the fix lives in the phase loop, not validate).
- Making the exclusion path list workflow-configurable — a hardcoded module-level constant of `specs/` is sufficient for this issue (see Batch 1 Q1).
- Any glob or gitignore matcher — the exclusion list is a literal prefix, matched via `startsWith` (see Batch 1 Q4).
- Any changes to the `implement` agent's prompt or behavior. This is a detection fix, not a prevention fix.

---

*Generated by speckit; enhanced from generacy-ai/generacy#820*
