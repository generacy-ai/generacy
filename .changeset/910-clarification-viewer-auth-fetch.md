---
"@generacy-ai/orchestrator": patch
"@generacy-ai/workflow-engine": patch
---

Fix App-identity clusters failing to self-recognize their own clarification
answer posts (#910). The answer-scanner (`integrateClarificationAnswers`) and
the clarify-resume context builder (`buildTrustedIssueCommentsBlock`) now fetch
issue comments through a new GraphQL client method
`getIssueCommentsWithViewerAuth()` instead of the REST `getIssueComments()`,
so each comment carries the `viewerDidAuthor` primitive keyed on the
authenticated App identity (stable across installation-token rotation). Both
call sites retry once on transient failure and fail closed on the second
failure — no REST fallback, which would silently reproduce the pre-fix defect.
The comment-trust helper's self-authored shape-drift warning is extended from
`pr-feedback` to a `MIGRATED_SURFACES` set (`pr-feedback`, `answer-scanner`,
`clarify-resume`), so a future caller that accidentally routes a migrated
surface through REST trips the wrong-method alarm instead of silently
rejecting the cluster's own comments at tier NONE.
