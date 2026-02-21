# Technical Research: PR Feedback Monitor

## Table of Contents

1. [Existing Infrastructure Audit](#existing-infrastructure-audit)
2. [GitHub API Strategy](#github-api-strategy)
3. [Atomic Deduplication Pattern](#atomic-deduplication-pattern)
4. [Adaptive Polling Design](#adaptive-polling-design)
5. [Worker Branch Checkout](#worker-branch-checkout)
6. [Review Thread Detection](#review-thread-detection)
7. [Prompt Engineering for Feedback](#prompt-engineering-for-feedback)

---

## Existing Infrastructure Audit

### What We Can Reuse

| Component | Location | Reuse |
|-----------|----------|-------|
| `LabelMonitorService` | `services/label-monitor-service.ts` | Architecture pattern (webhook+polling+adaptive+abort) |
| `PhaseTrackerService` | `services/phase-tracker-service.ts` | Deduplication (extend with `tryMarkProcessed`) |
| `RedisQueueAdapter` | `services/redis-queue-adapter.ts` | Queue operations (no changes needed) |
| `WorkerDispatcher` | `services/worker-dispatcher.ts` | Worker lifecycle (no changes needed) |
| `RepoCheckout` | `worker/repo-checkout.ts` | `ensureCheckout()`, `switchBranch()` |
| `CliSpawner` | `worker/cli-spawner.ts` | Claude CLI execution |
| `OutputCapture` | `worker/output-capture.ts` | CLI output parsing, SSE emission |
| `Semaphore` | `services/label-monitor-service.ts` | Concurrency limiting (private class, need to extract or duplicate) |
| `verifySignature` | `routes/webhooks.ts` | HMAC-SHA256 webhook validation |
| `GitHubClient` | `workflow-engine` | `getPRComments()`, `replyToPRComment()`, `getPullRequest()`, `addLabels()`, `removeLabels()` |

### What We Must Create

| Component | Purpose |
|-----------|---------|
| `PrFeedbackMonitorService` | Core service: webhook processing + polling fallback |
| `PrFeedbackHandler` | Worker handler: checkout, prompt, CLI, reply |
| `PrLinker` | PR-to-issue linking utility |
| `setupPrWebhookRoutes()` | Webhook route for PR review events |
| `PrMonitorConfigSchema` | Configuration schema |
| `listOpenPullRequests()` | New GitHubClient method for polling |

### What We Must Extend

| Component | Change |
|-----------|--------|
| `QueueItem` | Add `'address-pr-feedback'` to command, add `metadata` field |
| `PhaseTracker` | Add `tryMarkProcessed()` (atomic SET NX) |
| `OrchestratorConfigSchema` | Add `prMonitor` field |
| `ClaudeCliWorker.handle()` | Route `address-pr-feedback` to `PrFeedbackHandler` |
| `server.ts` | Initialize PR monitor, register routes, lifecycle hooks |
| `WORKFLOW_LABELS` | Add `waiting-for:address-pr-feedback` |

---

## GitHub API Strategy

### Using `gh` CLI (Not Octokit)

The orchestrator uses `GhCliGitHubClient` which wraps the `gh` CLI tool. All GitHub API calls go through shell commands like `gh api`, `gh pr list`, etc. This is important because:

1. **Authentication**: Handled by `gh` CLI config (no token management in code)
2. **Rate limits**: Subject to the same 5000 req/hr limit as REST API
3. **Existing methods**: `getPRComments()` and `replyToPRComment()` already exist in the interface

### Existing PR-Related Methods

From `packages/workflow-engine/src/actions/github/client/interface.ts`:

```typescript
// Already available — no new methods needed for these operations:
getPullRequest(owner, repo, number): Promise<PullRequest>
getPRComments(owner, repo, number): Promise<Comment[]>
replyToPRComment(owner, repo, number, commentId, body): Promise<Comment>
findPRForBranch(owner, repo, branch): Promise<PullRequest | null>
addLabels(owner, repo, number, labels): Promise<void>
removeLabels(owner, repo, number, labels): Promise<void>
getIssue(owner, repo, number): Promise<Issue>
```

### Missing Method: `listOpenPullRequests`

The polling loop needs to list all open PRs for a repository. This method doesn't exist yet.

**Implementation** in `gh-cli.ts`:
```typescript
async listOpenPullRequests(owner: string, repo: string): Promise<PullRequest[]> {
  const result = await this.exec([
    'pr', 'list',
    '--repo', `${owner}/${repo}`,
    '--state', 'open',
    '--json', 'number,title,body,state,isDraft,headRefName,baseRefName,labels,createdAt,updatedAt',
    '--limit', '100',
  ]);
  return JSON.parse(result.stdout);
}
```

### Comment Type and Thread Resolution

The existing `Comment` type (`packages/workflow-engine/src/types/github.ts:72-83`) includes:

```typescript
export interface Comment {
  id: number;
  body: string;
  author: string;
  created_at: string;
  updated_at: string;
  path?: string;           // file path for inline comments
  line?: number;           // line number
  in_reply_to_id?: number; // thread parent
  resolved?: boolean;      // thread resolution status
}
```

The `resolved` field is present in the type. The `getPRComments()` implementation (`gh-cli.ts:377-407`) uses `gh api /repos/{owner}/{repo}/pulls/{number}/comments` which returns review comments. However, the REST API for listing pull request review comments does **not** include a `resolved` field — that's a property of review threads (GraphQL `reviewThreads.isResolved`).

### Thread Resolution Detection Strategy

**Option A: REST API with grouping**
- Fetch comments via `getPRComments()`
- Group by `in_reply_to_id` to identify threads
- Check if the top-level comment in each thread is unresolved
- **Problem**: REST API doesn't expose `resolved` status per thread

**Option B: GraphQL via `gh api graphql`**
- Single query returns threads with `isResolved` status
- More efficient (1 call vs N calls)
- `gh api graphql` is available in the CLI

**Option C: Use `gh` CLI `pr view` with review threads**
- `gh pr view --json reviewDecision,reviews` shows review state
- Doesn't directly show thread resolution

**Recommendation**: Use `gh api graphql` for thread resolution status. Add a new method to the GitHub client:

```typescript
// New method in GitHubClient interface
getUnresolvedReviewThreads(
  owner: string, repo: string, prNumber: number
): Promise<ReviewThread[]>
```

Implementation via `gh api graphql`:
```typescript
async getUnresolvedReviewThreads(owner, repo, prNumber): Promise<ReviewThread[]> {
  const query = `query($owner:String!,$repo:String!,$pr:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$pr){
        reviewThreads(first:100){
          nodes{
            isResolved
            comments(first:1){
              nodes{ databaseId body path line author{login} }
            }
          }
        }
      }
    }
  }`;

  const result = await this.exec([
    'api', 'graphql',
    '-f', `query=${query}`,
    '-F', `owner=${owner}`,
    '-F', `repo=${repo}`,
    '-F', `pr=${prNumber}`,
  ]);

  const data = JSON.parse(result.stdout);
  return data.data.repository.pullRequest.reviewThreads.nodes
    .filter(t => !t.isResolved)
    .map(t => ({
      id: t.comments.nodes[0].databaseId,
      path: t.comments.nodes[0].path ?? null,
      line: t.comments.nodes[0].line ?? null,
      body: t.comments.nodes[0].body,
      resolved: false,
      reviewer: t.comments.nodes[0].author.login,
    }));
}
```

**Alternative simpler approach**: Since the existing `getPRComments()` returns comments with `resolved` field potentially populated, test whether the `gh api` REST endpoint actually includes the resolved status. If it does (some versions of the API do), we can skip GraphQL entirely.

**Decision**: Start with REST (`getPRComments()` filtering `resolved !== true`). If the `resolved` field isn't reliably populated, add GraphQL fallback.

### API Budget

| Operation | Calls/Poll Cycle | Calls/Hour (60s interval) |
|-----------|-----------------|--------------------------|
| List open PRs | 1 per repo | 3 × 60 = 180 |
| Get PR comments | 1 per open PR | ~15 × 60 = 900 (estimate 5 PRs/repo) |
| Get issue (verify orchestrated) | 1 per linked PR | ~15 × 60 = 900 |
| **Total** | | ~1980 / 5000 (39%) |

**Mitigation**: Most PRs won't be orchestrated — `PrLinker` filters early, reducing API calls significantly. The `maxConcurrentPolls=3` semaphore prevents burst spikes.

---

## Atomic Deduplication Pattern

### The Race Condition

```
T+0ms:   Webhook received, starts processPrReviewEvent()
T+10ms:  Poll cycle starts, detects same PR with unresolved threads
T+50ms:  Webhook: isDuplicate() → false (key not set yet)
T+60ms:  Poll: isDuplicate() → false (key not set yet)
T+100ms: Webhook: enqueue() + markProcessed()
T+110ms: Poll: enqueue() + markProcessed()  ← DUPLICATE!
```

### Solution: `SET key value EX ttl NX`

The `NX` flag makes the operation atomic — only the first caller succeeds.

```typescript
async tryMarkProcessed(owner, repo, issue, phase): Promise<boolean> {
  const key = buildKey(owner, repo, issue, phase);
  const result = await this.redis.set(key, '1', 'EX', this.ttlSeconds, 'NX');
  return result === 'OK';  // true = won the race, false = duplicate
}
```

```
T+0ms:   Webhook: tryMarkProcessed() → SET NX returns 'OK' (winner)
T+10ms:  Poll: tryMarkProcessed() → SET NX returns null (loser, skip)
Result: Exactly one enqueue ✅
```

### Dedup Key Lifecycle

1. **Enqueue**: `tryMarkProcessed()` sets key with 24h TTL
2. **Worker completes**: Key stays (prevents re-enqueue for same feedback cycle)
3. **New feedback**: After 24h TTL expires, new comments trigger fresh enqueue
4. **Re-enqueue on failure**: Worker calls `phaseTracker.clear()` before re-enqueue attempt

### When to Clear the Dedup Key

The dedup key should be cleared after the worker completes successfully, so that new review comments (added after the agent addressed the first batch) can trigger a new cycle:

```typescript
// In PrFeedbackHandler, after successful completion:
await this.phaseTracker.clear(owner, repo, issueNumber, 'address-pr-feedback');
await this.github.removeLabels(owner, repo, issueNumber, ['waiting-for:address-pr-feedback']);
```

This allows the next poll/webhook to detect new unresolved comments and re-enqueue.

---

## Adaptive Polling Design

### Spec Requirements

- US4: "Polling interval decreases by 50% when no webhook received in 2x the configured interval"
- US4: "Polling interval resets to configured value when a webhook is received"
- FR-009: "Mirror `LabelMonitorService` adaptive polling pattern"

### Implementation

```typescript
private updateAdaptivePolling(): void {
  if (this.state.lastWebhookEvent === null) return;

  const elapsed = Date.now() - this.state.lastWebhookEvent;
  const threshold = this.state.basePollIntervalMs * 2;

  if (elapsed > threshold && this.state.webhookHealthy) {
    this.state.webhookHealthy = false;
    this.state.currentPollIntervalMs = Math.max(
      10000, // minimum 10s
      Math.floor(this.state.basePollIntervalMs / 2), // 50% reduction
    );
    this.logger.info(
      { intervalMs: this.state.currentPollIntervalMs, elapsed },
      'Webhooks unhealthy, increasing poll frequency',
    );
  }
}
```

### Comparison with LabelMonitorService

| Aspect | LabelMonitorService | PrFeedbackMonitorService |
|--------|-------------------|-------------------------|
| Divisor | 3 (66% reduction) | 2 (50% reduction, per spec US4) |
| Min interval | 10s | 10s |
| Unhealthy threshold | 2x base | 2x base |
| Recovery | Immediate on webhook | Immediate on webhook |
| Default base | 30s | 60s |

---

## Worker Branch Checkout

### Flow

1. `ClaudeCliWorker.handle()` detects `command === 'address-pr-feedback'`
2. Clone repo on default branch (standard `ensureCheckout`)
3. `PrFeedbackHandler.handle()`:
   a. Fetch PR via `getPullRequest()` → get `head.ref` (branch name)
   b. Switch to PR branch via `repoCheckout.switchBranch(checkoutPath, branchName)`
   c. Now working directory is on the PR branch HEAD

### Why Not Create a New Branch?

The agent must make changes on the existing PR branch so commits appear in the PR diff. Creating a new branch would require a separate PR or force-push — both undesirable.

### RepoCheckout.switchBranch() Behavior

From `packages/orchestrator/src/worker/repo-checkout.ts:91-110`:

```typescript
async switchBranch(checkoutPath: string, branch: string): Promise<void> {
  await execFileAsync('git', ['fetch', 'origin'], { cwd: checkoutPath });
  try {
    await execFileAsync('git', ['checkout', branch], { cwd: checkoutPath });
  } catch {
    await execFileAsync('git', ['checkout', '-b', branch, `origin/${branch}`], { cwd: checkoutPath });
  }
  await execFileAsync('git', ['reset', '--hard', `origin/${branch}`], { cwd: checkoutPath });
}
```

This handles both cases: local branch exists (checkout) and doesn't exist (create tracking branch). The `reset --hard` ensures we're at the remote HEAD.

---

## Review Thread Detection

### Detection Strategy (FR-003)

> "Ignore review state (`changes_requested`, `approved`, etc.); thread resolution is the source of truth"

This means we don't look at the review-level `state` field. We only care about individual thread `isResolved`/`resolved` status. A reviewer might approve the PR overall but still have unresolved threads that need attention.

### Thread Grouping

PR review comments form threads via the `in_reply_to_id` field:

```
Comment A (id=100, in_reply_to_id=null)  ← Thread root
  └── Comment B (id=101, in_reply_to_id=100)  ← Reply
  └── Comment C (id=102, in_reply_to_id=100)  ← Reply (agent adds this)
```

When replying, we use the root comment's ID (`replyToPRComment(owner, repo, prNumber, 100, body)`). This ensures the reply is part of the correct thread.

### Filtering Logic

```typescript
async function getUnresolvedThreads(
  github: GitHubClient, owner: string, repo: string, prNumber: number
): Promise<ReviewThread[]> {
  const comments = await github.getPRComments(owner, repo, prNumber);

  // Filter to root comments (not replies) that are unresolved
  return comments
    .filter(c => c.in_reply_to_id === undefined || c.in_reply_to_id === null)
    .filter(c => c.resolved !== true)
    .map(c => ({
      id: c.id,
      path: c.path ?? null,
      line: c.line ?? null,
      body: c.body,
      resolved: c.resolved ?? false,
      reviewer: c.author,
    }));
}
```

**Note**: If `resolved` field is not populated by the REST API, fall back to GraphQL (see GitHub API Strategy section above).

---

## Prompt Engineering for Feedback

### Prompt Structure

```
You are addressing PR review feedback on PR #{prNumber}.
Read each review comment below, make the necessary code changes, and commit them.

IMPORTANT:
- Make changes directly to the files mentioned in each comment
- Commit all changes with a clear message
- Do NOT resolve any review threads
- After making changes, the orchestrator will post replies to each thread

Review Comments:

---
File: src/services/monitor.ts:42
Reviewer: @senior-dev
Comment: Add error handling for API failures. This could throw if the GitHub API is down.
---
File: src/services/monitor.ts:87
Reviewer: @senior-dev
Comment: Extract this logic into a helper function for reusability.
---
```

### Why This Structure?

1. **File paths and line numbers** — gives Claude precise context for where changes are needed
2. **Reviewer names** — helps Claude understand who left feedback (for tone)
3. **Clear instructions** — "do NOT resolve threads" prevents the agent from calling resolution APIs
4. **One prompt for all threads** — allows Claude to see the full picture and make coordinated changes

### Reply Generation

After Claude CLI completes, the handler posts replies to each thread. The reply content is a fixed template (not generated by Claude) since the changes themselves are the response:

```typescript
function buildReplyBody(thread: ReviewThread): string {
  return `Addressed this feedback in the latest commit. Please review the changes.

_This comment was posted by the Generacy agent._`;
}
```

**Future enhancement**: Parse Claude CLI output to generate specific per-thread replies describing what was changed. For now, a simple acknowledgment is sufficient.

---

## Semaphore Extraction

The `Semaphore` class is defined as a private class inside `label-monitor-service.ts` (lines 459-488). The PR monitor needs the same pattern for `maxConcurrentPolls`.

**Options**:
1. Extract to shared utility (e.g., `packages/orchestrator/src/utils/semaphore.ts`)
2. Duplicate in `pr-feedback-monitor-service.ts`

**Decision**: Option 1 (extract) — avoids duplication, both services import from same location.

---

*End of Technical Research*
