---
"@generacy-ai/orchestrator": patch
---

Fix four merge-conflict scoped-review lifecycle defects (#1164, `workflow:speckit-bugfix`).

The merge-conflict → scoped-review path introduced with the engine-native review/remediate epic carried four related defects. All fixes are orchestrator-internal (`worker/` surface, not re-exported at the package public boundary); no new label vocabulary and no new persisted state. Both epic flags (`reviewPhaseEnabled`, `ciMergeGateEnabled`) remain the on/off switches — a cluster with both OFF is unaffected.

- **Stale `reviewScope` (FR-001/FR-002)** — the review executor now honors `context.reviewScope` only on round 1 (`!priorRound`). Round 2+ falls back to the standard `lastReviewedCommitSha`..HEAD delta, so remediation commits are visible and the loop converges instead of burning to the remediation cap with the defect already fixed.
- **Base-delta resolution scope (FR-003)** — the resolution scope now carries the live conflicted-path allowlist (`git diff --name-only --diff-filter=U`) on the post-conflict-resolution success path only; the charter names the allowlist instead of the full parent-1 base delta. No-op and clean-merge success paths leave it absent and fall back to the pre-#1164 range description.
- **Trivial-diff charter rule (FR-004/FR-005)** — the "empty or trivial diff → blocking finding" paragraph is emitted only for whole-PR round-1 reviews (`!verification && !diffWindow`), so a small-but-valid scoped resolution no longer triggers a spurious `changes-required` loop.
- **Validate-bypass + crash window (FR-006/FR-007/FR-008)** — `applySuccessDisposition` now also removes `completed:validate` + `completed:implementation-review` on re-arm so the terminal short-circuit no longer fires on the post-merge tree and `validate` runs on the merged tree before mark-ready. Ownership-label clearing moves to an `afterEnqueue` closure invoked after `enqueueIfAbsent` resolves, converting the pre-#1164 "no label + no work" stall into a benign "queued work + stale ownership label".
