# Contract: `MergeConflictMonitorService`

**File**: `packages/orchestrator/src/services/merge-conflict-monitor-service.ts` (new)
**Shape template**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:50` (`PrFeedbackMonitorService`)

## Public surface

```ts
export class MergeConflictMonitorService {
  constructor(
    logger: Logger,
    createClient: GitHubClientFactory,
    queueManager: QueueManager,
    config: PrMonitorConfig,                   // reused; poll config shape identical
    repositories: RepositoryConfig[],
    clusterGithubUsername?: string,
    tokenProvider?: () => Promise<string | undefined>,
    authHealth?: AuthHealthSink,
    githubAppCredentialId?: string,
  );

  async startPolling(): Promise<void>;
  stopPolling(): void;

  /**
   * Single event-processing entry — shared by webhook (future) and poll paths.
   * Returns true if enqueued, false if skipped or duplicate.
   */
  async processMergeConflictEvent(event: MergeConflictEvent): Promise<boolean>;
}
```

Where `MergeConflictEvent` is:

```ts
export interface MergeConflictEvent {
  owner: string;
  repo: string;
  issueNumber: number;
  /** Full labels on the issue at detection time */
  issueLabels: string[];
  /** How this event was detected */
  source: 'webhook' | 'poll';
}
```

## Flow

```
[poll cycle every pollIntervalMs]
1. For each RepositoryConfig:
   a. gh-list issues with label 'waiting-for:merge-conflicts'
      via GitHubClient.listIssuesWithLabel(owner, repo, 'waiting-for:merge-conflicts')
   b. Filter by assignee (reuse filterByAssignee from identity.ts — same as
      label-monitor-service.ts:493)
   c. For each issue: build MergeConflictEvent → processMergeConflictEvent()

[processMergeConflictEvent]
2. Precondition check: MUST have both 'waiting-for:merge-conflicts' AND 'agent:paused'
   in issueLabels (mirror #864's pause label set exactly).
   - Missing agent:paused → drop with debug log (pause not actually in place).
3. Blocked-label skip: if any label starts with 'blocked:'
   → skip enqueue, emit info log with reason 'blocked-label-present'
   → return false
   (mirror pr-feedback-monitor-service.ts:317-346)
4. Resolve workflowName from labels (workflow:<name> label → name;
   default 'speckit-feature'; mirror label-monitor-service.ts:294-303)
5. Build QueueItem:
   {
     owner, repo, issueNumber,
     workflowName,
     command: 'resolve-merge-conflicts',
     priority: Date.now(),
     enqueuedAt: new Date().toISOString(),
     metadata: {} as ResolveMergeConflictsMetadata,  // empty — handler re-derives
     queueReason: 'resume',
   }
6. Call queueManager.enqueueIfAbsent(item).
   - true: info log "Merge-conflict resolution enqueued", return true.
   - false: info log with reason 'in-flight', return false.
7. NO label mutation on enqueue. The waiting-for:merge-conflicts label is
   already on the issue (put there by #864's pause path); the handler
   removes it on success.
```

## Key differences from `PrFeedbackMonitorService`

- **No thread-count state maps.** `PrFeedbackMonitorService.lastUnresolvedThreadCount` (line 63) and `.lastZeroTrustedState` (line 69) are PR-thread-specific. Merge-conflicts monitor has no such state — the label alone is the signal.
- **No untrusted-notice posting.** The trust filter (`#869`) is PR-review-comment-specific. Not applicable.
- **No pre-emptive `waiting-for` label add.** The label is already there — the monitor just observes it and enqueues.
- **Simpler event shape.** No `prBody` / `branchName` in the event — those are handler concerns.

## Adaptive polling

- Reuse `PrMonitorConfig` from `packages/orchestrator/src/config/schema.ts` (shared with PR feedback monitor). Default poll interval same order of magnitude as PR-feedback monitor.
- `ADAPTIVE_DIVISOR = 2` (same as PR feedback — halves on activity). Merge-conflict pauses are rare events; adaptive polling primarily reduces overhead when the paused set is empty.

## Error handling

- `JitTokenError` — skip cycle (matches `pr-feedback-monitor-service.ts:526` pattern).
- `GhAuthError` — record failure via `authHealth.recordResult({ ok: false, statusCode: 401 })`, skip cycle.
- Any other error — log warn, continue to next repo (do NOT bring down the poll loop).

## Wiring

`packages/orchestrator/src/server.ts` — construct and start alongside `PrFeedbackMonitorService`:

```ts
const mergeConflictMonitor = new MergeConflictMonitorService(
  logger,
  createGitHubClient,
  queueManager,
  config.monitor.prFeedback,   // reuse PR feedback config for now
  config.repositories,
  clusterGithubUsername,
  tokenProvider,
  authHealth,
  githubAppCredentialId,
);
void mergeConflictMonitor.startPolling();
```

Registered in the same graceful shutdown block as the other monitors.

## Observability

- One log line per poll cycle per repo (`debug` when empty, `info` when non-empty count).
- One log line per enqueue outcome (`info` on enqueue, `info` on drop with reason).
- No structured metrics required for v1 — cockpit `status` command reads label state directly (already understands `waiting-for:merge-conflicts` semantics from the label protocol).

## Test coverage (must-have)

- **T1**: poll finds one paused issue → enqueue succeeds.
- **T2**: poll finds paused issue with `blocked:stuck-merge-conflicts` → skip, log reason.
- **T3**: poll finds paused issue but assignee != cluster user → skip via `filterByAssignee`.
- **T4**: two consecutive polls with same paused issue → first enqueues, second drops with `reason: 'in-flight'`.
- **T5**: paused issue but `agent:paused` label missing → drop with debug log (precondition failure).
- **T6**: `GhAuthError` on `listIssuesWithLabel` → `authHealth.recordResult` called, cycle skipped, no throw.
