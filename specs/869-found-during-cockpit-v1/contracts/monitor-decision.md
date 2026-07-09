# Contract: `PrFeedbackMonitorService.processPrReviewEvent` — trust-aware enqueue + zero-trusted notice

**Feature**: `869-found-during-cockpit-v1` (FR-002, FR-003, FR-004, FR-005)
**Module**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
**Change type**: Modification of the enqueue decision + new zero-trusted transition handling.

## Constructor extension

```typescript
constructor(
  logger: Logger,
  createClient: GitHubClientFactory,
  phaseTracker: PhaseTracker,
  queueAdapter: QueueAdapter,
  config: PrMonitorConfig,
  repositories: RepositoryConfig[],
  clusterGithubUsername?: string,     // ALSO passed as clusterIdentity
  tokenProvider?: () => Promise<string | undefined>,
  authHealth?: AuthHealthSink,
  githubAppCredentialId?: string,
)
```

**Note**: `clusterGithubUsername` already exists (assignee filtering). This spec adds ONE new use of the same value — passing it into `CommentTrustContext.clusterIdentity`. No new constructor arg.

## Decision flow (modified)

Before this change, step 3 of `processPrReviewEvent` extracted only `rootCommentId` per unresolved thread and enqueued if `unresolvedThreadIds.length > 0`. After this change, step 3 additionally applies the shared trust predicate per comment, and enqueue is gated on presence of at least one trusted unresolved comment.

```text
1-2. (unchanged) PR-linker → assignee check
3.   Fetch review threads via getPRReviewThreads
     For each thread with isResolved=false:
       For each comment in thread:
         decision = isTrustedCommentAuthor(comment, 'pr-feedback', {
           botLogin: process.env['CLUSTER_GITHUB_USERNAME'] ?? process.env['GH_USERNAME'],
           clusterIdentity: this.clusterGithubUsername,
           logger: this.logger,
         })
       Thread is "trust-live" iff at least one comment.trusted === true.

     Accumulate:
       trustedUnresolvedThreadIds  = trust-live threads' rootCommentId
       untrustedCommentSkips       = { commentId, author, authorAssociation, reason }
                                     for every skipped comment in non-trust-live threads

4.   Compare against previous state map (this.lastUnresolvedThreadCount + new
     this.lastZeroTrustedState).

     Case A: trustedUnresolvedThreadIds.length > 0
       → Proceed to atomic tryMarkProcessed (unchanged from today).
       → this.lastZeroTrustedState.set(prKey, false).

     Case B: trustedUnresolvedThreadIds.length === 0
              AND totalUnresolvedThreads > 0
              (zero-trusted state)
       → SKIP tryMarkProcessed and enqueue.
       → this.logger.warn({
             owner, repo, prNumber, issueNumber,
             totalUnresolvedThreads,
             untrustedCommentSkips,
           }, 'PR has unresolved threads but every comment author is untrusted')
       → If lastZeroTrustedState[prKey] !== true:  (transition edge)
           await maybePostUntrustedNotice(client, owner, repo, prNumber)
       → this.lastZeroTrustedState.set(prKey, true).

     Case C: totalUnresolvedThreads === 0
       → Existing state-transition logging (unchanged).
       → this.lastZeroTrustedState.set(prKey, false).
```

## `maybePostUntrustedNotice` — new helper

```typescript
private async maybePostUntrustedNotice(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  // Idempotency check — grep prior PR comments for the marker.
  let existingComments: string[];
  try {
    existingComments = await client.listPrCommentBodies(owner, repo, prNumber);
  } catch (err) {
    this.logger.warn(
      { err: String(err), owner, repo, prNumber },
      'Failed to list PR comments for untrusted-notice idempotency check — skipping notice this cycle',
    );
    return;
  }

  if (existingComments.some(body => body.includes(UNTRUSTED_NOTICE_MARKER))) {
    this.logger.debug(
      { owner, repo, prNumber },
      'Untrusted-notice marker already present — skipping notice post',
    );
    return;
  }

  const body = [
    UNTRUSTED_NOTICE_MARKER,
    '',
    '⚠️ **Feedback requires a trusted author**',
    '',
    'This PR has unresolved review threads, but every comment author is currently',
    'classified as untrusted by the PR-feedback loop\'s trust filter (see #842).',
    '',
    'The loop will not automatically address this feedback until either:',
    '- A repository OWNER / MEMBER / COLLABORATOR replies to one of the threads, **or**',
    '- The cluster identity is configured to match one of the comment authors',
    '  (see the `CLUSTER_GITHUB_USERNAME` / `GH_USERNAME` chain).',
    '',
    'This is an automated notice from the PR-feedback monitor.',
  ].join('\n');

  try {
    await client.postPrComment(owner, repo, prNumber, body);
    this.logger.info(
      { owner, repo, prNumber },
      'Posted untrusted-feedback notice on PR (FR-004)',
    );
  } catch (err) {
    this.logger.warn(
      { err: String(err), owner, repo, prNumber },
      'Failed to post untrusted-feedback notice — will retry on next transition',
    );
  }
}
```

