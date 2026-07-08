# Quickstart: Thread-shaped review API fix (#861)

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## What this changes

Three consumers of PR review comments were reading `Comment.resolved`, a field that never exists on the REST payload. This PR:

1. Adds `getPRReviewThreads()` to `GitHubClient` (GraphQL-backed, returns `ReviewThread[]`).
2. Migrates `PrFeedbackMonitorService`, `preflight`, and `read-pr-feedback` to the new method.
3. Renames `preflight.unresolved_comments` → `unresolved_threads`.
4. Marks `getPRComments()` and `Comment.resolved` `@deprecated`.
5. Adds regression fixture + tests so this class of bug is caught next time.

## Files touched

| File | Change |
|---|---|
| `packages/workflow-engine/src/types/github.ts` | Add `ReviewThread`; deprecate `Comment.resolved`; rename `PreflightOutput.unresolved_comments` → `unresolved_threads`. |
| `packages/workflow-engine/src/actions/github/client/interface.ts` | Add `getPRReviewThreads` to `GitHubClient`; deprecate `getPRComments`. |
| `packages/workflow-engine/src/actions/github/client/gh-cli.ts` | Implement `getPRReviewThreads` via `gh api graphql`; widen `GhAuthError.statusCode` to `401 \| 403`. |
| `packages/workflow-engine/src/actions/github/preflight.ts` | Migrate to `getPRReviewThreads`; count unresolved threads; use renamed field. |
| `packages/workflow-engine/src/actions/github/read-pr-feedback.ts` | Migrate to `getPRReviewThreads`; filter by thread `isResolved`. |
| `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` | Migrate to `getPRReviewThreads`; state-transition info logging; 401/403 → auth-health. |
| `packages/orchestrator/src/services/__tests__/fixtures/pr-comments-rest.json` | NEW — captured sniplink#15 payload. |
| `packages/workflow-engine/tests/actions/github/read-pr-feedback.test.ts` | Update mocks to thread shape. |
| `packages/workflow-engine/tests/actions/github/preflight.test.ts` | Update mocks and assertions to `unresolved_threads`. |
| `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts` | Regression: fixture + state-transition + error-class matrix. |

## Development

```bash
pnpm install
pnpm --filter @generacy-ai/workflow-engine test
pnpm --filter @generacy-ai/orchestrator test
```

## Live repro (before the fix)

```bash
# Repo used for repro
GH_REPO=christrudelpw/sniplink

# Confirm no `resolved` field in REST payload (root cause):
gh api "/repos/${GH_REPO}/pulls/15/comments" | jq '.[0] | keys'
# → expected keys: id, body, user, path, line, in_reply_to_id, ...
#   NOT present: resolved  ← this is the bug

# Confirm resolution IS visible via GraphQL (fix path):
gh api graphql -f query='
query {
  repository(owner: "christrudelpw", name: "sniplink") {
    pullRequest(number: 15) {
      reviewThreads(first: 100) {
        nodes { isResolved comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}
' | jq '.data.repository.pullRequest.reviewThreads.nodes | map({rootCommentId: .comments.nodes[0].databaseId, isResolved})'
```

## Capturing the regression fixture

```bash
# One-time capture from the live payload:
gh api "/repos/christrudelpw/sniplink/pulls/15/comments" > /tmp/raw.json

# Trim bodies to placeholders (structure verbatim):
jq '{
  _meta: {
    source: "christrudelpw/sniplink PR #15",
    capturedAt: "2026-07-08",
    note: "REST payload. No resolved field present. See #861."
  },
  comments: [ .[] | .body = ("placeholder body " + (.id | tostring)) ]
}' /tmp/raw.json > packages/orchestrator/src/services/__tests__/fixtures/pr-comments-rest.json
```

**Do NOT add a `resolved` field.** The fixture's whole purpose is to catch tests that regress by re-encoding the bug. Add this comment near the fixture-load call site:

```typescript
// DO NOT add a `resolved` field to this fixture. The REST payload does not
// include one — that's the root cause of #861. Adding one to make a test
// green re-encodes the bug. Read via getPRReviewThreads() instead.
```

## Migration checklist

For each of the three consumers:

- [ ] Import `ReviewThread` from `../../types/github.js`.
- [ ] Replace `getPRComments(owner, repo, n)` with `getPRReviewThreads(owner, repo, n)`.
- [ ] Replace `c.resolved === false` predicates with `t.isResolved === false` (on threads).
- [ ] Where a flat comment list was consumed, derive: `threads.flatMap(t => t.comments)`.
- [ ] Where a count was consumed, use `threads.filter(t => !t.isResolved).length`.
- [ ] Wrap the call in a `try/catch` distinguishing `GhAuthError` (log `error`, call `authHealth.recordResult` if wired) from generic `Error` (log `warn` with `{ error, owner, repo, prNumber }`).

## Verification

```bash
# 1. Confirm zero in-repo readers of `unresolved_comments` remain
grep -RIn unresolved_comments packages/
# → expect: 0 hits (rename complete)

# 2. Confirm zero in-repo readers of `.resolved` on Comment remain
grep -RIn 'c\.resolved\|comment\.resolved' packages/
# → expect: 0 hits in src/, only tests that assert the deprecation

# 3. Confirm no getPRComments call sites remain (deprecation)
grep -RIn getPRComments packages/*/src
# → expect: 0 hits (only the deprecated declaration in interface.ts + gh-cli.ts)

# 4. Confirm the monitor emits info on state transitions only
pnpm --filter @generacy-ai/orchestrator test -- pr-feedback-monitor-service
```

## Troubleshooting

**Q: The monitor still logs `info` every poll**

State-transition tracking is process-local. On restart, the first poll of each PR is a bootstrap transition and fires `info` once. Subsequent identical polls should log at `debug`. If they don't, check that `lastUnresolvedThreadCount.set(key, current)` runs on every non-error path.

**Q: 401/403 GraphQL failures don't trigger `refresh-requested`**

Confirm the monitor is constructed with `authHealth: GitHubAuthHealthService` and `githubAppCredentialId: '<resolved id>'`. Both are wired in `server.ts` today and unchanged by this PR — the new call site inherits the existing plumbing. Check that `GhAuthError` is caught before the generic branch.

**Q: `getPRReviewThreads` returns fewer threads than the UI shows**

100-thread / 100-comment-per-thread pagination cap. Documented in contracts and research.md D10 as v1 out of scope. File a follow-up if observed in production.

**Q: A test fixture failed after "trimming bodies"**

Bodies are not asserted anywhere. If a test asserts on body content, either it should use inline literals (per Q5→C) or the fixture header should be updated to document the assertion. Do not fabricate `resolved: true/false` fields to make a test green.

## Next step

`/speckit:tasks` — generate ordered task list from this plan.
