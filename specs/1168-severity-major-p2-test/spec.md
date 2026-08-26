# Feature Specification: Composed-loop integration coverage for review/remediate executors and gate-label resume

**Branch**: `1168-severity-major-p2-test` | **Date**: 2026-08-21 | **Status**: Draft

## Summary

**Severity: major (P2) — test coverage.** No integration suite composes the *real* `ReviewExecutor` with `PhaseLoop`. Every existing phase-loop suite steers verdicts through seams: stub executors, an injected `readFindingsArtifact`, or a hand-reimplemented scripted stand-in (the #1132 convergence/cap suites) that writes final verdicts directly and rebuilds findings fresh each round. The only real executor currently composed with the loop is `RemediateExecutor`, and only on the timeout path (`phase-loop.remediate-timeout.integration.test.ts`).

This seam-steering is precisely why three shipped defects escaped four integration issues: the phantom-clean verdict (#1155), the unwired review poster (#1156), and the resume label-strip (#1154, whose unit tests injected `completed:*` labels directly and never exercised `LabelManager.onResumeStart`).

This feature delivers composed-loop integration coverage that drives the real executors and the real label-resume path end-to-end, so this class of "seam passes, production fails" defect is caught by CI.

**Deliverables (from the issue):**
1. Real `ReviewExecutor` under `PhaseLoop` with a scripted agent CLI (a fake binary that writes or withholds the sidecar): verdict recomputation, severity gating, finding-status lifecycle (open→resolved carry-over; sub-blocking drop at round ≥ 2, now that #1161 has landed), and the failure paths — missing sidecar, timeout, non-zero exit.
2. Gate resume through the *real* label path: pause → apply `completed:*` via the label monitor → `onResumeStart` → assert counter reset / terminal no-op actually engage (regression for #1154).
3. Single-suite-per-clean-cycle and draft/ready assertions re-run against real executors once #1156 has wired the poster.

**Existing good coverage to keep:** unit suites for the executors (`review-executor.test.ts`, `remediate-executor.test.ts`), the cap-gate label-pair tests, and the scripted convergence suites (repurposed as charter-contract tests, not loop tests).

---
Filed from a post-merge code review of epic generacy-ai/generacy#1120. Part of follow-up epic generacy-ai/generacy#1153. All line refs at develop `155b3464`.

## User Stories

### US1: Real ReviewExecutor composed with PhaseLoop under a scripted CLI

**As a** maintainer of the review/remediate phase machinery,
**I want** an integration suite that runs the real `ReviewExecutor` inside `PhaseLoop`, driven by a scripted agent CLI that writes (or withholds) the review-findings sidecar,
**So that** verdict recomputation, severity gating, finding-status lifecycle, and executor failure paths are validated as they compose in production — not merely as isolated seams.

**Acceptance Criteria**:
- [ ] A test harness spawns/drives the real `ReviewExecutor` via a scripted agent CLI that writes a candidate sidecar with attacker-supplied `verdict` and findings; the engine recomputes the authoritative verdict from findings + `blockingSeverity` and the loop acts on the recomputed verdict, not the candidate's claimed one (regression for #1155 phantom-clean).
- [ ] Severity gating is exercised at `blockingSeverity` boundaries: an all-`minor` findings set with `blockingSeverity: major` yields `clean`; a single `open` `critical` finding yields `changes-required`.
- [ ] Finding-status lifecycle across rounds: an `open` finding at round 1 that the agent marks resolved is carried over as `resolved` at round 2; a sub-blocking finding is dropped at round ≥ 2 (per #1161).
- [ ] Failure paths each drive a distinct, asserted loop outcome: (a) agent exits 0 but writes no sidecar (missing artifact), (b) agent never exits (executor timeout → SIGTERM/SIGKILL), (c) agent exits non-zero.
- [ ] The scripted CLI is a real spawnable fixture, not a mocked `ChildProcessHandle`, for at least the write/withhold sidecar scenarios (no such fixture exists today).

### US2: Gate resume validated through the real label path

**As a** maintainer,
**I want** an integration test that pauses at a gate, applies the `completed:*` label the way the label monitor does, and resumes through the real `LabelManager.onResumeStart`,
**So that** the counter-reset and terminal-no-op resume behaviors are proven against the actual label-strip logic instead of hand-injected labels.

**Acceptance Criteria**:
- [ ] `remediation-limit` gate: loop pauses with `waiting-for:remediation-limit` + `agent:paused`; `completed:remediation-limit` is applied; on resume through `onResumeStart` the human-gate `completed:*` label survives the strip, the remediation counter resets, and the loop re-arms (regression for #1154).
- [ ] The post-validate `implementation-review` / `on-ci-green` terminal-no-op resume engages when both `completed:validate` and `completed:implementation-review` are present after the real resume path.
- [ ] The test drives `onResumeStart` for real; it does not pre-inject the surviving labels into the mocked issue response.

### US3: Clean-cycle and draft/ready assertions against real executors

**As a** maintainer,
**I want** the single-COMMENT-per-clean-cycle and draft/ready lifecycle assertions to run against the real `ReviewExecutor` + real `ReviewPoster` (once #1156 wires the poster),
**So that** the wiring these assertions depend on is exercised, not stubbed.

**Acceptance Criteria**:
- [ ] A clean review cycle posts exactly one COMMENT-event review via the real poster and flips the PR ready-for-review, driven by a real `ReviewExecutor` verdict.
- [ ] A `changes-required` cycle converts the PR to draft when the engine previously marked it ready, driven by a real verdict.
- [ ] Assertions previously passing against doubles are re-pointed at the real executor/poster composition without loss of coverage.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Provide a scripted agent-CLI test fixture (a real spawnable binary/script) that, per scenario, writes a specified review candidate sidecar, withholds it, exits non-zero, or hangs. | P1 | No such fixture exists; today's executor unit tests mock `agentLauncher.launch()` with an EventEmitter `ChildProcessHandle`. |
| FR-002 | Add an integration suite composing the real `ReviewExecutor` under `PhaseLoop`, asserting engine verdict recomputation overrides the candidate-claimed verdict. | P1 | Regression for #1155. |
| FR-003 | Cover severity gating at `blockingSeverity` boundaries via the composed loop (clean vs changes-required). | P1 | Uses `computeVerdict` / `SEVERITY_RANK` semantics through the executor, not by calling them directly. |
| FR-004 | Cover finding-status lifecycle across rounds through the composed loop: open→resolved carry-over and sub-blocking drop at round ≥ 2. | P1 | Sub-blocking drop depends on #1161 (landed). |
| FR-005 | Cover the three executor failure paths through the composed loop: missing sidecar, timeout (SIGTERM→SIGKILL), non-zero exit — each with a distinct asserted loop outcome. | P1 | |
| FR-006 | Add an integration test that resumes a `remediation-limit` gate through the real `LabelManager.onResumeStart` (label applied as the monitor would), asserting counter reset and re-arm. | P1 | Regression for #1154; must not pre-inject surviving labels. |
| FR-007 | Add an integration assertion that the post-validate `implementation-review` / `on-ci-green` terminal-no-op resume engages via the real resume path. | P2 | |
| FR-008 | Re-point the single-COMMENT-per-clean-cycle and draft/ready assertions at the real `ReviewExecutor` + real `ReviewPoster` composition. | P2 | Depends on #1156 poster wiring (landed). |
| FR-009 | Repurpose the #1132 scripted convergence/cap suites as charter-contract tests (asserting the prompt/charter shape and merge contract), not loop tests, so their coverage is retained without masquerading as composed-loop coverage. | P2 | Keep, don't delete. |
| FR-010 | Retain existing executor unit suites and cap-gate label-pair tests unchanged. | P2 | Explicit "keep" list from the issue. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Integration test proves a candidate sidecar claiming `verdict: clean` with an open blocking finding yields a `changes-required` loop path. | Pass | Run the new US1 suite; #1155 regression fails against a phantom-clean bug reintroduction. |
| SC-002 | The real `ReviewExecutor` (spawned via the scripted CLI fixture) is composed with `PhaseLoop` in at least one suite. | ≥ 1 suite | Grep the new suite for direct `ReviewExecutor` construction wired into `PhaseLoopDeps.reviewExecutor` with a real spawn, no verdict-steering stub. |
| SC-003 | Gate resume is exercised through the real `onResumeStart`, not injected labels. | Pass | The US2 suite calls the real label-resume path; deleting the #1154 `isHumanGateCompletion` guard makes it fail. |
| SC-004 | All three executor failure paths (missing sidecar, timeout, non-zero exit) are covered by distinct assertions. | 3/3 | Enumerate assertions in the US1 failure-path block. |
| SC-005 | Existing "keep" coverage (executor unit suites, cap-gate label-pair tests, repurposed convergence suites) still passes. | Green | Full `pnpm test` for the orchestrator package. |
| SC-006 | New suites run within the orchestrator integration-test time budget. | No CI timeout regression | CI wall-clock for the orchestrator test job. |

## Assumptions

- **(Clarified 2026-08-21, Q1)** The scripted CLI is spawned via a lightweight `AgentLauncher` test double whose `launch()` really spawns the fixture (`child_process.spawn(process.execPath, [fixturePath], …)`) and returns a real `ChildProcessHandle`. `ReviewExecutor` and verdict recomputation stay real (SC-002); the production `AgentLauncher` + claude-code launch plugin is not driven.
- **(Clarified 2026-08-21, Q2)** Only the write/withhold (missing-sidecar) scenarios use the real spawnable fixture. The timeout (SIGTERM→SIGKILL) and non-zero-exit paths reuse a mocked/hanging `ChildProcessHandle` with a tiny hand-constructed `phaseTimeoutMs` (matching `phase-loop.remediate-timeout.integration.test.ts`), avoiding the `.min(60_000)` floor and the SC-006 CI-budget risk. All three still yield distinct asserted outcomes.
- **(Clarified 2026-08-21, Q3)** The existing `phase-loop.resume-gates.integration.test.ts` already satisfies FR-006/FR-007 (real `LabelManager` over a fake `GitHubClient`, real `onResumeStart`, asserts survival + counter reset + terminal-no-op). US2 only verifies/extends it (e.g. applying the label via the monitor's exact mutation shape); no recompose with the real `ReviewExecutor` is required for the gate-resume regression.
- **(Clarified 2026-08-21, Q4)** `context.github` stays a recording **fake** `GitHubClient` (no live `gh`) across these suites; US3 assertions inspect recorded `createReview`/ready/draft calls. Process spawn, filesystem, and git remain real.
- Dependency issues are already merged to `develop`: #1161 (sub-blocking drop / finding-id match), #1156 (review-poster wiring), #1154 (resume label-strip fix). If any is not yet on the branch base, the corresponding acceptance criterion is deferred, not reworked.
- The scripted agent-CLI fixture writes to the canonical candidate path (`getReviewCandidatePath` under `.generacy/`) using the same `workflowId` the executor derives, so the engine reads what the fixture wrote.
- Real-spawn tests can create an isolated temp checkout (with `.generacy/`) and an isolated `HOME`/git config, following the existing real-git integration-test pattern in the repo.
- `agentLauncher.launch()` can be pointed at the scripted fixture binary via existing intent/plugin wiring without production changes.

## Out of Scope

- Any production behavior change to `ReviewExecutor`, `RemediateExecutor`, `PhaseLoop`, `LabelManager`, or `ReviewPoster` — this is test-only coverage. (A ≤ small, clearly-linked seam fix is acceptable only if a genuine untestable seam is discovered.)
- CI-merge-gate / `on-ci-green` production logic beyond asserting the terminal-no-op resume engages.
- Cockpit-side gate-answer wording or the label monitor's pause/resume pairing rules (owned elsewhere).
- Deleting or rewriting the #1132 convergence/cap suites beyond repurposing them as charter-contract tests.

---

*Generated by speckit*