## New `GitHubClient` methods

Two additive methods on the client interface. Both are thin wrappers over existing `gh` invocations:

```typescript
interface GitHubClient {
  // ... existing methods ...

  /**
   * List top-level (issue-comment) PR comment bodies for idempotency
   * checks. Does NOT return review-thread comment bodies (those come from
   * `getPRReviewThreads`).
   */
  listPrCommentBodies(owner: string, repo: string, prNumber: number): Promise<string[]>;

  /**
   * Post a top-level PR comment (issue-comment API, not review-thread reply).
   */
  postPrComment(owner: string, repo: string, prNumber: number, body: string): Promise<void>;
}
```

`GhCliGitHubClient` implementations:

```typescript
async listPrCommentBodies(owner: string, repo: string, prNumber: number): Promise<string[]> {
  const result = await this.executeGh([
    'pr', 'view', String(prNumber),
    '--repo', `${owner}/${repo}`,
    '--json', 'comments',
    '--jq', '.comments[].body',
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to list PR comments: ${result.stderr}`);
  }
  return result.stdout.split('\n').filter(l => l.length > 0);
}

async postPrComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
  const result = await this.executeGh([
    'pr', 'comment', String(prNumber),
    '--repo', `${owner}/${repo}`,
    '--body', body,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to post PR comment: ${result.stderr}`);
  }
}
```

Note: `gh pr comment` posts a top-level issue-comment on the PR — this is the correct API for Q5-A's "not a review-thread reply".

## Invariants

- **I1** (shared predicate — SC-005): monitor and handler both import `isTrustedCommentAuthor` from `@generacy-ai/workflow-engine`. Zero inline `authorAssociation === 'OWNER' || …` in either.
- **I2** (no zero-trusted enqueue): if `trustedUnresolvedThreadIds.length === 0` and `totalUnresolvedThreads > 0`, `tryMarkProcessed` is NOT called and `queueAdapter.enqueue` is NOT called.
- **I3** (transition-edge notice — SC-004): notice is posted only on the transition edge `lastZeroTrustedState[prKey] !== true → true`. Steady-state polls emit the `warn` log (FR-003) but not the notice.
- **I4** (marker-grep idempotency): even if `lastZeroTrustedState` is lost (monitor restart), the marker-grep prevents duplicate notices.
- **I5** (notice placement — Q5-A): top-level PR comment via `gh pr comment`, never a review-thread reply. This ensures the notice cannot re-enter the trust-filtered enumeration in `getPRReviewThreads`.
- **I6** (non-fatal notice failures): `postPrComment` and `listPrCommentBodies` failures are logged and swallowed — never block the poll cycle or throw out of `processPrReviewEvent`.

## Test contract

Unit test cases (add to `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts`):

| # | Setup | Assertion |
|---|-------|-----------|
| M1 | 1 unresolved thread, 1 comment authored by cluster identity, `authorAssociation=NONE` | `tryMarkProcessed` called, `enqueue` called, no notice posted, no `comment-skipped` warn |
| M2 | 1 unresolved thread, all comments untrusted, no prior state | `tryMarkProcessed` NOT called, `enqueue` NOT called, `warn` log emitted with `untrustedCommentSkips`, `postPrComment` called once with body containing `UNTRUSTED_NOTICE_MARKER` |
| M3 | Same as M2 but `listPrCommentBodies` returns a body containing the marker | `postPrComment` NOT called |
| M4 | Same as M2 but `lastZeroTrustedState[prKey] === true` from previous poll | `postPrComment` NOT called (transition-map guard) |
| M5 | Poll 1: zero-trusted state (M2). Poll 2: trusted comment added, unresolved thread now trust-live | Poll 2: `enqueue` called, `lastZeroTrustedState[prKey]` reset to `false` |
| M6 | Poll 1: zero-trusted state (M2). Poll 2: PR closed (thread scan returns 0 unresolved) | `lastZeroTrustedState[prKey]` reset to `false`; no notice |
| M7 | 2 unresolved threads, one is trust-live, one is fully untrusted | `enqueue` called (Case A), no notice; the fully-untrusted thread's comments still appear in a `debug` log for observability but NOT in a `warn` (defer to case B) |
| M8 | `postPrComment` throws | poll cycle continues, `warn` log emitted, subsequent PR polls still work |

Note on M7: the "some threads trusted, some threads fully untrusted" case is arguably a partial-zero-trusted state. The design choice is to treat it as Case A (fully trust-live from the enqueue POV) — the operator gets to see the trusted feedback addressed and the untrusted skips show up in `debug`-level logs. This avoids gaming the notice by mixing a trusted-comment placebo into an otherwise-untrusted set.
