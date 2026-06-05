---
"@generacy-ai/orchestrator": minor
"@generacy-ai/workflow-engine": minor
---

feat: cluster-side backstop for expired/near-expiry GH_TOKEN (#762)

Detect an expired or near-expiry GitHub token and request a refresh instead of
silently 401-looping. `workflow-engine` now surfaces `GhAuthError` and
`parseGhStatusCode` so callers can distinguish auth failures, and the
`orchestrator` adds a credential-expiry watcher plus GitHub auth-health state
(exposed on the health route) so the label and PR-feedback monitors drive a
credential-refresh request rather than repeatedly failing on 401s.
