---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
"@generacy-ai/cockpit": patch
---

PR-feedback monitor: exclude engine review threads, route external feedback into the remediate loop

- `PrFeedbackMonitorService` now excludes engine-authored review threads from the trigger, so the engine's own review comments no longer re-enqueue the fixer.
- When the review phase is enabled, trusted external PR feedback (inline threads + review bodies) is seeded into the shared `review`/`remediate` phase loop instead of the legacy fixer, and converges through the `on-remediation-limit` gate (`waiting-for:remediation-limit`).
- The legacy (review-phase-disabled, default) fixer keeps its own bounded stop: a no-diff / push-failed cycle still applies `blocked:stuck-feedback-loop` so the monitor pauses re-enqueue until an operator clears it. Each path has a distinct bounded stop — the flag-ON path uses the `remediation-limit` gate, the flag-OFF path uses `blocked:stuck-feedback-loop`.
