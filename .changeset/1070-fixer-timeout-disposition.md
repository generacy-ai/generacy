---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
"@generacy-ai/cockpit": patch
---

Split PR-feedback CLI-timeout disposition off `blocked:stuck-feedback-loop` and allow up to two bounded auto-retries per trigger (#1070). Three new label vocabulary entries in `@generacy-ai/workflow-engine`: `blocked:fixer-timeout` (retry-eligible, monitor auto-dispatches on next poll), `blocked:fixer-timeout-no-progress` (terminal — CLI timed out with zero commits), `blocked:fixer-timeout-repeat` (terminal — auto-retry budget of 2 exhausted). Orchestrator's `PrFeedbackHandler` collapsed `!success || !hasChanges` branch is split into an explicit four-way switch and the historically contradictory `msg: "Successfully pushed changes" success: false` log line is fixed. Retry counter lives on the monitor (`PrFeedbackMonitorService.fixerTimeoutRetryCount`) and travels handler-ward via a new optional `retryAttempt?: number` field on `PrFeedbackMetadata`; resets only when all review threads are fully resolved (Case C). Cockpit `WAITING_PIPELINE_ORDER` gains the two terminal `blocked:fixer-timeout-*` labels ahead of `waiting-for:address-pr-feedback` (mirrors the `blocked:stuck-feedback-loop` precedence), while the retry-eligible `blocked:fixer-timeout` intentionally sorts below the active waiting gate.
