---
"@generacy-ai/workflow-engine": patch
"@generacy-ai/orchestrator": patch
---

Fix the PR feedback loop never firing because `Comment.resolved` was never populated (#861).

Thread resolution is a GraphQL-only concept — the REST endpoint underlying
`getPRComments()` never exposed it, so `Comment.resolved` was always `undefined`
and the preflight / read-pr-feedback / orchestrator feedback loop treated every
thread as unresolved (or silently skipped it). Adds `getPRReviewThreads()`, which
fetches review threads with their `isResolved` state via GraphQL, and rewires
`preflight`, `read-pr-feedback`, and the orchestrator PR-feedback handler to use
it. `getPRComments()` and `Comment.resolved` are deprecated and slated for removal.
