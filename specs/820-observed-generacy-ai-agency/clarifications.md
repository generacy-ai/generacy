# Clarifications: #820 — Fail loud when implement phase produces no product changes

## Batch 1 — 2026-07-06

### Q1: Exclusion set location
**Context**: FR-002 mandates that the default excluded-path set is `specs/**` only. The spec's Open Questions section proposes making this a hardcoded constant next to `PHASES_REQUIRING_CHANGES` in `phase-loop.ts` rather than exposing it through workflow YAML. Deciding location up front avoids a later refactor and dictates where `plan.md` places the new module.
**Question**: Where should the excluded-path list live?
**Options**:
- A: Hardcoded module-level constant next to `PHASES_REQUIRING_CHANGES` in `phase-loop.ts` (or a colocated helper), no config surface.
- B: Field on `WorkerConfig` with a hardcoded default, so future workflows can override without another PR.
- C: Field on each workflow YAML (`speckit-feature.yaml`, `speckit-bugfix.yaml`) with a shared default constant.

**Answer**: A — hardcoded constant colocated with `PHASES_REQUIRING_CHANGES`. `specs/**` is a speckit-workflow invariant (both existing workflows share the layout), not a per-team preference; a config surface with no second consumer is dead surface (the rev 2 lesson). If a future workflow genuinely differs, promoting a constant to YAML then is a small, informed change.

### Q2: Prior-implementation scan semantics
**Context**: FR-004 requires that the `hasPriorImplementation` fallback at `phase-loop.ts:355–374` use the product-diff definition. The current fallback inspects commit messages on the branch (`complete ${phase} phase`, `feat: complete T`, `partial implement progress`). The spec's second Open Question asks whether the scan should inspect each prior commit's diff, or just check the cumulative branch diff vs. base.
**Question**: How should "prior implementation exists" be computed after this change?
**Options**:
- A: Cumulative branch diff — `git diff --name-only origin/<default>...HEAD` with the excluded paths filtered out; commit messages ignored. If any product-diff file exists on the branch, treat as prior implementation.
- B: Per-commit inspection — walk each commit between `origin/<default>` and `HEAD`, mark a commit as "prior implementation" only if it changed at least one non-excluded file, and keep the existing commit-message heuristics as an additional filter.
- C: Drop the fallback entirely — every implement invocation must independently produce product-diff, even on requeued runs.

**Answer**: A — cumulative branch diff, exclusions filtered, commit-message heuristics deleted. It answers exactly the question the fallback exists for ("does product implementation exist on this branch?") and is more truthful than per-commit inspection (a commit that adds product files later reverted nets to zero, which cumulative reports correctly). It also retro-catches the observed failure: agency#376's branch had specs-only commits, so the cumulative product diff was empty and the run would have failed loud. Not C — a resumed run whose earlier iterations completed the implementation legitimately produces no new diff. Not B — it keeps two mechanisms (commit walk + message heuristics) for one job, and the message heuristics are the fragile part we're replacing.

### Q3: Base reference for the diff computation
**Context**: The Assumptions section mentions `git diff --name-only origin/<base>...HEAD`. `pr-manager.ts` derives base via `github.getDefaultBranch()` today, but PRs can target non-default branches, and requeued branches may have been rebased. The chosen base ref determines whether long-lived branches false-positive.
**Question**: Which base ref should the check compare `HEAD` against?
**Options**:
- A: `origin/<default-branch>` (result of `github.getDefaultBranch()`) — matches today's `hasPriorImplementation` behavior.
- B: The PR's `base` ref from the GitHub API (falls back to default branch if no PR exists yet).
- C: The merge-base of `HEAD` and `origin/<default-branch>` (`git merge-base`), so rebased branches only diff the branch-local commits.

**Answer**: B — the PR's base ref from the GitHub API, falling back to the default branch when no PR exists, compared with merge-base (triple-dot) semantics — which subsumes option C's rebase concern. Diffing against the default branch on a PR that targets a non-default base overcounts: the base branch's own product files would register as "prior implementation," letting an empty implement slip through on stacked branches — precisely the bug class this issue closes. `pr-manager` already has the GitHub API in hand.

### Q4: Path pattern matching semantics
**Context**: FR-002 uses `specs/**` as the default exclusion. `**` is glob-style, but the codebase does not have a shared glob helper in `phase-loop.ts` today. Implementation needs to pick a matcher; the choice affects which files are treated as product diff and whether `specs/README.md` (top-level file inside `specs/`) is excluded.
**Question**: How should the exclusion pattern be evaluated against paths returned by `git diff --name-only`?
**Options**:
- A: Prefix match — treat each entry as a literal prefix; `specs/**` becomes "starts with `specs/`". Simple, no dep.
- B: Minimatch/`micromatch` glob semantics (`specs/**` matches any file under `specs/` at any depth, does NOT match `specs` as a bare file). Introduces a dep if not already present.
- C: Gitignore semantics via `git check-ignore` or `ignore` npm package — most familiar to devs, handles negation.

**Answer**: A — literal prefix match, and store the constant as a plain prefix list (`['specs/']`) rather than glob syntax, so the code doesn't advertise glob semantics it doesn't implement. One hardcoded pattern (per Q1) needs no glob engine and no new dependency; `specs/README.md` correctly counts as excluded. Upgrade the matcher only if the list ever becomes user-configurable.

### Q5: Check timing within the implement phase
**Context**: `phase-loop.ts:344–345` calls `commitPushAndEnsurePr(phase)` once per phase iteration. If the implement phase supports internal increments/retries (partial-implement commits, resumed runs), the check could run after every commit or only after the final phase iteration. Firing too early may false-positive on a first increment that only cleaned up spec artifacts; firing only once at the end could miss the case where the loop terminates from a gate before the final iteration.
**Question**: When exactly should the product-diff check fire relative to implement's inner iteration?
**Options**:
- A: Immediately after each `commitPushAndEnsurePr('implement')`, mirroring the existing `!hasChanges` check at line 351. If the check fails, error the run at that point (no further increments).
- B: Only after the implement phase's final iteration exits (i.e., when the phase loop is about to transition to `validate`). Requires distinguishing "phase iteration finished" from "phase itself finished".
- C: Only when `hasChanges` is `true` — i.e., the new check is strictly complementary to the existing `!hasChanges` guard, and both run at the same call site.

**Answer**: B — fire when the implement phase is about to complete (transition toward validate), not per iteration. The invariant this issue exists to enforce is "implement must not COMPLETE without product diff" — intermediate spec-only increments are legitimate (the existing message heuristics even name "partial implement progress"), and failing the run at the first such increment would convert legitimate partial-progress runs into `agent:error` noise. Gate pauses mid-phase correctly don't fire the check; it fires when the phase completes after resume. On failure, route to `agent:error` / `needs:intervention` per the issue body rather than proceeding to validate.
