---
"@generacy-ai/orchestrator": patch
---

Wire the PR review-posting + draft/ready lifecycle — the reader was never supplied (#1156).

The entire #1125 PR-visibility/lifecycle block in the phase loop was dead in production: it guards on both `deps.reviewPoster` and `deps.readFindingsArtifact`, but the worker wiring site supplied only the poster and left the reader `undefined`, so the guard was permanently false. As a result no COMMENT-event review ever posted, re-review never resolved inline threads, the clean-verdict `markReadyForReview` never fired, and `convertToDraftIfEngineMarkedReady` was a guaranteed no-op.

This supplies the `readFindingsArtifact` closure (via a new pure `bridgeReviewArtifact()` in `review-findings-bridge.ts` that maps the engine-written `ReviewArtifact` sidecar into the `FindingsArtifact` the poster consumes) plus the four latent-defect corrections wiring it exposes: severity-threshold bridging consistent with `computeVerdict`, a live `getPrNumber` getter on `ReviewPoster` (kills the "post to PR #0" bug for early rounds), the posting/gating `round` taken from the sidecar rather than the loop-local counter that resets each run, and a cross-run `markedReadyByEngine` flag persisted in the sidecar so a later re-entry can convert a previously-engine-marked-ready PR back to draft without ever demoting a human-marked-ready PR.

Internal plumbing only — no new public exports. Whole path stays inert when `reviewPhaseEnabled=false` or no sidecar is produced.
