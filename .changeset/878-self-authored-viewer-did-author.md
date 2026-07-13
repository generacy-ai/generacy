---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": minor
"@generacy-ai/generacy": minor
---

Replace `CLUSTER_ACTING_LOGIN` self-recognition with GraphQL `viewerDidAuthor` on the pr-feedback surface.

The pr-feedback trust predicate now recognizes cluster-authored comments via
GitHub GraphQL's `viewerDidAuthor` primitive instead of comparing normalized
author logins to a provisioned `CLUSTER_ACTING_LOGIN` value. `getPRReviewThreads()`
threads the field onto every `Comment` returned; decision 1.5 in
`isTrustedCommentAuthor()` fires on `comment.viewerDidAuthor === true`. All
`resolveActingIdentity()` / `normalizeLogin()`-based cluster-identity plumbing
(orchestrator + scaffolders) is removed.

**Breaking change (FR-004):** the `TrustReason` union entry `'cluster-identity'`
is renamed to `'self-authored'` on the pr-feedback surface. Hard rename with
no dual-emit; the string was two days old and preview-channel-only.

**Operator note (FR-005):** `CLUSTER_ACTING_LOGIN` is unused and safe to remove
from existing `.env` and `docker-compose.yml`. No auto-cleanup, no startup
compat log — a redeploy of the orchestrator image is the only action required
to gain the fix.
