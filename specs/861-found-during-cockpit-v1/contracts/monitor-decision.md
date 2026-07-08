# Contract: `PrFeedbackMonitorService` enqueue decision

**Package**: `@generacy-ai/orchestrator`
**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
**Feature**: #861

## Decision inputs

Per polled PR (each ~60s cycle):
1. Assignee gate (unchanged from today) — must be assigned to this cluster.
2. `threads = await client.getPRReviewThreads(owner, repo, prNumber)`.
3. `unresolvedThreads = threads.filter(t => !t.isResolved)`.
4. Dedup gate (unchanged) — `phaseTracker.tryMarkProcessed(owner, repo, issueNumber, DEDUP_PHASE)`.

## Decision table

| `getPRReviewThreads` outcome | `unresolvedThreads.length` | Action | Log |
|---|---|---|---|
| `[]` (no threads at all) | 0 | Skip (no enqueue) | `debug` (steady-state) OR `info` (transition — see logging) |
| N threads, all resolved | 0 | Skip | same as above |
| N threads, M unresolved (M > 0) | M | Enqueue with `reviewThreadIds = unresolvedThreads.map(t => t.rootCommentId)` | `info` `Found M unresolved review thread(s)` (unchanged from today) |
| Throws `GhAuthError(401 \| 403)` | — | Skip | `error` + `authHealth.recordResult(credId, { ok: false, statusCode })` |
| Throws generic `Error` (5xx, rate-limit, other) | — | Skip | `warn` with `{ error, owner, repo, prNumber }` |

## State-transition info logging (Q4→B, D6)

In-process state:
```typescript
private lastUnresolvedThreadCount: Map<string /* `${owner}/${repo}#${prNumber}` */, number>;
```

For the zero-unresolved skip case (rows 1–2 above), determine log level:

```typescript
const key = `${owner}/${repo}#${prNumber}`;
const previous = this.lastUnresolvedThreadCount.get(key);
const current = unresolvedThreads.length;   // 0 in this branch

const isTransition = previous === undefined || previous !== current;
const level = isTransition ? 'info' : 'debug';
this.logger[level](
  { owner, repo, prNumber, issueNumber, totalThreads: threads.length, unresolvedThreads: current, previousUnresolvedThreads: previous ?? null },
  isTransition ? 'No unresolved review threads (state change)' : 'No unresolved review threads — skipping',
);
this.lastUnresolvedThreadCount.set(key, current);
```

For the enqueue case (row 3), `info` fires unconditionally (matches today's behavior). Also update `lastUnresolvedThreadCount` after enqueue.

For error cases (rows 4–5), do NOT update `lastUnresolvedThreadCount` — an errored poll should not mask a real state transition on the next successful poll.

## `#762` auth-health integration

The auth-shaped-error path MUST invoke the existing `AuthHealthSink`. Snippet:

```typescript
try {
  const threads = await client.getPRReviewThreads(owner, repo, prNumber);
  // ... success path ...
  if (this.githubAppCredentialId) {
    this.authHealth.recordResult(this.githubAppCredentialId, { ok: true });
  }
} catch (error) {
  if (error instanceof GhAuthError) {
    if (this.githubAppCredentialId) {
      this.authHealth.recordResult(
        this.githubAppCredentialId,
        { ok: false, statusCode: error.statusCode },
      );
    }
    this.logger.error(
      { err: error, owner, repo, prNumber, statusCode: error.statusCode },
      'GraphQL review-threads call failed (auth)',
    );
    return false;
  }
  this.logger.warn(
    { error: error instanceof Error ? error.message : String(error), owner, repo, prNumber },
    'GraphQL review-threads call failed (transient)',
  );
  return false;
}
```

Matches the pattern already in use at `pr-feedback-monitor-service.ts:330-347,396-398` — this is not new machinery, just a new call site subscribing to it.

## Non-changes

- Poll cadence: unchanged (~60s).
- Dedup key: unchanged (`waiting-for:address-pr-feedback` phase).
- Queue payload shape: `reviewThreadIds` field name preserved; only the values change from REST comment IDs (always-populated) to GraphQL root-comment `databaseId`s (equivalent surface — both are `number` PR-review-comment IDs from the GitHub perspective, just fetched via a different path).
- Assignee gating: unchanged.
- Cluster username gating: unchanged.

## Test scenarios (see research.md D8)

Beyond the mapping tests already listed, monitor-specific tests to add:

- **Regression via fixture**: load `pr-comments-rest.json`, assert monitor never reads `.resolved` and never enqueues on that path (the REST payload is a decoy — the test proves the new GraphQL path is what drives behavior).
- **Bootstrap transition**: first poll of a PR with 0 unresolved threads fires `info` once.
- **Steady-state zero**: second consecutive poll of the same PR at 0 fires `debug`.
- **Unresolved→zero**: PR had N > 0 last cycle, has 0 this cycle → `info`.
- **Zero→unresolved**: 0 last cycle, N > 0 this cycle → enqueue + `info` (enqueue path already logs `info`).
- **Count change N → M (both > 0)**: enqueue + `info` (enqueue path).
- **401 error**: `error` log + `authHealth.recordResult(credId, { ok: false, statusCode: 401 })` + no state update.
- **403 error**: same as 401.
- **5xx error**: `warn` log with structured fields, no auth-health call, no state update.
