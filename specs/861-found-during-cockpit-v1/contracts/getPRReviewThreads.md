# Contract: `GitHubClient.getPRReviewThreads`

**Package**: `@generacy-ai/workflow-engine`
**File**: `packages/workflow-engine/src/actions/github/client/interface.ts` (declaration), `gh-cli.ts` (impl)
**Feature**: #861

## Signature

```typescript
getPRReviewThreads(
  owner: string,
  repo: string,
  number: number,
): Promise<ReviewThread[]>
```

## Behavior

Fetch all review threads on the specified PR via a single GraphQL call. Returns thread-shaped data suitable for driving `PrFeedbackMonitorService` enqueue decisions, `preflight` output, and `read-pr-feedback` filtering.

## Underlying GraphQL query

```graphql
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 100) {
            nodes {
              databaseId
              body
              path
              line
              createdAt
              updatedAt
              author { login }
              authorAssociation
              replyTo { databaseId }
            }
          }
        }
      }
    }
  }
}
```

Invocation:
```bash
gh api graphql \
  -f query='...above...' \
  -F owner="$OWNER" -F repo="$REPO" -F number="$PR_NUMBER"
```

Env: `GH_TOKEN` provided by existing `executeGh` (from `tokenProvider` or ambient auth).

## Response mapping

For each `reviewThreads.nodes[i]`:
- `rootCommentId` ← `comments.nodes[0].databaseId`
- `isResolved` ← `isResolved`
- `comments` ← `comments.nodes[]` mapped to `Comment` type:
  - `id` ← `databaseId`
  - `body` ← `body`
  - `author` ← `author.login`
  - `authorAssociation` ← `authorAssociation` (upper-case string; preserved verbatim)
  - `path` ← `path` (undefined if null)
  - `line` ← `line` (undefined if null)
  - `in_reply_to_id` ← `replyTo.databaseId` (undefined if null)
  - `created_at` ← `createdAt`
  - `updated_at` ← `updatedAt`
  - `resolved` ← **NOT SET** (do not populate; the field is deprecated)

## Return values

| Situation | Return |
|---|---|
| PR has no review threads | `[]` |
| PR has N threads, all resolved | N-element array, all `isResolved: true` |
| PR has N threads, all unresolved | N-element array, all `isResolved: false` |
| PR does not exist | throws `Error` (from gh non-zero exit) |
| PR exists but no comments | `[]` |
| Repo not accessible (403) | throws `GhAuthError(403, stderr)` |
| Token missing/expired (401) | throws `GhAuthError(401, stderr)` |
| Transient 5xx | throws generic `Error` (caller decides) |
| Rate limit | throws generic `Error` (caller logs `warn`) |

## Error handling contract

- **`GhAuthError` (401 or 403)** — caller (monitor) MUST log at `error` and MUST call `authHealth.recordResult(credentialId, { ok: false, statusCode })`. Existing `#762` wiring at `pr-feedback-monitor-service.ts:347,397` already handles this pattern for other 401 sites; extend to include the new call site.
- **Other errors** — caller MUST log at `warn` with `{ error, owner, repo, prNumber }`. MUST NOT fall back to `getPRComments()`. MUST NOT enqueue.
- **Empty array** — NOT an error. Steady-state polling behavior applies (see monitor-decision.md).

## Pagination

Bounded at **100 threads × 100 comments per thread** in v1. Any PR exceeding either boundary is under-counted. This matches (and does not worsen) today's `getPRComments()` behavior, which is also unpaginated. Follow-up if a real PR is observed hitting the limit.

## Backwards compat

- `getPRComments()` remains callable (marked `@deprecated`) — external consumers that copy the package may still have call sites.
- `Comment.resolved` remains in the type as `@deprecated` — deletion is a follow-up mechanical PR.
- No new required constructor parameters on `GhCliClient`.

## Test coverage (see research.md D8)

- Response with mixed resolved/unresolved threads → correct `ReviewThread[]` mapping.
- Empty `reviewThreads.nodes` → `[]`.
- 401 non-zero exit → `GhAuthError(401, stderr)`.
- 403 non-zero exit → `GhAuthError(403, stderr)`.
- 5xx non-zero exit → generic `Error`.
- Thread with `replyTo: null` on root → `in_reply_to_id` undefined.
- Thread with `replyTo: { databaseId: N }` on non-root → `in_reply_to_id === N`.
