# Research: Thread-shaped review API fix (#861)

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Decision log

### D1 — Data source: GraphQL `pullRequest.reviewThreads`

**Decision**: Query GitHub's GraphQL API via `gh api graphql -f query='...'`.

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

**Rationale**: `isResolved` is a first-class property of `reviewThreads`, not comments. The REST endpoint at `/repos/{owner}/{repo}/pulls/{n}/comments` returns comments only — no resolution field exists. This is the root cause the spec calls out.

**Alternatives considered**:
- **Two-call join** (REST comments + GraphQL `reviewThreads` join by root comment ID): rejected — extra round trip; the GraphQL query already returns comments per thread.
- **`gh pr view --json reviewThreads`**: `gh` does not expose `reviewThreads` as a `--json` field on `pr view` as of gh 2.x. GraphQL query is required.

**Pagination note**: `first: 100` per thread and `first: 100` comments per thread. Any PR exceeding either limit will be visibly under-counted. Ship without pagination in v1 (matches today's REST call which is also unpaginated in `getPRComments`). Follow-up if a real PR hits it.

### D2 — Return shape: `ReviewThread { rootCommentId, isResolved, comments }`

**Decision**: Match clarifications Q1→C exactly.

```typescript
export interface ReviewThread {
  rootCommentId: number;   // databaseId of the first comment in the thread
  isResolved: boolean;
  comments: Comment[];     // all comments in the thread, in order
}
```

- `rootCommentId` is derived from the first comment's `databaseId` in the GraphQL response.
- `comments` preserves existing `Comment` fields (`id`, `body`, `author`, `path`, `line`, `in_reply_to_id`, `created_at`, `updated_at`, `authorAssociation`). `in_reply_to_id` populated from `replyTo.databaseId` (null → undefined).
- **`Comment.resolved` is left in the type but no consumer reads it after this PR.** Marking it `@deprecated` in JSDoc is enough for v1; deletion is a follow-up mechanical change (out of scope, per Q1→C's "removed from the type (breaking)" being a stronger stance than the plan needs). This keeps the diff strictly additive on the type side.

**Rationale**: Direct match for what the three consumers actually need. Monitor wants `{ isResolved, rootCommentId }`; preflight wants `isResolved` counts; read-pr-feedback wants `{ isResolved, comments }`.

### D3 — Deprecation of `getPRComments()`

**Decision**: Add `@deprecated` JSDoc + `TODO(#follow-up)` marker; keep the method callable. Migrate all three in-repo consumers in the same PR (no callers left after).

**Rationale**: Q1→C rules the migration is simultaneous. There are no in-repo readers after the migration (verified by grep). Leaving the method behind an `@deprecated` tag is a zero-risk safety net for any downstream that copies the workflow-engine package directly — the tag surfaces in IDEs. Removal is a mechanical cleanup PR once we've observed no adoption.

### D4 — Field rename: `preflight.unresolved_comments` → `unresolved_threads`

**Decision**: Rename in the same PR. Q2→C says fall back to option A (keep the name, change the semantics) only if a cross-repo reader turns up.

**Verification during plan**: `grep -r unresolved_comments packages/` returns exactly two hits, both in-package:
- `packages/workflow-engine/src/types/github.ts:265` (writer of the type)
- `packages/workflow-engine/src/actions/github/preflight.ts:255` (populator)

Zero readers outside these two files. Rename is safe. **No fallback needed.**

### D5 — GraphQL failure handling (scoped by class, Q3→B)

**Decision**:
| Failure class | Detection | Log level | Auth-health signal | Enqueue? |
|---|---|---|---|---|
| 401 (auth) | `parseGhStatusCode(stderr) === 401` | `error` | `authHealth.recordResult(credId, { ok: false, statusCode: 401 })` via existing `GhAuthError` | no |
| 403 (auth) | `parseGhStatusCode(stderr) === 403` | `error` | same as 401 (extend `GhAuthError` to accept 403 in addition to 401) | no |
| 5xx | `parseGhStatusCode(stderr) >= 500` | `warn` with `{ error, owner, repo, prNumber }` | no | no |
| rate-limit | `stderr` matches `/rate limit/i` OR `HTTP 429` | `warn` with same fields | no | no |
| Other | any non-zero `exitCode` not matching above | `warn` with same fields | no | no |

**Never fall back to REST.** The REST `resolved` field is always `undefined` — falling back reintroduces the bug.

**GhAuthError extension**: Today the error is typed `statusCode: 401`. Widen to `statusCode: 401 | 403` and update `executeGh`'s throw guard to trigger on both. The auth-health sink already treats both the same way in the monitor's catch branch.

**Rationale**: Consistent with the existing `#762` `GhAuthError` path used by the label/PR-feedback monitors. Transient failures rely on the next poll cycle (60s) to retry, which is aligned with today's REST failure-mode behavior. The clarification's explicit prohibition on Q3→C (silent REST fallback) is the anti-pattern this bug was.

### D6 — State-transition info logging (Q4→B)

**Decision**: `PrFeedbackMonitorService.pollPR()` (or equivalent) keeps a `Map<string, number>` in process memory: `${owner}/${repo}#${prNumber}` → last observed unresolved-thread count. On each poll:
- If the current count matches the last-seen and both are non-zero: `debug` (no state change).
- If the current count is zero and last-seen was zero: `debug` (steady-state zero).
- If the count transitions (unresolved→zero, zero→unresolved, N→M where N≠M): `info` with `{ totalComments, unresolvedThreads, previousUnresolvedThreads, owner, repo, prNumber }`.
- Bootstrap case (first observation of a PR): treat as a transition — fires once at `info`, subsequent identical polls at `debug`.

**Rationale**: Q4→B avoids 1,440 identical info lines/day/PR. Process-local memory is sufficient — restarts fire one extra info line per PR (bootstrap case), which is acceptable telemetry noise, not a correctness issue.

**Storage**: Plain in-memory `Map` scoped to the `PrFeedbackMonitorService` instance. Not persisted. Not shared with other processes. Not evicted (PR count is bounded by open-PR count on monitored repos; leak surface is negligible).

### D7 — Regression fixture (Q5→C)

**Decision**: Two-tier fixture strategy:

1. **Monitor regression test** (`pr-feedback-monitor-service.test.ts`): loads a checked-in JSON file at `packages/orchestrator/src/services/__tests__/fixtures/pr-comments-rest.json` captured from the live `christrudelpw/sniplink#15` payload. Header comment (JSON pointer — first `//` line if TS-based, or a `_meta` key if pure JSON) notes source PR + capture date. Comment bodies trimmed to `"placeholder body 1"`, `"placeholder body 2"`, etc. Structure verbatim (all REST fields present, no fabricated fields; explicitly no `resolved` field).
   - Purpose: prove that a real REST payload with no `resolved` field can no longer silently no-op the monitor. Test mocks the GraphQL call to return `[]` unresolved threads, asserts monitor does not enqueue; then mocks GraphQL to return N unresolved threads, asserts monitor enqueues with the correct `reviewThreadIds`.
   - Anti-pattern guard: the fixture explicitly omits `resolved`. If a future test adds it back, that's the same "tests encode the code's assumptions" bug (#800, #826, #836, #853, #855) — the test file gets a `// DO NOT ADD resolved FIELD — see #861` comment at the fixture load site.

2. **Preflight + read-pr-feedback unit tests**: inline object literals in the test file. No shared fixture. Concise, per-case explicit. These tests target `GhCliClient.getPRReviewThreads()` mock returns (thread-shaped input), not the REST payload — so the "no `resolved` field" concern doesn't apply.

**Rationale**: Q5→C. The monitor is the site where the bug hid for two review rounds; a live-payload fixture is the audit trail. The two other consumers have simpler surfaces and inline literals stay readable.

**JSON `_meta` key sketch**:
```json
{
  "_meta": {
    "source": "christrudelpw/sniplink PR #15",
    "capturedAt": "2026-07-08",
    "note": "REST payload from /repos/christrudelpw/sniplink/pulls/15/comments. Bodies trimmed to placeholders. No `resolved` field present — that field does not exist in the REST response. See #861."
  },
  "comments": [ ... verbatim REST shape, bodies replaced ... ]
}
```

### D8 — Test coverage matrix

| Site | Test file | Scenario | Assertion |
|---|---|---|---|
| Monitor | `pr-feedback-monitor-service.test.ts` | Fixture load (REST-shape input, GraphQL mock returns 0 threads) | No enqueue, no info log if bootstrapped, `debug` on steady-state |
| Monitor | " | GraphQL mock returns N unresolved threads | Enqueue with `reviewThreadIds = [rootCommentId, …]`, `info` on transition |
| Monitor | " | GraphQL mock throws `GhAuthError(401)` | `error` log; `authHealth.recordResult(credId, { ok: false, statusCode: 401 })`; no enqueue |
| Monitor | " | GraphQL mock throws `GhAuthError(403)` | Same as 401 path |
| Monitor | " | GraphQL mock throws generic 5xx | `warn` log with `{ error, owner, repo, prNumber }`; no auth-health call; no enqueue |
| Monitor | " | Steady-state zero on second consecutive poll | `debug` (not `info`) |
| Monitor | " | Count change N → M (both non-zero) | `info` with `{ previousUnresolvedThreads: N, unresolvedThreads: M }` |
| Preflight | `preflight.test.ts` | `getPRReviewThreads` returns mixed resolved/unresolved | `unresolved_threads = <unresolved count>` |
| Preflight | " | No PR number | `unresolved_threads = 0` |
| Preflight | " | GraphQL throws | Preserves today's swallow-and-zero behavior (`preflight.ts:214` `catch` block) — no field on the output implies zero |
| read-pr-feedback | `read-pr-feedback.test.ts` | `include_resolved = false` | Only comments from unresolved threads returned; `has_unresolved`, `unresolved_count` reflect thread count |
| read-pr-feedback | " | `include_resolved = true` | All comments returned; `unresolved_count` still = unresolved thread count |
| GhCliClient | new `gh-cli.review-threads.test.ts` | GraphQL response parsing | Returns `ReviewThread[]` with correct `rootCommentId` / `isResolved` / `comments` |
| GhCliClient | " | GraphQL response with empty `reviewThreads` | Returns `[]` |
| GhCliClient | " | Non-zero exit + 401 | Throws `GhAuthError(401, stderr)` |
| GhCliClient | " | Non-zero exit + 403 | Throws `GhAuthError(403, stderr)` |
| GhCliClient | " | Non-zero exit + 5xx | Throws generic `Error` (caller decides log level) |

### D9 — Existing callers of `Comment.resolved`

Full grep audit before merge:

```
packages/workflow-engine/src/actions/github/preflight.ts:213     # migrated
packages/workflow-engine/src/actions/github/read-pr-feedback.ts:59,90   # migrated
packages/orchestrator/src/services/pr-feedback-monitor-service.ts:166   # migrated
packages/workflow-engine/src/types/github.ts:82                  # field left @deprecated
tests/*.ts                                                        # updated to thread shape
specs/…                                                           # historical, no action
```

**Zero remaining production readers of `Comment.resolved` after this PR.** Type field kept for one release cycle behind `@deprecated`.

### D10 — What's explicitly out of scope

- Deleting `Comment.resolved` from the type (follow-up PR — see D2).
- Deleting `getPRComments()` (follow-up PR — see D3).
- Pagination beyond 100 threads / 100 comments per thread (see D1 note).
- Rewriting `#842`'s comment-trust gating (still runs downstream of the migrated read).
- Changing the poll cadence (~60s).
- Adding a metric for `unresolved_threads` count (not requested in spec).

## Key references

- Spec: `specs/861-found-during-cockpit-v1/spec.md`
- Clarifications: `specs/861-found-during-cockpit-v1/clarifications.md`
- GhAuthError + status parsing: `packages/workflow-engine/src/actions/github/client/gh-cli.ts:28-93`
- Existing monitor 401 wiring: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:47-73,330-347,396-398`
- `#762` `GitHubAuthHealthService`: `packages/orchestrator/src/services/github-auth-health.ts`
- Anti-pattern lineage: `#800`, `#826`, `#836`, `#853`, `#855` (tests encoding the code's assumptions)
- Live repro: `christrudelpw/sniplink` PR #15
- Discovery: `generacy-ai/tetrad-development#88`, finding #26
