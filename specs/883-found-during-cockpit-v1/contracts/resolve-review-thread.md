# Contract: `GitHubClient.resolveReviewThread`

## Interface

```ts
interface GitHubClient {
  // ... existing methods
  resolveReviewThread(threadId: string): Promise<void>;
}
```

## Semantics

- **Purpose:** Resolve a PR review thread via the GitHub GraphQL `resolveReviewThread` mutation, absorbing transient network / secondary-rate-limit / 5xx failures with bounded synchronous retries.
- **Success:** Resolves without throwing. The underlying thread is marked resolved on GitHub.
- **Retry policy (spec Q1-C):** Up to 3 attempts total. Backoff between attempts is 1s → 2s → 4s. Max wall time per call: ~7s + upstream latency.
- **Auth failures (`GhAuthError`)** — thrown immediately, never retried. Aligns with #762 convention (auth failures are terminal and observed by the auth-health service).
- **Post-retry failure:** Throws `Error` with the last upstream stderr as the message. Caller is responsible for translating this into an FR-010 per-thread warn.

## Wire shape

```
gh api graphql \
  -f query='mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }' \
  -F id=<threadId>
```

## Error taxonomy

| Class | Detection | Retry? | Handler outcome |
|---|---|---|---|
| Transient (network, 5xx, secondary rate limit) | non-401 non-auth `executeGh` non-zero exit | Yes (up to 3) | Success if any attempt succeeds; else throws after final attempt |
| Auth (401) | `GhAuthError` from `executeGh` | No | Rethrows immediately (auth-health picks it up) |
| Node-not-found (deleted thread) | GraphQL 200 with `errors[]` entry | No (per Q1 tail — not transient) | Throws after first attempt |
| Permission denied | 403 with a non-auth message | No | Throws after first attempt |

Retry decision is made purely on `executeGh` return code + auth-class exception. GraphQL-level `errors[]` on a 200 response is treated as terminal (deleted / permissioned).

## Test surface

Vitest unit tests colocated with `gh-cli.ts`:

- **Happy path** — one call, one success. Assert wire args match the expected `gh api graphql` invocation.
- **Transient retry** — mock `executeGh` to fail 2× then succeed. Assert 3 calls made, ~3s elapsed.
- **Persistent transient** — mock `executeGh` to fail 3×. Assert 3 calls, throws, message includes last stderr.
- **Auth passthrough** — mock `executeGh` to throw `GhAuthError`. Assert 1 call, `GhAuthError` propagates, no retry.
- **GraphQL-level error** — mock 200 response with `errors: [{ message: 'Could not resolve to a node' }]`. Assert 1 call, throws.

## Non-goals

- **Rate-limit-aware backoff** (`Retry-After` header parsing): out of scope. Fixed 1s/2s/4s covers the observed transient class.
- **Batch mutation**: `resolveReviewThread` is single-threadId in GraphQL. Batching means concurrent calls, not fewer HTTP requests. The handler's per-thread loop is already the natural batch shape.
- **Optimistic caching**: the handler does not read `isResolved` after mutation; it counts successes and refetches on the next monitor cycle.
