---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
"@generacy-ai/cockpit": patch
---

PR-feedback monitor: exclude engine review threads, route external feedback into the remediate loop

- `PrFeedbackMonitorService` now excludes engine-authored review threads from the trigger, so the engine's own review comments no longer re-enqueue the fixer.
- Trusted external PR feedback (inline threads + review bodies) is seeded into the shared `review`/`remediate` phase loop instead of the legacy fixer, and converges through the `on-remediation-limit` gate.
- Retires the `blocked:stuck-feedback-loop` dead-end label: exhaustion now lands on `waiting-for:remediation-limit`. The label is removed from the `workflow-engine` vocabulary and from cockpit's classification/precedence tables.
