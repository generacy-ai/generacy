# Contract: `listReviews` response shape

**Feature**: #1047
**Consumer**: `packages/orchestrator/src/worker/pr-feedback-handler.ts`
**Producer**: `packages/workflow-engine/src/actions/github/client/gh-cli.ts` → wraps `gh api /repos/{owner}/{repo}/pulls/{n}/reviews`

## Method signature

```typescript
interface GitHubClient {
  listReviews(owner: string, repo: string, prNumber: number): Promise<Review[]>;
}
```

## Wire response (GitHub REST)

`GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews` returns an array. Each element:

```json
{
  "id": 123456789,
  "node_id": "PRR_kwDO...",
  "user": {
    "login": "reviewer-username",
    "id": 12345,
    "type": "User"
  },
  "body": "review body text",
  "state": "COMMENTED",
  "submitted_at": "2026-07-26T10:00:00Z",
  "commit_id": "abc123...",
  "html_url": "https://github.com/owner/repo/pull/N#pullrequestreview-123456789"
}
```

## Producer transform

`gh-cli.ts` implementation MUST:

- Call `gh api "/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100"` and paginate on the `link` header. Realistic PR review counts stay ≤ 100 in practice; pagination is defensive.
- Map wire → `Review` type:
  - `id` → `id`
  - `user.login` → `user.login`
  - `body` → `body` (default `''` if wire returns `null`)
  - `state` → `state` (assert one of the enum values; unknown value → throw)
  - `submitted_at` → `submittedAt`
- Drop `node_id`, `user.id`, `user.type`, `commit_id`, `html_url` (not consumed).
- On HTTP 401/403 from `gh api`, throw `GhAuthError` (matches existing pattern in `getPRReviewThreads`).
- On any other non-zero exit, throw `Error` with the stderr message.

## Consumer contract

`pr-feedback-handler.ts` MUST:

- Call `github.listReviews(owner, repo, prNumber)` once per cycle, adjacent to the existing `getPRReviewThreads` call.
- Filter to `review.state === 'CHANGES_REQUESTED' || review.state === 'COMMENTED'`.
- Filter to `review.body.trim().length > 0`.
- Wrap in `try/catch` mirroring the thread-fetch block at handler.ts:229-235; on failure, log warn and continue with reviews `[]` (do not abort the cycle — the thread path is independent).

## Failure modes

| Failure | Producer behavior | Consumer behavior |
|---------|-------------------|-------------------|
| HTTP 401/403 | throw `GhAuthError` | log error, abort cycle (auth is broken; other paths would also fail) |
| Transient network failure | throw `Error` | log warn, treat reviews as `[]`, continue with thread-only path |
| Unknown `state` value | throw `Error` | log warn, treat reviews as `[]`, continue with thread-only path |
| Empty response array | return `[]` | treat as no bodies to consume |
| PR does not exist | throw `Error` | already handled upstream — the PR was fetched at handler.ts:118 |

## Non-goals

- No caching. Each cycle fetches fresh.
- No pagination beyond `per_page=100` follow-through. If a PR ever has > 100 reviews, that's a separate systemic concern.
- No writing. This is read-only.
