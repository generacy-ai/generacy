---
"@generacy-ai/orchestrator": patch
---

Surface classifier reason in failure evidence so alerts stop lying about exit 0 (#915).

`CommandExitEvidence` gains an optional `reason?: string` field, populated from
`result.error.message` when the caller passes an explicit `classifier` argument to
`PhaseLoop.buildErrorEvidence`. On synthetic post-exit failures (product-diff guard,
no-progress guard, spawn-error catch, product-diff-error catch), the exit descriptor
is reworded from the bare `exit <N>` literal to
`failed post-exit: <classifier> (process exit <N>)` and the reason string appears
above the output tail in both the stage-comment evidence block and the
bottom-of-thread failure alert. Backticks are ZWSP-escaped and multi-line reasons
render as a fenced `text` block capped at 1 KiB with a `…` truncation marker.

Purely additive: process-failure callsites (`:294` pre-validate install, `:548`
post-phase process failure) pass `classifier: undefined`, so their evidence shape
and rendering are byte-identical to pre-#915. Pre-fix serialized `errorEvidence`
blobs deserialize unchanged (the new field is optional).
