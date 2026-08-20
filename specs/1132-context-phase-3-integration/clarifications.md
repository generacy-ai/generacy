# Clarifications: Full review⇄remediate loop end-to-end (Phase-3 integration)

Issue: generacy-ai/generacy#1132

## Batch 1 — 2026-08-20

### Q1: Merge-conflict entry point (#1131) coverage
**Context**: The Context section and `Depends on:` list four P3 executors (#1128–#1131), but the three user stories / FR-001–FR-003 scenarios only exercise three entry points: review-blocking, validate-failure, and external-human-feedback. #1131 (merge-conflict re-arm → resolution-scoped review) is a stated dependency yet no scenario drives it. This determines whether the harness ships a fourth scenario.
**Question**: Does this integration suite exercise the #1131 merge-conflict → resolution-scoped-review path as its own scenario, or is #1131 integration deferred (this suite covers only the three remediate entry points and pins #1131 in the contract artifact)?
**Options**:
- A: Add a fourth scenario — drive merge-conflict re-arm into a resolution-scoped review and assert convergence, alongside the three remediate entry points.
- B: Defer — cover only the three remediate entry points (review-blocking, validate-failure, external-feedback); document/cross-reference #1131 in the loop-contract artifact but ship no merge-conflict scenario.

**Answer**: *Pending*

### Q2: Per-round verdict steering with the real review executor
**Context**: US1 requires deterministic per-round review outcomes (2 blocking → 1 resolved/1 open → clean). Assumption §89 forbids test-only doubles for the P3 executors, so the **real** review executor runs and computes the verdict from a findings artifact. The harness must therefore steer the verdict through an external seam, not by faking the executor. This mirrors #1124's verdict-steering shim but must be pinned for P3.
**Question**: How does the harness deterministically drive each round's review verdict — by seeding the findings-artifact sidecar the review executor reads, or by controlling the mocked CLI/agent output that the executor parses into findings?
**Options**:
- A: Seed the findings-artifact sidecar per round (pre-write the sidecar the review executor reads; engine still recomputes the verdict from it).
- B: Control the mocked CLI/agent output per round (the review executor parses the injected agent output into findings and recomputes the verdict).
- C: Whichever seam #1124 shipped — bind at implement time against merged #1124; do not prescribe now.

**Answer**: *Pending*

### Q3: US3 assertion target — real monitor routing vs. standalone marker-match helper
**Context**: In P2/#1127 (Q4=B), the engine-authored exclusion was asserted via a *standalone marker-match helper* because #1130 had not merged. Under the rebase-on-develop assumption for P3, #1130 (monitor exclusion + external-feedback→remediate routing) lands **first**, so the real `PrFeedbackMonitorService` exclusion is available. This determines what FR-003/SC-004 actually assert against.
**Question**: Does FR-003/SC-004 assert the **real** `PrFeedbackMonitorService` routing (external feedback re-enters `remediate`; engine-authored/marker-carrying threads are excluded), now that #1130 has landed — or does it remain a standalone marker-match helper assertion as in #1127?
**Options**:
- A: Assert the real `PrFeedbackMonitorService` routing end-to-end (external re-enters `remediate`, engine threads excluded) — the integration point #1130 shipped.
- B: Keep it a standalone marker-match helper assertion (do not drive the real monitor); rely on #1130's own tests for the routing.

**Answer**: *Pending*

### Q4: Cap-variant human answer + counter-reset seam (US2/FR-002)
**Context**: US2/FR-002/SC-003 require the harness to pause at `waiting-for:remediation-limit`, surface remaining open findings, then — on a human answer — reset the counter and converge. #1128 owns the cap gate + reset mechanism; the harness must simulate the "human answer" through an injected seam and assert the reset. It is unclear which signal constitutes the answer and how the reset is observed.
**Question**: What simulates the human answer that resets the remediation counter, and what does the harness assert as the reset signal?
**Options**:
- A: A gate-resume label event (e.g., removing `waiting-for:remediation-limit` / applying the completion label) injected through the existing phase-loop gate seam; assert the counter returns to zero and the loop resumes.
- B: A clarification-style answer comment/payload injected through the human-answer seam; assert counter reset + resume.
- C: Whichever resume mechanism #1128 shipped — bind at implement time against merged #1128; assert only the observable counter-reset + convergence, not the trigger shape.

**Answer**: *Pending*
