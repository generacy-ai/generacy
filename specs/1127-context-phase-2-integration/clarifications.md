# Clarifications: implement→review→ready flow end-to-end (Phase-2 integration)

Issue: generacy-ai/generacy#1127

## Batch 1 — 2026-08-19

### Q1: Dependency landing order
**Context**: Determines whether the implement phase blocks on #1124/#1125/#1126 merging to `develop` first (rebase), or whether this branch may co-land unmerged executor work. Mirrors #1123 Q1=B. Governs whether any real-executor code appears in this diff.
**Question**: Do #1124/#1125/#1126 merge to `develop` first, with this branch rebased on them and shipping ONLY integration tests + contract artifacts (no re-implementation), or do they co-land here?
**Options**:
- A: Rebase-on-develop — executors land first; this branch rebases and ships only integration tests + the two contracts (implement blocks until they land).
- B: Co-land — this branch may include/depend on unmerged executor work and land together.

**Answer**: *Pending*

### Q2: Contract authorship vs. pinning
**Context**: FR-006/FR-007 require the engine-authored review marker and findings-artifact shape to be documented in shipped code/contracts. It is unclear whether this issue *authors* those contract docs (is the documentation home) or *asserts + cross-references* contracts already shipped by #1124/#1125.
**Question**: Are the marker + findings-artifact contract docs authored in this issue's diff, or already shipped by #1124/#1125 and merely asserted/cross-referenced here?
**Options**:
- A: Author here — this issue is the documentation home; it authors the marker + findings-artifact contract docs in `contracts/`.
- B: Pin/assert only — #1124/#1125 ship the contracts; this issue asserts against them and cross-references, authoring nothing new.

**Answer**: *Pending*

### Q3: `remediate` stub fidelity
**Context**: The changes-required branch needs a stub `remediate` to exercise the review→remediate→re-review seam and the ready→draft transition. It must be clear this is a test-only double, not a shipped placeholder executor (FR-008 forbids a real remediate executor).
**Question**: Is the `remediate` used by the changes-required branch a test-only double injected through the existing phase-loop dependency seam (as in #1123), or a shipped placeholder executor?
**Options**:
- A: Test-only double injected through the existing phase-loop seam — no shipped placeholder executor.
- B: Shipped placeholder executor in production code.

**Answer**: *Pending*

### Q4: Exclusion-predicate ownership (FR-005 vs #1130)
**Context**: FR-005/SC-005 require asserting `PrFeedbackMonitorService`'s engine-authored-exclusion predicate returns "exclude" against "the real predicate." But the monitor change that excludes engine threads and routes external feedback is #1130 (P3), listed Out of Scope. If the predicate does not exist yet, there is nothing real to assert against — this determines whether production monitor code is touched here.
**Question**: Does this issue add the engine-authored-exclusion predicate/helper now (so FR-005 asserts real code), or does #1130 own the predicate entirely and this issue only pins the marker contract + tests a standalone marker-match helper?
**Options**:
- A: Add a minimal standalone exclusion predicate/helper now (marker-match), exposed for `PrFeedbackMonitorService`, asserted by FR-005; #1130 later wires it into routing.
- B: #1130 owns the predicate; this issue ships only the marker contract and asserts a marker-match helper, not `PrFeedbackMonitorService` behavior itself.

**Answer**: *Pending*
