---
"@generacy-ai/orchestrator": patch
---

Add delta-scoped verification-pass convergence logic for the engine-native `review`
phase (#1126). A re-review (round ≥ 2) is now scoped to the change set since the
last-reviewed SHA — or, for a merge-conflict re-arm, the resolution base/head SHAs
carried on the pause-context sidecar — unioned with still-open findings, so
review⇄remediate loops converge instead of inventing fresh nitpicks each round.

New internal module `packages/orchestrator/src/worker/review/`: `determineReviewMode`
(full-review round 1 vs. verification round n+1), `computeReviewDelta` (resolution →
last-reviewed → full-diff base selection, widening safely on an unresolvable SHA
without resetting to round 1), `composeVerificationInput`, `buildVerificationPrompt`,
and a monotonic status machine (`advanceArtifact` / `filterNewFindings` /
`computeVerdict`) that resolves addressed delta-located findings, keeps `resolved`
terminal, drops sub-blocking advisory findings after round 1, and advances the
last-reviewed SHA. The findings-artifact interface is a placeholder seam for #1124.
`PauseContextSchema` gains read-side optional `resolutionBaseSha`/`resolutionHeadSha`
(written by #1131). No new public package exports.
