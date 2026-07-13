---
"@generacy-ai/orchestrator": patch
---

Fix phase-failure evidence being invisible because it was rendered as an in-place edit to an hours-old stage comment (#865).

The #847 failure-evidence block worked but nobody saw it: `StageCommentManager`
rendered it by editing the existing stage comment in place — a comment posted when
the workflow started, mid-thread — which generates no GitHub notification and no
new activity at the bottom of the thread. On failure the orchestrator now also
posts a fresh alert comment at the end of the thread so watchers are actually
notified, rather than relying solely on the buried in-place edit.
