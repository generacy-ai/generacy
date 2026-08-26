# Feature Specification: Validate-origin remediation must consume budget and have a reliable stop

**Branch**: `1158-severity-major-p1-validate` | **Date**: 2026-08-21 | **Status**: Draft

## Summary

**Severity: major (P1).** When the review/remediate flow is enabled, a failing `validate` phase is routed into the review→remediate loop (#1129). On this validate-origin path the remediation budget (`maxRemediations`) is never consumed and the fingerprint backstop is unreliable, so the loop has **no working stop**: the fixer CLI can be re-spawned indefinitely. Confirmed by two independent traces.

Four defects, all on the validate-origin branch of the remediate seam:

1. **Budget never consumed.** The seam dispatches `ValidateFixHandler` then `runStubPhase('remediate')` with no `bumpRemediationCount` (`phase-loop.ts:1718-1746`). The #1129 synthesis carries `remediationCount` forward without incrementing it (`phase-loop.ts:1041-1055`). `RemediateExecutor` — the sole caller that bumps the count — runs only on the review-origin branch. So the `on-remediation-limit` gate (`phase-loop.ts:1419-1438`), which trips on `remediationCount >= maxRemediations`, can never fire on this path. The in-code claim that the carried-forward count "still bounds the loop" is false.
2. **Fingerprint backstop unreliable.** The `failed:validate-repeated` backstop keys the fingerprint on `evidence.reason ?? evidence.outputTail` (`failure-fingerprint.ts:62`), and validate failures set no `reason` (`buildErrorEvidence` only sets `reason` when a `classifier` is passed — `phase-loop.ts:2411-2416`). It therefore hashes the raw bounded test output. Any output nondeterminism (durations, parallel test ordering — near-universal in test runners) yields a fresh fingerprint each round, so the repeat-failure escalation never trips.
3. **Adapter has no timeout and ignores exit code.** `ValidateFixHandler.handle` awaits `exitPromise` with no CLI timeout (`validate-fix-handler.ts:118-128`); a hung fixer stalls the phase loop until job abort. A non-zero exit is logged but still commits and pushes.
4. **Evidence cites the wrong command.** Evidence/alerts cite `config.validateCommand` rather than the targeted effective command that actually ran for the bugfix workflow (`phase-loop.ts:988-989, 1035`).

**Fix direction (per Batch 1 clarifications):** route validate-origin remediation through `RemediateExecutor` so it inherits the existing `bumpRemediationCount`, SIGTERM→SIGKILL timeout, and commit/push-partial-work-on-timeout semantics, and retire the separate `ValidateFixHandler` spawn path (Q1=B). All remediations — review-origin and validate-origin — draw from one shared `remediationCount` / `maxRemediations` budget (Q5=A). Give validate failures a stable fingerprint `reason` composed of the effective command + a parsed, sorted set of failing-test identifiers via the existing `hashValidationEvidence` (Q2=A), not the raw output tail. On the cap round, re-run `validate`: a passing re-run is the clean escape, a still-failing re-run pauses at the `on-remediation-limit` gate (Q4=A). Record the effective validate command in evidence and alerts.

---
Filed from a post-merge code review of epic generacy-ai/generacy#1120. Part of follow-up epic generacy-ai/generacy#1153. All line refs at develop `155b3464`.

## User Stories

### US1: Validate-origin remediations are bounded by the same budget (P1)

**As an** operator running the review/remediate flow,
**I want** validate-origin remediation attempts counted against `maxRemediations`,
**So that** a persistently failing validate loop pauses for triage instead of re-spawning the fixer indefinitely.

**Acceptance Criteria**:
- [ ] Each validate-origin remediation dispatch increments `remediationCount` exactly once.
- [ ] When `remediationCount` reaches `maxRemediations` and the verdict is still `changes-required`, the `on-remediation-limit` gate pauses the workflow (`waiting-for:remediation-limit` + `agent:paused`).
- [ ] A cap-round fix is followed by a fresh `validate` re-run; a passing re-run proceeds (not treated as exhaustion), a still-failing re-run pauses at the `on-remediation-limit` gate (Q4=A).
- [ ] Validate-origin and review-origin remediations share one `remediationCount` / `maxRemediations` budget; a mixed loop is bounded by the single cap regardless of origin (Q5=A).

### US2: The repeat-failure backstop terminates a nondeterministic validate loop (P1)

**As an** operator,
**I want** the `failed:validate-repeated` backstop to key on a stable failure identity,
**So that** a validate loop whose only variation is test-output noise still escalates after the repeat threshold.

**Acceptance Criteria**:
- [ ] Two validate failures for the same underlying defect produce the same fingerprint even when raw test output differs (timings, parallel ordering).
- [ ] The `-repeated` backstop escalates at `REPEAT_FAILURE_THRESHOLD` on this path.

### US3: A hung or failing fixer cannot stall or silently push (P1)

**As an** operator,
**I want** the validate-fix adapter to enforce a CLI timeout and respect the exit code,
**So that** a hung fixer is killed and a failed fix attempt does not commit and push.

**Acceptance Criteria**:
- [ ] The fixer CLI is bounded by the standard SIGTERM (then SIGKILL) timeout used elsewhere in the worker.
- [ ] A **clean-run** non-zero fixer exit does not commit or push the changes on this branch.
- [ ] A **timeout-kill** (non-zero exit with partial work on disk) commits and pushes the partial work, mirroring `RemediateExecutor` (Q3=B).

### US4: Evidence and alerts cite the command that actually ran (P2)

**As an** operator triaging a validate failure,
**I want** the effective validate command recorded in evidence and alerts,
**So that** the alert reflects what the bugfix workflow actually executed.

**Acceptance Criteria**:
- [ ] The fingerprint, failure alert, and synthesized finding reference the effective command, not `config.validateCommand`, when they differ.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Validate-origin remediation dispatch MUST increment `remediationCount` exactly once per attempt by routing through `RemediateExecutor` (Q1=B); the separate `ValidateFixHandler` spawn path is retired. | P1 | `phase-loop.ts:1718-1746`, `remediate-executor.ts:141,195,216` |
| FR-002 | The carried-forward `remediationCount` in the #1129 synthesis MUST NOT silently reset the budget. | P1 | `phase-loop.ts:1050` |
| FR-003 | The `on-remediation-limit` gate MUST become reachable on the validate-origin path once the count is bumped. | P1 | `phase-loop.ts:1435-1438` |
| FR-004 | Validate-failure evidence MUST set a stable `reason` derived from the effective command + a parsed, sorted set of failing-test identifiers via the existing `hashValidationEvidence` (Q2=A), not the raw output tail. | P1 | `failure-fingerprint.ts:62`, `buildErrorEvidence`, `evidence-hash.ts:32-176` |
| FR-005 | The fingerprint for the same underlying validate defect MUST be stable across runs despite test-output nondeterminism. | P1 | |
| FR-006 | The validate-fix adapter MUST bound the fixer CLI with a SIGTERM/SIGKILL timeout consistent with other worker spawn sites. | P1 | `validate-fix-handler.ts:118-128` |
| FR-007 | A clean-run non-zero fixer exit MUST NOT commit or push. A timeout-kill (also non-zero) is exempt: it preserves partial work by committing/pushing, mirroring `RemediateExecutor` (Q3=B). | P1 | `remediate-executor.ts:189-207`, `phase-loop.ts:1658-1660` |
| FR-008 | Evidence, failure alerts, and the synthesized finding MUST record the effective validate command when it differs from `config.validateCommand`. | P2 | `phase-loop.ts:988-989, 1035` |
| FR-009 | With the review phase flag OFF, behavior MUST be byte-identical to today (no validate routing). | P1 | Regression guard |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Validate-origin remediation attempts before the cap pause | Exactly `maxRemediations` | Unit/integration test drives repeated validate failures; asserts pause at the cap |
| SC-002 | Fingerprint stability across output-noise-only variation | Identical fingerprint | Test with two evidences differing only in timings/ordering |
| SC-003 | `-repeated` backstop escalation on nondeterministic validate loop | Escalates at threshold | Integration test |
| SC-004 | Hung fixer termination | Killed at timeout; partial work committed/pushed, loop continues | Test with a non-terminating fixer double |
| SC-005 | Clean-run non-zero fixer exit → no push | No commit/push | Test asserts branch untouched (timeout-kill exempt per Q3=B) |
| SC-006 | Flag-OFF behavior | Byte-identical to pre-change | Regression test |

## Assumptions

- The `on-remediation-limit` gate, `maxRemediations` resolution, `bumpRemediationCount`, and `RemediateExecutor` from #1128 are present and correct on the review-origin path; only the validate-origin path is defective.
- Routing validate-origin remediation through `RemediateExecutor` (Q1=B) inherits the SIGTERM → grace → SIGKILL timeout envelope for free (FR-006), so no separate timeout implementation is added to `ValidateFixHandler`.
- `RemediateExecutor`'s timeout path commits/pushes partial work via `commitPushAndEnsurePr('remediate')` (Q3=B); the validate-origin path relies on this same seam behavior rather than adding push logic.
- The stable fingerprint `reason` (Q2=A) is produced by the existing `hashValidationEvidence` (`evidence-hash.ts:32-176`), which already parses+sorts failing-test identifiers with a whole-transcript fallback; no new parser is written.
- "Effective command" for FR-008 is the targeted per-workflow validate command already resolved elsewhere for the bugfix workflow.

## Out of Scope

- Redesigning the review/remediate loop, the gate/resume label protocol, or the fingerprint primitive itself.
- The review-origin remediation path (already bumps via `RemediateExecutor`).
- Cockpit gate-answer wording (agency repo).
- Adding new persisted state or new label vocabulary beyond what #1128/#1129 already ship.

---

*Generated by speckit*
