# Clarifications

## Batch 2026-08-20

### Q1: Remediation counter storage
**Context**: `ReviewArtifactSchema` (`review-artifact.ts`) today holds `findings`, `verdict`, `round`, `lastReviewedCommitSha` — there is **no** remediation-counter field. FR-005 wants a counter that resets on resume, while #1126 relies on `round` being monotonic for delta-scoped re-review. The spec (Assumptions) explicitly defers this. This decides the schema change and the gate re-key.
**Question**: How should the resettable remediation counter be stored relative to the existing review `round`?
**Options**:
- A: Add a distinct field (e.g. `remediationCount`) to the sidecar; `round` stays monotonic for delta-scoping and only `remediationCount` resets on resume.
- B: Reuse `round` as the counter and reset `round` itself on resume (accepting the impact on #1126 delta-scoping).
- C: Distinct field, but also reset `round` on resume (both reset together).

**Answer**: *Pending*

### Q2: Validate-failure evidence — in scope now?
**Context**: FR-002 says the remediate prompt is built from open blocking findings "**and/or** validate-failure evidence." But the #1121 seam only fires `remediate` after a successful `review` (via `remediateTrigger`); there is no `validate → remediate` wiring today. Whether validate-failure remediation is wired in this issue substantially changes scope.
**Question**: Does this issue wire `remediate` to consume validate-failure evidence, or is remediate driven solely by review findings for now?
**Options**:
- A: Review findings only this issue; validate-failure remediation is deferred to a later epic issue (prompt supports findings only).
- B: Wire validate-failure evidence too — add the `validate → remediate` path and include failure evidence in the prompt now.

**Answer**: *Pending*

### Q3: Counter reset + gate resumeFrom on operator answer
**Context**: FR-009/FR-010. Today `GATE_MAPPING['remediation-limit'] = { phase: 'review', resumeFrom: 'review' }`, and `remediate` is off-sequence (only reachable via the `review` seam). "Resume into remediate with a reset counter" needs a concrete write site and resume target.
**Question**: On `completed:remediation-limit`, where does the counter reset happen and what is the resume target?
**Options**:
- A: Keep `resumeFrom: review`; reset the counter to 0 in the sidecar when the loop detects `completed:remediation-limit` at the gate-satisfaction check, so the re-entered `review` seam fires `remediate` with a fresh budget.
- B: Reset the counter at worker/dispatch startup when the completed label is present (before the phase loop), then resume at `review`.
- C: Change the mapping to resume more directly into the remediate path (specify the new `resumeFrom`).

**Answer**: *Pending*

### Q4: Does a timed-out / partial remediate pass increment the counter?
**Context**: US4/FR-011 require partial-work safety: a CLI timeout still commits+pushes partial changes and the next entry continues. SC-001 says "one execution = +1 regardless of finding count." It is unstated whether a timed-out execution counts as a remediation for the cap.
**Question**: Should a `remediate` execution that times out mid-work still increment the remediation counter?
**Options**:
- A: Yes — any execution (success or timeout) increments by exactly one; a persistently stuck loop then reaches the cap and pauses for a human.
- B: No — only executions that complete the CLI increment; timeouts continue without consuming budget.

**Answer**: *Pending*

### Q5: Gate activation predicate with the new counter
**Context**: The current gate fires when `artifact.round >= maxRemediations && artifact.verdict === 'changes-required'` (`phase-loop.ts:1138-1141`). FR-007 re-keys the gate to the remediation counter. The verdict conjunct is described as load-bearing (a `clean` review on the cap round must proceed to `validate`, not pause).
**Question**: What is the exact gate-activation predicate after re-keying to the remediation counter?
**Options**:
- A: `remediationCount >= maxRemediations && verdict === 'changes-required'` (keep the verdict conjunct — pause only when still blocked at the cap).
- B: `remediationCount >= maxRemediations` alone (pause at the cap regardless of verdict).

**Answer**: *Pending*
