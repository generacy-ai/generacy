# Contract: `PrFeedbackHandler.handle` — dedupe-clear invariant + degraded-identity behavior

**Feature**: `869-found-during-cockpit-v1` (FR-002, FR-003, FR-006, FR-007)
**Module**: `packages/orchestrator/src/worker/pr-feedback-handler.ts`
**Change type**: Modification of exit paths + new constructor dependencies.

## Constructor extension

```typescript
export class PrFeedbackHandler {
  constructor(
    private readonly config: WorkerConfig,
    private readonly logger: Logger,
    private readonly agentLauncher: AgentLauncher,
    private readonly phaseTracker: PhaseTracker,          // NEW #869 / FR-006
    private readonly clusterIdentity: string | undefined, // NEW #869 / FR-001, FR-007
    private readonly sseEmitter?: SSEEventEmitter,
  ) { /* … */ }
}
```

Wiring in `packages/orchestrator/src/worker/claude-cli-worker.ts:265`:

```typescript
const prFeedbackHandler = new PrFeedbackHandler(
  this.config,
  workerLogger,
  this.agentLauncher,
  this.phaseTracker!,          // #869: throws if unavailable — worker mode must have Redis
  this.clusterIdentity,        // resolved at orchestrator startup, threaded via ClaudeCliWorkerDeps
  this.sseEmitter,
);
```

**`phaseTracker` required in production**: the injection point uses non-null assertion. Full-mode Redis-less test harnesses that skip PR-feedback handling continue to work; PR-feedback handler tests inject a stub.

**`clusterIdentity` may be `undefined`**: triggers FR-007 degraded behavior in the handler.

## Handler exit paths (all must clear the dedupe key)

Key: `phase-tracker:<item.owner>:<item.repo>:<item.issueNumber>:address-pr-feedback`

Each exit path is annotated with `// FR-006 exit path N`:

```typescript
async handle(item: QueueItem, checkoutPath: string): Promise<void> {
  const { owner, repo, issueNumber } = item;
  const clearDedupe = () => this.phaseTracker
    .clear(owner, repo, issueNumber, 'address-pr-feedback')
    .catch(err => this.logger.warn({ err: String(err) }, 'Failed to clear dedupe key — non-fatal'));

  try {
    // ... existing setup: metadata check, github client, fetch PR, switch branch ...

    // 3. Fetch fresh threads + apply trust filter
    // (unchanged from today, but use `this.clusterIdentity` in trust ctx)
    const trustContext = {
      logger: this.logger,
      botLogin: process.env['CLUSTER_GITHUB_USERNAME'] ?? process.env['GH_USERNAME'],
      clusterIdentity: this.clusterIdentity,
      config: tryLoadCommentTrustConfig(checkoutPath, this.logger),
    };

    if (!this.clusterIdentity) {
      this.logger.error(
        {
          triedChain: ['config', 'CLUSTER_GITHUB_USERNAME', 'GH_USERNAME', 'gh api user'],
          prNumber, owner, repo, issueNumber,
        },
        'Cluster identity unresolvable at handler runtime — degraded FR-007 mode: '
          + 'FR-002/FR-003 zero-trusted retention applies unconditionally to untrusted comments',
      );
    }

    const threads = await github.getPRReviewThreads(owner, repo, prNumber);
    const unresolvedThreads = threads.filter(t => !t.isResolved);
    const unresolvedThreadComments = unresolvedThreads.flatMap(t => t.comments);

    const trustedUnresolved: Comment[] = [];
    const untrustedSkips: Array<{...}> = [];
    for (const c of unresolvedThreadComments) {
      const decision = isTrustedCommentAuthor(c, 'pr-feedback', trustContext);
      if (decision.trusted) trustedUnresolved.push(c);
      else untrustedSkips.push({
        commentId: c.id, author: c.author,
        authorAssociation: c.authorAssociation, reason: decision.reason,
      });
    }

    // Case A: no unresolved threads at all — success path with dedupe clear
    if (unresolvedThreads.length === 0) {
      this.logger.info({ prNumber, issueNumber }, 'No unresolved threads found — success');
      await this.removeFeedbackLabel(github, owner, repo, issueNumber);
      await clearDedupe();                                              // FR-006 exit path 1
      return;
    }

    // Case B: unresolved threads exist but zero-trusted — retain label, WARN, clear dedupe
    if (trustedUnresolved.length === 0) {
      this.logger.warn(
        {
          prNumber, issueNumber,
          totalUnresolvedThreads: unresolvedThreads.length,
          untrustedSkips,
        },
        'Zero-trusted unresolved threads — retaining waiting-for:address-pr-feedback label (FR-002)',
      );
      // DO NOT: removeFeedbackLabel (FR-002)
      // DO NOT: emit "No unresolved threads found" log line (SC-002)
      await clearDedupe();                                              // FR-006 exit path 2
      return;
    }

    // Case C: trusted unresolved threads — proceed with existing logic
    // ... existing spawn/commit/push/reply flow ...

    if (success) {
      await this.removeFeedbackLabel(...);
      await clearDedupe();                                              // FR-006 exit path 3
    } else {
      // Label kept for retry
      await clearDedupe();                                              // FR-006 exit path 4 (retry-enabled)
    }
  } catch (error) {
    this.logger.error({ error: String(error), ... }, 'Error processing PR feedback');
    await clearDedupe();                                                // FR-006 exit path 5
    throw error;
  }
}
```

