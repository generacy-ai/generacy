# Feature Specification: Review phase executor — structured findings artifact + engine-internal verdict

**Branch**: `1124-context-new-review-phase` | **Date**: 2026-08-19 | **Status**: Draft

## Summary

Replace the inert `review`-phase stub (`runStubPhase('review')` in `phase-loop.ts`, landed by #1121) with a real agent phase executor. The executor spawns the CLI along the existing `cli-spawner` path using a **review charter prompt** that performs a correctness/regression review of the PR diff **without running tests or builds**. The agent's findings are captured as a structured, engine-persisted artifact (a filesystem sidecar, mirroring `worker/pause-context.ts`). The engine — not GitHub review state — computes the verdict: `changes-required` when findings at or above the workflow profile's `blockingSeverity` exist, otherwise `clean`. A `clean` verdict continues toward `validate`; `changes-required` routes into the existing off-sequence `remediate` seam (the `remediateTrigger` hook already present in `PhaseLoopDeps`).

GitHub review state cannot be the verdict: the cluster account owns the PR, so `REQUEST_CHANGES` on its own PR is a 422. The verdict must live entirely inside the engine.

## Context

Part of epic generacy-ai/generacy#1120 (engine-native review & remediate phases). Full design: `docs/engine-review-remediate-plan.md` in generacy-ai/tetrad-development.

Prerequisites already merged:
- **#1121** — phase machinery: `review` in `PHASE_SEQUENCE` (after `implement`, before `validate`), `remediate` as an off-sequence phase, the `runStubPhase()` inert executor, and the `PhaseLoopDeps.remediateTrigger?(context)` seam that runs `remediate` and re-enters `review`.
- **Review config** (sibling issue) — `ResolvedWorkflowConfig.review` with `profile` (`standard | verification`), `blockingSeverity` (`critical | major | minor`), and `failThenPass`, resolved per-workflow by `resolveWorkflowOverrides`. `DEFAULT_REVIEW` = `{ profile: 'standard', blockingSeverity: 'critical', failThenPass: false }`. The issue text names a **feature default of `major`**; the concrete blocking default is governed by config, not this executor.

This issue supplies the executor + artifact + verdict-to-next-phase mapping; it does **not** implement the `remediate` executor (still a stub) nor the bugfix charter content (lands with the bugfix-profiles issue).

## User Stories

### US1: Engine-internal code review before validation (P1)

**As** the orchestrator worker driving a speckit workflow,
**I want** the `review` phase to run an agent code review of the PR diff and record a structured verdict engine-side,
**So that** correctness/regression problems are caught before `validate` runs, without depending on GitHub review state that the cluster account cannot legally set on its own PR.

**Acceptance Criteria**:
- [ ] When `review` executes, the CLI is spawned via the `cli-spawner` path with a review charter prompt selected by the workflow's `review.profile`.
- [ ] No test or build process is spawned during `review` (distinct from `validate`, which runs the validate command).
- [ ] A structured findings artifact is written engine-side after the agent completes.
- [ ] The engine computes `verdict` from the findings and the profile's `blockingSeverity` — GitHub review state is never read or written as the verdict.

### US2: Verdict drives the next-phase decision (P1)

**As** the phase loop,
**I want** the review verdict to select the next phase,
**So that** clean reviews proceed and blocking reviews route into remediation.

**Acceptance Criteria**:
- [ ] `verdict: clean` → loop continues toward `validate` (normal sequence progression).
- [ ] `verdict: changes-required` → the off-sequence `remediate` seam is entered (via the existing `remediateTrigger` hook / equivalent verdict signal), then `review` is re-entered.
- [ ] The decision is derived solely from the persisted artifact's verdict, not re-derived from labels or GitHub state.

### US3: Empty-diff detection (P2)

**As** the reviewer charter,
**I want** the agent to flag an implausibly empty or trivial diff as a finding,
**So that** the known implement-phase empty-diff bypass is closed as a side effect of review.

**Acceptance Criteria**:
- [ ] An implausibly empty diff produces at least one finding at or above `blockingSeverity`, yielding `changes-required`.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add a real `review` phase executor invoked from `phase-loop.ts` in place of `runStubPhase('review')`, spawning the CLI via the `cli-spawner` path. | P1 | `remediate` remains a stub. |
| FR-002 | Select the charter prompt from the workflow's resolved `review.profile` (`standard` \| `verification`). Bugfix charter content is out of scope. | P1 | `verification` profile emits "needs verification" findings for `validate` to confirm. |
| FR-003 | The charter prompt directs a correctness/regression review of the PR diff and explicitly forbids running tests or builds. | P1 | |
| FR-004 | The charter must flag an implausibly empty/trivial diff as a finding. | P2 | Closes implement-phase empty-diff bypass. |
| FR-005 | Persist a structured findings artifact engine-side using the sidecar pattern (`worker/pause-context.ts`): Zod-validated, atomic temp+rename write, read returns `null` on missing/invalid. | P1 | |
| FR-006 | Artifact schema: `findings: [{ severity: critical\|major\|minor, file, line?, title, detail, round, status: open\|resolved }]`, `verdict: clean\|changes-required`, `round` (number), `lastReviewedCommitSha`. | P1 | |
| FR-007 | Compute `verdict` = `changes-required` iff ≥1 finding with `severity >= blockingSeverity` and `status: open`; else `clean`. Severity ordering: `critical > major > minor`. | P1 | `blockingSeverity` from resolved workflow config. |
| FR-008 | `clean` verdict → continue toward `validate`; `changes-required` → enter the off-sequence `remediate` seam, then re-enter `review`. | P1 | Reuses the `remediateTrigger` hook from #1121. |
| FR-009 | Record the round number and the last-reviewed commit SHA in the artifact so successive review rounds are distinguishable. | P1 | Round increments per review pass on the same issue/branch. |
| FR-010 | With `reviewPhaseEnabled=false`, behavior is byte-identical to today (phase absent from the effective sequence). | P1 | Executor never runs when the phase is gated out. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Artifact schema round-trips | Valid findings artifact parses; malformed input returns `null` | Unit test on the sidecar read/write. |
| SC-002 | Severity gating correctness | Verdict matches the `blockingSeverity` threshold across critical/major/minor fixtures | Unit test on the verdict-mapping function. |
| SC-003 | No test process during review | Zero validate/build spawns while `review` runs | Harness: assert `cli-spawner` validate path is not invoked during `review`. |
| SC-004 | End-to-end phase decision | `implement → review` produces the artifact and the correct next-phase decision (continue vs remediate) | Integration harness with clean and changes-required fixtures. |
| SC-005 | Flag disabled = no-op | With `reviewPhaseEnabled=false`, observable output identical to pre-change | Existing byte-identity assertion (#1121). |

## Assumptions

- The review config surface (`review.profile`, `review.blockingSeverity`, `review.failThenPass`, `resolveWorkflowOverrides`, `DEFAULT_REVIEW`) already exists and is not re-implemented here.
- The `remediate` executor is not implemented in this issue — only the verdict→seam signal is wired; `remediate` continues to run as `runStubPhase('remediate')`.
- The artifact sidecar lives under the checkout's `.generacy/` directory, keyed by workflow/issue identity, following the `pause-context.ts` sanitization + atomic-write layout.
- The agent is trusted to return findings in the charter-specified structured form; the engine validates the shape and computes the verdict independently of any agent-claimed verdict.
- Severity default nuance: the config default (`DEFAULT_REVIEW.blockingSeverity = 'critical'`) governs unless a workflow override sets it; the issue's "feature default `major`" is expressed as workflow config, not hardcoded in the executor.

## Out of Scope

- The `remediate` phase executor (lands later in the epic; the seam is honored, the stub remains).
- Bugfix charter prompt content (lands with the bugfix-profiles issue).
- Running tests or builds during review (that is `validate`'s job).
- Any use of GitHub review state (`APPROVE`/`REQUEST_CHANGES`/`COMMENT`) as the verdict source or sink.
- Posting findings to the PR as comments/reviews.
- Cloud-side or cockpit-side surfacing of the artifact.

---

*Generated by speckit*
