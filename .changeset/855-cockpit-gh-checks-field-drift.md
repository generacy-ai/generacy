---
"@generacy-ai/generacy": patch
"@generacy-ai/cockpit": patch
---

Fix `gh pr checks` requesting nonexistent JSON fields, hard-failing merge and silently blanking every checks surface (#855).

The gh wrapper's `getPullRequestCheckRuns` requested `--json name,state,conclusion,detailsUrl`, but `conclusion` and `detailsUrl` have never existed on `gh pr checks` (it exposes `bucket`/`link`, not the `gh run` REST vocabulary). gh validates the field list client-side before any network call, so the method failed on every invocation — hard-failing `cockpit merge` and silently degrading `status`/`watch`/`context` checks rollups to blank. The field list is now `name,state,bucket,link`, `CheckRunSummary` drops the unused `conclusion` field (threaded through `review-context-json`), the swallowed wrapper error now emits a `warn` log, and the `resolveIssueToPr` query drops its unused `timelineItems` selection. A CI-tier drift test runs the real pinned gh binary against every `--json` field list the wrapper uses to catch this class of gh-interface drift that mocked fixtures cannot.
