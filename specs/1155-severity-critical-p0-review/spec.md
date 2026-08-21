# Feature Specification: Review executor must fail (not falsely pass) on CLI failure, timeout, or missing findings

**Branch**: `1155-severity-critical-p0-review` | **Date**: 2026-08-21 | **Status**: Draft

## Summary

**Severity: critical (P0).** The review-phase executor (`packages/orchestrator/src/worker/review-executor.ts`) treats a CLI failure, timeout, or crash as a *clean* review — a **phantom-clean verdict** — instead of a phase failure. Two hardcoded behaviours combine to produce this:

1. `ReviewExecutor.execute()` returns `success: true, exitCode: 0` unconditionally (`review-executor.ts:259-265`), regardless of the actual child exit code that was already captured at `:207`.
2. `readCandidateFindings()` returns `[]` for a missing / unreadable / schema-invalid sidecar (`review-artifact.ts:235-270`), and `computeVerdict([])` returns `'clean'` (`review-artifact.ts:280-289`).

So when the review agent dies before writing its findings sidecar — usage-limit "exit 1, no output", timeout SIGTERM/SIGKILL, or crash — the engine reads zero findings, computes a `clean` verdict, reports the phase as a success, and the workflow advances to `validate` (and marks the PR ready, `phase-loop.ts:1603) as though a real review confirmed the change is sound. Confirmed by three independent traces. All line refs at `develop` 155b3464.

### Failure modes

- **Round 1, agent dies before writing the sidecar.** Findings `[]` → `computeVerdict([]) = 'clean'` → phase reports success → loop proceeds to `validate` and (via `#1125`) marks the PR ready. This also re-opens the implement empty-diff bypass the review phase was meant to close (the empty-diff check is prompt text only — `review-charter.ts:72-80`). On the `address-pr-feedback` route, a phantom-clean converges the loop and `resolveExternalFeedbackThreads` resolves human review threads with "loop completed" replies although nothing was verified.
- **Round ≥ 2, agent writes nothing.** The *prior engine artifact* is re-parsed as this round's candidate — `CandidateArtifactSchema` is non-strict and only reads `findings`, so the previous round's stamped findings survive as if the agent had re-confirmed them. Indistinguishable from "agent confirmed prior findings".
- **Crash window.** Worker death between the agent's candidate write and the engine's atomic rewrite (`review-executor.ts:232-250`) leaves a strict-schema-invalid file → `readReviewArtifact` → `null` → the next write restarts `remediationCount` at 0, silently refilling the review↔remediate budget.

## Clarifications

### Session 2026-08-21 (Batch 1)

- **Q1 (clean-signal contract) → A**: The sole signal for a legitimate `clean` verdict is a candidate written *this round* whose findings compute to `clean` ("proof of review"). A missing or stale candidate is never `clean`, regardless of exit code (including exit 0). The verdict signal is independent of the FR-001 exit-code gate.
- **Q2 (candidate vs engine-artifact separation) → A**: Use a separate candidate file path. The agent writes the candidate; the engine reads it, writes the authoritative artifact to the existing path, then clears the candidate. A missing candidate next round = "nothing written this round". This also isolates the crash window, satisfying FR-004 for free.
- **Q3 (persistence on failure) → A**: Persist nothing on a failed / no-verdict round — leave any prior-round engine artifact exactly as-is, preserving `round` and `remediationCount`; no fresh `clean` is ever written.
- **Q4 (`round` advancement on failure) → A**: `round` advances only when a review completes and produces a fresh verdict; a failed / timed-out round does not consume the counter (consistent with Q3-A), so repeated failures cannot burn the `#1128` remediate cap.

## User Stories

### US1: Failed review does not pass as clean (Primary)

**As an** operator relying on the engine-native review phase to gate merges,
**I want** a review whose CLI failed, timed out, or crashed to be treated as a phase failure,
**So that** an unreviewed change is never advanced to `validate` or marked ready as if it had been reviewed clean.

**Acceptance Criteria**:
- [ ] When the review CLI exits non-zero, the phase result reports `success: false` with the real exit code (mirroring `remediate-executor.ts:227`).
- [ ] When the review CLI times out (SIGTERM/SIGKILL), the phase result reports `success: false`.
- [ ] After a failed/timed-out CLI with no fresh findings written this round, the engine does NOT compute or persist a `clean` verdict, and the loop does NOT advance to `validate` or mark the PR ready.
- [ ] A phantom-clean can no longer resolve human review threads on the `address-pr-feedback` route.

### US2: Candidate findings are distinguishable from a stale engine artifact

**As** the review engine on round ≥ 2,
**I want** to read only the findings the agent wrote *this round*,
**So that** a no-op agent does not have the previous round's findings silently re-ingested as a fresh confirmation.

**Acceptance Criteria**:
- [ ] A candidate written by the agent this round is distinguishable from the engine-authoritative artifact left by a prior round (separate path or a written-this-round marker).
- [ ] If no candidate was written this round, the executor treats it as "no findings produced" (a failure/no-verdict), not as an implicit re-confirmation of prior findings.

### US3: Crash window does not silently reset remediation budget

**As** the review engine recovering from a mid-write worker death,
**I want** a schema-invalid or partially-written artifact to be recoverable without silently resetting `remediationCount`,
**So that** the review↔remediate cap (`#1128`) is not defeated by a crash.

**Acceptance Criteria**:
- [ ] A crash between candidate write and engine rewrite does not cause `remediationCount` to reset to 0 on the next review round.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The review executor MUST propagate the child CLI exit code and timeout into `PhaseResult` (`success` reflects `exitCode === 0`; timeout ⇒ `success: false`), instead of the hardcoded `success: true, exitCode: 0`. | P0 | Mirror `remediate-executor.ts:225-231`. |
| FR-002 | The sole signal for a legitimate `clean` verdict is a candidate written *this round* whose findings compute to `clean` ("proof of review", Q1-A). A missing or stale (not-written-this-round) candidate is NEVER `clean`, regardless of the CLI exit code — including exit 0. In that case the engine treats the round as a failure/no-verdict and MUST NOT persist any artifact (Q3-A): any prior-round engine artifact is left exactly as-is, so `round` and `remediationCount` are preserved and no fresh `clean` is written. A first-round failure ⇒ no artifact exists ⇒ nothing to advance. | P0 | Verdict signal (fresh candidate) is independent of the exit-code gate (FR-001). Closes the exit-0-but-no-fresh-sidecar gap. |
| FR-003 | Candidate findings MUST be written to a separate candidate file path (e.g. `review-candidate-<id>.json`), distinct from the engine-authoritative artifact path (Q2-A). The agent writes the candidate; the engine reads it, writes the authoritative artifact to the existing path, then clears the candidate. A missing candidate on the next round is unambiguously "nothing written this round". | P0 | Fixes round ≥ 2 stale re-ingestion. The agent's write target is supplied via the charter `sidecarRelPath` value — a caller-supplied path change, not an edit to charter prompt text. |
| FR-004 | A worker crash between the agent's candidate write and the engine's rewrite MUST NOT silently reset `remediationCount`. Satisfied for free by FR-003's separate candidate path: the engine artifact stays intact through the crash window. | P1 | Crash-window resilience. |
| FR-005 | When the review phase fails per FR-001/FR-002, the loop MUST NOT advance to `validate`, MUST NOT mark the PR ready, and MUST NOT resolve external feedback threads with a "loop completed" reply. | P0 | Downstream consumers gated on `result.success` / `verdict === 'clean'`. |
| FR-006 | Regression tests MUST cover the missing-sidecar, timeout, non-zero-exit, round ≥ 2 no-op, and crash-window paths. | P0 | Explicit fix-direction ask in the issue. |
| FR-007 | Existing happy-path behaviour (agent writes valid candidate, engine recomputes verdict, `#1131` empty-window short-circuit, `#1128` `remediationCount` carry-forward) MUST remain unchanged. | P0 | No regression to the working path. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Failed/timed-out review CLI never yields a `clean` verdict that advances the workflow. | 100% | Unit/integration tests for non-zero exit, timeout, and missing sidecar. |
| SC-002 | Round ≥ 2 with a no-op agent does not re-ingest the prior engine artifact as fresh candidate findings. | 100% | Regression test drives round 2 with no candidate write. |
| SC-003 | Crash-window artifact does not reset `remediationCount` on the subsequent review round. | 100% | Regression test simulates the mid-write crash state. |
| SC-004 | Happy-path review runs (valid candidate) produce a byte-identical artifact and phase result to pre-fix. | No diff | Existing review-executor / phase-loop tests remain green. |

## Assumptions

- The child process exit code / timeout signal is already available in `execute()` (`review-executor.ts:205-207` captures `exitCode`); FR-001 is a propagation change, not new capture.
- The `remediate-executor.ts:225-231` pattern (`success: exitCode === 0`) is the intended contract for phase executors and is the reference for FR-001.
- Downstream consumers already branch on `result.success` (`phase-loop.ts:1591-1607, :1612`) and `artifact.verdict` (`phase-loop.ts:1603, :1388`), so failing the phase / withholding a `clean` verdict is sufficient to stop the phantom-clean cascade without touching those call sites.
- The review phase is feature-flagged (`reviewPhaseEnabled`, default OFF); this fix does not change the flag or its default.

## Out of Scope

- Retry/re-dispatch policy for a failed review CLI (whether a failed review pauses, retries, or escalates is a phase-loop/gate decision, not this executor fix).
- Changes to the `remediate` executor, the CI merge gate (`#1133`), or the review charter prompt text.
- Any change to the strict `ReviewArtifactSchema` shape beyond what FR-003/FR-004 require to distinguish candidate from engine artifact.
- Cockpit/cloud-side handling of a failed-review label or state.

---

*Generated by speckit*
