---
"@generacy-ai/orchestrator": minor
"@generacy-ai/workflow-engine": minor
---

fix: assert a product diff before a phase requiring changes can pass (#820)

An implement phase that produced no product code — only `specs/` artifacts —
previously passed validate and merged silently. The worker now computes the
product diff for phases that require changes (`git diff --name-only base...HEAD`,
excluding the `specs/` path prefix) and fails the phase when no product files
changed.

Adds `GitHubClient.getFilesChangedBetween(base, head)` (merge-base/triple-dot
semantics) to `@generacy-ai/workflow-engine` and its gh-cli implementation, plus
the `product-diff` helper and `PrManager.getPrNumber()` in
`@generacy-ai/orchestrator`.