**Path 4 rationale**: today's code keeps the label on CLI-timeout so the label monitor / next PR-feedback poll re-detects. Under Q3-A, we ALSO clear the dedupe key so the next monitor poll actually enqueues (rather than skipping as duplicate until TTL). Yes, this means a persistently-failing CLI produces one enqueue per poll cycle — bounded to 60s cadence, diagnosable via the "CLI did not complete successfully" `warn`, and preferable to the TTL-strand.

## Cases retired

The current `if (unresolvedComments.length === 0)` branch (line 196) currently does *both* zero-thread and zero-trusted-thread cases and emits the false log line `"No unresolved threads found — removing label and exiting"` in both. After this change it strictly handles Case A (`unresolvedThreads.length === 0`), and Case B (zero-trusted) is a separate branch above.

## Invariants

- **I1** (dedupe cleared on every exit — SC-003): every path leading to `return` or a re-thrown error calls `clearDedupe()` exactly once.
- **I2** (label semantics preserved):
  - Success or "no unresolved threads at all" → label removed.
  - Zero-trusted → label RETAINED (FR-002).
  - CLI failure → label RETAINED for retry.
- **I3** (no false log lines — SC-002): the "No unresolved threads found" wording is emitted ONLY on Case A (`unresolvedThreads.length === 0`), never on Case B.
- **I4** (degraded identity — FR-007): `clusterIdentity === undefined` produces an `error` log at handler entry but does not alter subsequent branch selection. Association-tier trust still fires (decision 3 in the predicate); the cluster-identity match (decision 1.5) simply never fires.
- **I5** (no new error class): the handler still throws bare `Error` instances from failed critical operations; the outer `catch` still re-throws; the worker's error path is unchanged.
- **I6** (clearDedupe is fire-and-forget-safe): `clearDedupe` swallows its own errors after logging so it never turns a success into a failure. Redis unavailability degrades to "next poll enqueues the duplicate" — bounded and monitored.

## Test contract

Unit test cases (add to `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts`):

| # | Setup | Assertion |
|---|-------|-----------|
| H1 | Path 1 (no unresolved threads at all) | `phaseTracker.clear` called once with the expected key; label removed; "No unresolved threads found" log emitted |
| H2 | Path 2 (unresolved threads exist, all comments untrusted) | `phaseTracker.clear` called once; label NOT removed; `warn` log emitted with `untrustedSkips`; NO "No unresolved threads found" log line |
| H3 | Path 3 (trusted comments, CLI success) | `phaseTracker.clear` called once at end; label removed; reply-to-threads invoked |
| H4 | Path 4 (trusted comments, CLI timeout) | `phaseTracker.clear` called once; label kept; `warn` log about retry |
| H5 | Path 5 (uncaught exception in `getPRReviewThreads`) | `phaseTracker.clear` called; then re-throw |
| H6 | Path 5 (uncaught exception in commit/push) | `phaseTracker.clear` called; then re-throw |
| H7 | `clusterIdentity === undefined`, comment authored by cluster's actual login, `authorAssociation=NONE` | comment classified as untrusted (decision 1.5 doesn't fire), Path 2 triggers, `error` log about chain resolution |
| H8 | `clusterIdentity` set to cluster's login, same comment | comment classified as trusted (`reason='cluster-identity'`), Path 3 triggers |
| H9 | `phaseTracker.clear` itself throws | outer flow completes normally; `warn` log about clear failure; no re-throw |
