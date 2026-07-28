# Contract: FR-005 dispatch-time closed-issue gate

## Insertion point

`packages/orchestrator/src/services/label-monitor-service.ts::processLabelEvent()`.

Currently the method (line-numbers per current source):

1. Logs the incoming event (`:283-286`).
2. Runs process-only dedup via `phaseTracker` (`:294-306`).
3. Resolves `workflowName` (`:310-319`).
4. Fetches issue via `createClient(...).getIssue(owner, repo, issueNumber)` — stored in `fetchedIssue` (`:322-333`).
5. Builds and enqueues the `QueueItem`.

**New gate**: insert immediately **after** step 4 (issue fetched, `fetchedIssue` populated), **before** step 5 (queue-item build).

## Behavior

```ts
if (fetchedIssue && fetchedIssue.state === 'closed') {
  this.logger.info(
    {
      dropped: 'issue-closed',
      issueNumber,
      eventType: type,           // 'process' | 'resume'
      phase: parsedName,         // process:<phase> / waiting-for:<gate>-derived
      owner,
      repo,
    },
    'Dropping label event: issue is closed',
  );
  return false;
}
```

Applies to **both** `type === 'process'` and `type === 'resume'` (Q1 clarification).

## Fallback for the failed-fetch case

If `fetchedIssue` is `null` (the `try/catch` at `:324-333` swallowed a fetch error and left `fetchedIssue = null`), the gate does NOT fire — the existing fallback description is used and the event flows to enqueue. Rationale: better to enqueue a possibly-closed issue than to drop a definitely-open one on a transient `gh` failure. The pre-push guard (FR-002) will catch the closed case downstream if needed. Do NOT add a retry loop for the state fetch — the fetch is already best-effort at this call site.

## Mutation invariant

On drop, the following calls MUST NOT be issued:

- `queueManager.enqueue(...)` / `queueManager.enqueueIfAbsent(...)`
- `phaseTracker.markProcessed(...)`
- `client.removeLabels(...)` / `client.addLabels(...)` (dispatch-time label mutation at `:398-399`)

The drop is silent from a mutation standpoint. `SC-004` explicitly asserts this.

## Log invariant

Exactly one `info` log line per drop, with structured field `dropped: 'issue-closed'` and the four required fields (`issueNumber`, `eventType`, `phase`, plus `owner`/`repo` for consistency with sibling log sites). Log level is `info`, NOT `warn` — a drop here is expected steady-state behavior (Q1 rationale rejecting Option C).

## Test surface

Cases the new `label-monitor-service.closed-issue.test.ts` MUST cover:

- `type: 'process'` + `issue.state === 'closed'` → drop; log fires with `eventType: 'process'`; zero mutations.
- `type: 'resume'` + `issue.state === 'closed'` → drop; log fires with `eventType: 'resume'`; zero mutations.
- `type: 'process'` + `issue.state === 'open'` → proceed to enqueue (no drop log).
- `type: 'resume'` + `issue.state === 'open'` → proceed to enqueue (no drop log).
- `github.getIssue` throws → `fetchedIssue` is `null`, event proceeds to enqueue (no drop, no crash).
