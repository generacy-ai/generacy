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
- [ ] When `implement` completes with a diff scoped entirely to `specs/**` (and configured exclusion paths), the phase loop routes to error rather than proceeding to `validate`.
- [ ] The error surfaces on the issue via the stage comment and error label (matching the existing `PHASES_REQUIRING_CHANGES` failure path).
- [ ] Runs where `implement` *does* touch at least one file outside the excluded paths proceed normally.
- [ ] Prior-commit fallback (`hasPriorImplementation` at `phase-loop.ts:355–374`) is preserved for requeued runs, but the "prior implementation" scan uses the same product-diff definition — spec-only prior commits do not count as satisfying implement.

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
| FR-001 | After the `implement` phase's commit step, the phase loop MUST evaluate whether the branch's cumulative diff vs. the base branch contains at least one changed file outside excluded paths. | P1 | Cumulative, not per-commit — a partial-implement run's earlier commits count. |
| FR-002 | Excluded paths MUST at minimum include `specs/**`. Additional paths (e.g. `.github/`) MAY be configured, but the default MUST exclude only spec artifacts. | P1 | Prevents false positives on doc-only exclusions creeping in. |
| FR-003 | When the implement phase produces zero product-diff, the phase loop MUST invoke the same error path as the existing `PHASES_REQUIRING_CHANGES` failure: `labelManager.onError('implement')`, stage-comment update, and workflow termination with a descriptive error message. | P1 | Reuse of existing path keeps observability consistent. |
| FR-004 | The `hasPriorImplementation` fallback at `phase-loop.ts:355–374` MUST use the product-diff definition when scanning prior commits: a commit whose diff is spec-only does not count as prior implementation. | P1 | Otherwise the fallback re-opens the same bug. |
| FR-005 | The error message on empty-implement MUST identify the check ("implement phase produced no product-code changes") and point at the excluded-path filter, so operators can distinguish this from unrelated implement failures. | P2 | Aids triage. |
| FR-006 | The check MUST NOT fire on non-implement phases. `specify`/`clarify`/`plan`/`tasks` legitimately produce spec-only diffs. | P1 | Guardrail. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Empty-implement runs are caught before merge. | 100% of runs whose implement phase touches only `specs/**` end in `agent:error` / `needs:intervention` — none reach `validate`. | Reproduce agency#374 conditions in an integration test; assert phase-loop returns `success: false` with phase `implement`. |
| SC-002 | No regression on legitimate implement runs. | 0 false positives across the last N successful merges in the reference repos. | Backfill the check against orchestrator logs from prior successful `speckit-feature` runs. |
| SC-003 | Error is observable on the issue. | The stage comment and error label appear within one poll cycle of the check firing. | Manual repro or integration test. |

## Assumptions

- The phase loop has access to `git diff --name-only origin/<base>...HEAD` (or equivalent via the `github` client) at the point of the check. `pr-manager.commitAndPush` already invokes similar git operations, so this is available.
- `specs/**` is the correct exclusion set for the current speckit workflows. If additional workflows produce non-code diffs that should also be excluded, they are out of scope for this issue and can be added later.
- The clarify gate-skip race (#818) and label interleaving noted in the issue are *related* but separate defects. This spec only addresses the empty-implement detection gap.

## Out of Scope

- Fixing the #818 clarify gate-skip race or the two-runs-on-one-branch interleaving observed in agency#374.
- Retroactively re-opening or unmerging agency PR #376 or its issue.
- Redesigning `validate` to detect zero-diff states (the fix lives in the phase loop, not validate).
- Making the exclusion path list workflow-configurable — a hardcoded default of `specs/**` is sufficient for this issue.
- Any changes to the `implement` agent's prompt or behavior. This is a detection fix, not a prevention fix.

## Open Questions

- Should the exclusion set be defined as a constant next to `PHASES_REQUIRING_CHANGES`, or as part of the workflow config? (Recommend constant for now; move to config only if a second workflow needs a different set.)
- Should the "prior implementation" scan (`phase-loop.ts:355–374`) actually inspect each prior commit's diff, or just check the cumulative branch diff? (Cumulative branch diff is simpler and correct — a spec-only history with no product changes should still fail.)

---

*Generated by speckit; enhanced from generacy-ai/generacy#820*
