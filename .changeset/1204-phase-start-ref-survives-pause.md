---
"@generacy-ai/orchestrator": patch
---

Stop implement failing as `no-product-code-changes` after a mid-phase pause (#1204).

The #1107 phase-scoped product-diff guard retired its Redis `phase-start-ref`
the moment the guard *passed*. Passing the guard is not the same as finishing
the phase: `implement` can still pause afterwards — the merge-conflict gate is
armed on both `implement` and `validate`, and the `manual-validation` pause
returns later still. With the anchor already gone, the resume re-entered
`implement`, captured a fresh ref at whatever HEAD it found (for a
merge-conflict resume, the resolver's own merge commit), the agent correctly
found every task done and no-op'd, and the window saw only the
completion-banner commit — so a finished implementation failed as
`no-product-code-changes`, twice in a row, escalating to
`failed:implement-repeated`.

The clear now happens at genuine phase completion (step 6b, plus the
`manual-validation` pause that also grants `completed:implement`), via a new
`clearPhaseStartRef` helper. A re-entry *before* completion keeps measuring
from the phase's original anchor and so spans the work it already did; a
re-entry *after* completion (review rework, address-pr-feedback) still captures
a fresh window, so a genuine no-op still fails. The key is now built by a
shared `phaseStartRefKeyFor` so the capture site and both clear sites cannot
drift. The failure path is untouched — SC-004 (`own-diff empty even though
baseRef...HEAD carries product files`) still fails, so the cumulative window
still cannot satisfy the guard.
