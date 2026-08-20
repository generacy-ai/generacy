---
'@generacy-ai/orchestrator': patch
---

Add a standalone deterministic engine-authored review marker-match helper
(`matchEngineAuthoredReviewMarker` / `commentCarriesEngineAuthoredReviewMarker` /
`ENGINE_AUTHORED_REVIEW_MARKERS`) co-located in the review-poster marker module
(#1127 D-3 fallback). Line-anchored at column 0, case-sensitive ASCII; `> `-quoted
markers do not match. Internal surface consumed by #1130's monitor routing; not
re-exported from the package's public entrypoint.
