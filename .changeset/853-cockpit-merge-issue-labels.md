---
"@generacy-ai/generacy": patch
"@generacy-ai/cockpit": patch
---

Fix `cockpit merge` checking `completed:validate` on the PR instead of the issue (#853).

Workflow protocol labels (`waiting-for:*`, `completed:*`) live on the issue,
not the PR, so `cockpit merge` could never observe `completed:validate` and
merge always failed. `runMerge` now reads the label from the issue's
`IssueStateResult.labels`. The gh wrapper's issue-state query additionally
surfaces `stateReason` (added to `IssueStateResult` and the `gh issue view`
`--json` field set) so merge can reason about how an issue was closed.
