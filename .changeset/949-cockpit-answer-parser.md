---
"@generacy-ai/orchestrator": patch
---

Widen `parseAnswersFromComments` to accept the cockpit `### Q<n>` + `**Answer:** value` dialect, so the deterministic backstop parser stops silently returning `no-answers` on every cockpit-posted clarification comment.
