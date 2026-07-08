# Contract: `LabelMonitorService.processLabelEvent` — resume branch

## Signature

Unchanged: `async processLabelEvent(event: LabelEvent): Promise<boolean>`.

Return value semantics preserved: `true` if the event resulted in an enqueue, `false` if dropped (duplicate / already in flight / failed).

## Constructor change

`queueAdapter` parameter widens from `QueueAdapter` to `QueueManager` (already the concrete type passed by `server.ts:372`). This exposes `enqueueIfAbsent` to the service without a new adapter injection.

```ts
constructor(
  logger: Logger,
  createClient: GitHubClientFactory,
  phaseTracker: PhaseTracker,
  queueManager: QueueManager,        // <-- widened from QueueAdapter
  config: MonitorConfig,
  repositories: RepositoryConfig[],
  clusterGithubUsername?: string,
  tokenProvider?: () => Promise<string | undefined>,
  authHealth?: AuthHealthSink,
  githubAppCredentialId?: string,
) { ... }
```

## Behavior — `type === 'resume'` branch (rewritten)

Current flow (label-monitor-service.ts:264–372, resume subset):

```ts
const dedupPhase = `resume:${parsedName}`;
const isDuplicate = await this.phaseTracker.isDuplicate(owner, repo, issueNumber, dedupPhase);
if (isDuplicate) { log 'Skipping duplicate event'; return false; }
// ... resolve workflow, fetch issue, build queueItem ...
await this.queueAdapter.enqueue(queueItem);
await this.phaseTracker.markProcessed(owner, repo, issueNumber, dedupPhase);
```

New flow:

```ts
// (No phaseTracker.isDuplicate / markProcessed for resume events.)
// ... resolve workflow, fetch issue, build queueItem ...
const enqueued = await this.queueManager.enqueueIfAbsent(queueItem);
if (!enqueued) {
  this.logger.info(
    {
      itemKey: `${owner}/${repo}#${issueNumber}`,
      gate: parsedName,
      reason: 'in-flight',
      source,
      owner, repo, issueNumber,
    },
    'Dropping resume event (item already in flight)',
  );
  return false;
}
this.logger.info(
  { owner, repo, issueNumber, command: queueItem.command, workflowName },
  'Issue enqueued (resume)',
);
// (Existing waiting-for:* removal is still worker-side, not here — no change.)
return true;
```

## Behavior — `type === 'process'` branch

**Unchanged.** Still uses `phaseTracker.clear + isDuplicate + markProcessed` and `queueAdapter.enqueue`. That branch's dedupe is about preventing double-fire of a fresh trigger *before* the trigger label is removed from GitHub — a different concern than the in-flight race.

## Migration of existing keys

No migration step required. Stale `phase-tracker:...:resume:<gate>` keys age out under 24 h TTL. During that window, the new code path does not read them, so they are inert. After ~24 h post-deploy, keyspace is clean.

## Ordering & label-mutation invariants

- The existing `queueAdapter.enqueue(queueItem)` call at line 332 must not be reached in the resume branch after this change — replaced by `enqueueIfAbsent`. Failing to remove it would cause a double-enqueue on every resume.
- `phaseTracker.clear(owner, repo, issueNumber, dedupPhase)` at line 279 must not run when `dedupPhase === 'resume:<gate>'`. The `if (type === 'process')` guard at line 278 already correctly gates this — verified.
- Label mutations at lines 342–366 (removing trigger + adding `agent:in-progress`/`workflow:*`) are inside the `if (type === 'process')` block. Resume branch does not touch labels at enqueue time. Unchanged.

## Test-visible behaviors (integration test hooks)

Three scenarios the new integration test must exercise:

1. **Regression from #849 (kept green)**: pause → resume → re-pause (paired-clear NOT firing anymore) → resume. Both resumes must enqueue.
   - Assertion: `enqueueIfAbsent` returns `true` twice (once per resume cycle), pending queue seen with 1 item after each `claim`+`complete` in between.
2. **This #862 case (impossible by construction)**: no residual `resume:<gate>` key exists to test against. Instead assert: on fresh queue, a `completed:<gate>` resume enqueues; without paired-clear or any dedupe scaffold, a second `completed:<gate>` after the item completes ALSO enqueues.
3. **Webhook+poll same occurrence (SC-003)**: two concurrent `processLabelEvent` invocations for the same `itemKey` on the same `completed:<gate>` occurrence collapse to exactly one pending item.
   - Assertion: pending queue depth == 1 after both promises resolve; one returned `true`, one returned `false`.

## Non-changes

- `verifyAndProcessCompletedLabel` (webhook stale-payload path, lines 194–236) — unchanged. It reaches `processLabelEvent` and inherits the new resume branch.
- `parseLabelEvent`, poll loop, adaptive polling, semaphore — unchanged.
