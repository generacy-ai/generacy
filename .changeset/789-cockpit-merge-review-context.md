---
"@generacy-ai/generacy": minor
"@generacy-ai/cockpit": minor
---

Add `generacy cockpit merge` and `cockpit review-context` verbs (#789).

`merge` resolves an issue to its PR and squash-merges once the required checks
are green and the `completed:validate` gate is present; `review-context` gathers
JSON context (PR detail + diff + failing checks) for a review. The foundation
`@generacy-ai/cockpit` gh wrapper gains `resolveIssueToPRRef`,
`getPullRequestDetail`, `mergePullRequest`, and `getRequiredCheckNames` (plus the
`PullRequestRef`, `PullRequestDetail`, `MergeResult`, and `RequiredChecksResult`
types). The richer PR-resolution verbs use distinct method names so they coexist
with the watcher's lightweight `resolveIssueToPR`/`getPullRequest`.
