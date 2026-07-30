---
"@generacy-ai/orchestrator": patch
---

Widen the PR-feedback orchestration guard so reviews on completed workflows still enqueue (`agent:*` / `workflow:*` / `completed:*` are all evidence), lift drop-gate log lines to `info` when the PR has unresolved threads (with a named `gate:` field), and add a merged-PR gate so reviews on merged PRs never reach the checkout path. Fixes #1049.
