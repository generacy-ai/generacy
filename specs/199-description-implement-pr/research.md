# Technical Research: PR Feedback Monitor

This document covers technical research, implementation patterns, and key design considerations for the PR Feedback Monitor feature.

## Table of Contents

1. [GitHub API Integration](#github-api-integration)
2. [PR-to-Issue Linking Strategies](#pr-to-issue-linking-strategies)
3. [Webhook vs. Polling Trade-offs](#webhook-vs-polling-trade-offs)
4. [Redis Deduplication Patterns](#redis-deduplication-patterns)
5. [Worker Branch Checkout Strategy](#worker-branch-checkout-strategy)
6. [Review Thread Management](#review-thread-management)
7. [Adaptive Polling Implementation](#adaptive-polling-implementation)
8. [Error Handling and Retry Logic](#error-handling-and-retry-logic)

---

## GitHub API Integration

### Relevant Endpoints

#### 1. List Pull Requests
**Endpoint**: `GET /repos/{owner}/{repo}/pulls`

**Query Parameters**:
```typescript
{
  state: 'open' | 'closed' | 'all',  // filter by PR state
  sort: 'created' | 'updated' | 'popularity' | 'long-running',
  direction: 'asc' | 'desc',
  per_page: number,  // max 100
  page: number
}
```

**Rate Limit**: Primary rate limit (5000 req/hr for authenticated requests)

**Usage in Polling**:
```typescript
const openPrs = await octokit.pulls.list({
  owner,
  repo,
  state: 'open',
  sort: 'updated',  // most recently updated first
  direction: 'desc',
  per_page: 100,
});
```

**Cost**: 1 API call per 100 PRs per repo

---

#### 2. Get Pull Request
**Endpoint**: `GET /repos/{owner}/{repo}/pulls/{pull_number}`

**Response Fields**:
```typescript
{
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: {
    ref: string;  // branch name
    sha: string;
  };
  base: {
    ref: string;  // target branch (usually 'main' or 'develop')
  };
  html_url: string;
  updated_at: string;  // ISO 8601 timestamp
}
```

**Usage in Worker**:
```typescript
const pr = await octokit.pulls.get({
  owner,
  repo,
  pull_number: prNumber,
});
const branchName = pr.data.head.ref;
```

**Cost**: 1 API call per PR

---

#### 3. List Review Comments
**Endpoint**: `GET /repos/{owner}/{repo}/pulls/{pull_number}/comments`

**Response**:
```typescript
Array<{
  id: number;
  path: string;  // file path
  position: number;  // diff position
  line: number;  // line number in file
  body: string;  // comment text (Markdown)
  user: {
    login: string;
  };
  created_at: string;
  updated_at: string;
  // Thread resolution (only in some responses)
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
  side: 'LEFT' | 'RIGHT';
}>
```

**Important**: This endpoint returns **review comments** (inline file comments), not review summaries.

**Usage**:
```typescript
const comments = await octokit.pulls.listReviewComments({
  owner,
  repo,
  pull_number: prNumber,
  per_page: 100,
});
```

**Cost**: 1 API call per 100 comments per PR

**Limitation**: This endpoint does NOT include thread resolution status directly. Need to use Review Threads API.

---

#### 4. List Review Threads (GraphQL)
**Endpoint**: GraphQL API

**Query**:
```graphql
query($owner: String!, $repo: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 100) {
            nodes {
              id
              body
              path
              line
              author {
                login
              }
            }
          }
        }
      }
    }
  }
}
```

**Response**:
```typescript
{
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{
          id: string;  // GraphQL node ID
          isResolved: boolean;
          comments: {
            nodes: Array<{
              id: string;
              body: string;
              path: string;
              line: number;
              author: { login: string };
            }>;
          };
        }>;
      };
    };
  };
}
```

**Advantages**:
- Provides `isResolved` status per thread
- Groups comments into threads
- Single query fetches all data

**Cost**: 1 GraphQL query = 1 point from rate limit

**Recommended Approach**: Use GraphQL for thread resolution status

---

#### 5. Reply to Review Comment
**Endpoint**: `POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies`

**Request Body**:
```typescript
{
  body: string;  // Markdown comment text
}
```

**Response**: Same as review comment object

**Usage**:
```typescript
await octokit.pulls.createReplyForReviewComment({
  owner,
  repo,
  pull_number: prNumber,
  comment_id: threadId,
  body: 'Fixed as requested. Added error handling in try-catch block.',
});
```

**Important**: Do NOT call the resolve thread endpoint:
```typescript
// ❌ NEVER CALL THIS
await octokit.pulls.updateReviewComment({
  owner,
  repo,
  comment_id: threadId,
  // This field would resolve the thread, which we must avoid
});
```

**Cost**: 1 API call per reply

---

### Rate Limiting Strategy

**Primary Rate Limit**: 5000 requests/hour for authenticated requests

**Headers to Monitor**:
```typescript
const rateLimit = {
  limit: parseInt(response.headers['x-ratelimit-limit']),
  remaining: parseInt(response.headers['x-ratelimit-remaining']),
  reset: parseInt(response.headers['x-ratelimit-reset']),  // Unix timestamp
};
```

**Polling Budget Calculation**:
- 3 repos × 1 call/repo = 3 calls/poll cycle
- 60 poll cycles/hour (1 min interval) = 180 calls/hour
- Safety margin: 180 / 5000 = 3.6% of rate limit

**Adaptive Throttling**:
```typescript
async function checkRateLimit(github: GitHubClient): Promise<void> {
  const rateLimit = await github.getRateLimit();

  if (rateLimit.remaining < 100) {
    const resetTime = new Date(rateLimit.reset * 1000);
    const waitMs = resetTime.getTime() - Date.now();

    logger.warn(
      { remaining: rateLimit.remaining, resetTime },
      'GitHub API rate limit low, pausing polling'
    );

    // Pause polling until rate limit resets
    await sleep(waitMs);
  }
}
```

---

## PR-to-Issue Linking Strategies

### Strategy 1: PR Body Parsing (Primary)

**Closing Keywords** (GitHub-recognized):
- `close`, `closes`, `closed`
- `fix`, `fixes`, `fixed`
- `resolve`, `resolves`, `resolved`

**Pattern Matching**:
```typescript
const CLOSING_KEYWORD_REGEX = /\b(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)/gi;

function parsePrBody(prBody: string): number | null {
  const matches = prBody.matchAll(CLOSING_KEYWORD_REGEX);

  for (const match of matches) {
    const issueNumber = parseInt(match[2], 10);
    if (!isNaN(issueNumber)) {
      return issueNumber;  // return first match
    }
  }

  return null;
}
```

**Edge Cases**:
```typescript
// Multiple issues: return first
"Closes #199, Fixes #200"  → 199

// Case insensitive
"CLOSES #199"  → 199

// Mid-sentence
"This PR closes #199 and improves performance"  → 199

// Code block (should ignore, but regex will still match)
// Future improvement: strip code blocks before parsing
```

**Success Rate**: ~80-90% (based on GitHub best practices adoption)

---

### Strategy 2: Branch Name Parsing (Fallback)

**Pattern**: `{issue-number}-{description}`

**Examples**:
- `199-pr-feedback-monitor` → 199
- `42-fix-auth-bug` → 42
- `123-feature/new-api` → 123 (with slash, still works)

**Implementation**:
```typescript
function parseBranchName(branchName: string): number | null {
  // Match leading digits followed by hyphen
  const match = branchName.match(/^(\d+)-/);

  if (match) {
    const issueNumber = parseInt(match[1], 10);
    return isNaN(issueNumber) ? null : issueNumber;
  }

  return null;
}
```

**Success Rate**: ~60-70% (depends on team conventions)

**False Positives**:
- `2024-03-05-hotfix` → 2024 (date mistaken for issue number)
- Mitigation: Verify issue exists and has `agent:*` label

---

### Strategy 3: Combined Approach

**Priority Chain**:
1. Try PR body parsing
2. If no match, try branch name parsing
3. If still no match, return null (PR not linked)

**Implementation**:
```typescript
async function linkPrToIssue(
  github: GitHubClient,
  owner: string,
  repo: string,
  pr: { number: number; body: string; head: { ref: string } }
): Promise<PrToIssueLink | null> {
  // Try PR body first (preferred)
  let issueNumber = parsePrBody(pr.body);
  let linkMethod: 'pr-body' | 'branch-name' = 'pr-body';

  // Fallback to branch name
  if (issueNumber === null) {
    issueNumber = parseBranchName(pr.head.ref);
    linkMethod = 'branch-name';
  }

  if (issueNumber === null) {
    logger.debug({ prNumber: pr.number }, 'No issue link found');
    return null;
  }

  // Verify issue exists and is orchestrated
  const isOrchestrated = await verifyOrchestrated(github, owner, repo, issueNumber);
  if (!isOrchestrated) {
    logger.info({ prNumber: pr.number, issueNumber }, 'Linked issue is not orchestrated');
    return null;
  }

  return {
    prNumber: pr.number,
    issueNumber,
    linkMethod,
  };
}
```

**Combined Success Rate**: ~95%+ (target for SC-002)

---

### Issue Verification

**Check for Orchestration**:
```typescript
async function verifyOrchestrated(
  github: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<boolean> {
  try {
    const issue = await github.getIssue(owner, repo, issueNumber);
    const labels = issue.labels.map(l => typeof l === 'string' ? l : l.name);

    // Check for agent:* label (indicates orchestrated issue)
    return labels.some(label => label.startsWith('agent:'));
  } catch (error) {
    // Issue not found or access denied
    logger.warn({ err: error, issueNumber }, 'Failed to verify issue');
    return false;
  }
}
```

**Why Check `agent:*` Label**:
- Indicates issue is managed by orchestrator
- Prevents processing manual PRs for non-orchestrated issues
- Reduces noise in queue from unrelated PRs

---

## Webhook vs. Polling Trade-offs

### Webhook Approach

**Advantages**:
- Near real-time detection (< 5 seconds latency)
- No GitHub API rate limit consumption for detection
- Event-driven, only processes when reviews happen
- Lower system resource usage (CPU, memory)

**Disadvantages**:
- Requires public endpoint with HTTPS
- Webhook delivery not guaranteed (network failures, GitHub downtime)
- No built-in retry if webhook handler crashes
- Configuration overhead (manual webhook setup per repo)

**Failure Modes**:
- GitHub webhook delivery service down → events lost until polling catches up
- Orchestrator server down during webhook → GitHub retries for 24h, then gives up
- HMAC signature mismatch → 401 response, GitHub marks webhook as failed

---

### Polling Approach

**Advantages**:
- 100% reliable (always catches events within poll cycle)
- No external dependencies (works offline, in dev environments)
- Can backfill missed events by scanning history
- Simpler configuration (no webhook setup needed)

**Disadvantages**:
- Higher latency (up to 1 min with default 60s poll interval)
- GitHub API rate limit consumption (3 calls/cycle for 3 repos)
- Constant CPU/memory usage (background loop running)
- Redundant work if no new events (wasted API calls)

---

### Hybrid Strategy (Recommended)

**Design**:
1. **Primary**: Webhooks for real-time detection
2. **Fallback**: Polling to catch missed webhook events
3. **Adaptive**: Increase poll frequency when webhooks go unhealthy

**Implementation**:
```typescript
class PrFeedbackMonitorService {
  private state = {
    webhookHealthy: true,
    lastWebhookEvent: null as number | null,
    currentPollIntervalMs: 60000,  // 1 min
    basePollIntervalMs: 60000,
  };

  recordWebhookEvent(): void {
    this.state.lastWebhookEvent = Date.now();
    this.state.webhookHealthy = true;

    // Restore normal poll interval
    this.state.currentPollIntervalMs = this.state.basePollIntervalMs;
  }

  private updateAdaptivePolling(): void {
    if (this.state.lastWebhookEvent === null) {
      return;  // no webhook data yet
    }

    const timeSinceLastWebhook = Date.now() - this.state.lastWebhookEvent;
    const unhealthyThreshold = this.state.basePollIntervalMs * 2;  // 2 min

    if (timeSinceLastWebhook > unhealthyThreshold && this.state.webhookHealthy) {
      // Webhooks appear down, increase poll frequency
      this.state.webhookHealthy = false;
      this.state.currentPollIntervalMs = Math.max(
        10000,  // min 10 sec
        Math.floor(this.state.basePollIntervalMs / 3)  // 20 sec for default 60s
      );

      logger.info(
        { newIntervalMs: this.state.currentPollIntervalMs },
        'Webhooks unhealthy, increasing poll frequency'
      );
    }
  }
}
```

**Benefits**:
- Best of both worlds: low latency when webhooks work, reliability from polling
- Automatic failover without manual intervention
- Gradual degradation (slower but still functional if webhooks fail)

---

## Redis Deduplication Patterns

### Problem: Webhook + Polling Race Condition

**Scenario**:
```
T+0s:  Webhook received, processing starts
T+1s:  Polling cycle starts (coincidentally)
T+1.5s: Polling fetches same PR, sees unresolved threads
T+2s:  Webhook processing completes, enqueues item
T+2.5s: Polling processing completes, enqueues same item ❌ DUPLICATE
```

**Solution**: Atomic deduplication using Redis

---

### Pattern 1: Check-and-Set with TTL

**Implementation**:
```typescript
async function enqueuePrFeedback(
  owner: string,
  repo: string,
  issueNumber: number,
  prNumber: number,
  threads: ReviewThread[]
): Promise<void> {
  const phase = 'address-pr-feedback';
  const dedupKey = `phase-tracker:${owner}:${repo}:${issueNumber}:${phase}`;

  // Atomic check
  const isDuplicate = await redis.exists(dedupKey);
  if (isDuplicate) {
    logger.info({ dedupKey }, 'Skipping duplicate PR feedback event');
    return;
  }

  // Enqueue item
  await queueAdapter.enqueue({ /* ... */ });

  // Atomic set with TTL
  await redis.set(dedupKey, '1', 'EX', 86400);  // 24h expiry
}
```

**Race Condition Handling**:
```
T+0s:  Webhook checks dedupKey → not exists
T+0s:  Polling checks dedupKey → not exists
T+1s:  Webhook sets dedupKey → exists
T+1.1s: Polling sets dedupKey → overwrites (harmless)
Result: Item enqueued once (both processes enqueue, but Redis dedup at claim time)
```

**Wait, that's still a race!** Need a better approach.

---

### Pattern 2: SET NX (Set If Not Exists)

**Better Implementation**:
```typescript
async function enqueuePrFeedback(
  owner: string,
  repo: string,
  issueNumber: number,
  prNumber: number,
  threads: ReviewThread[]
): Promise<void> {
  const phase = 'address-pr-feedback';
  const dedupKey = `phase-tracker:${owner}:${repo}:${issueNumber}:${phase}`;

  // Atomic check-and-set: returns 1 if key was set, 0 if already existed
  const wasSet = await redis.set(dedupKey, '1', 'EX', 86400, 'NX');

  if (!wasSet) {
    logger.info({ dedupKey }, 'Skipping duplicate PR feedback event');
    return;
  }

  // Only one process reaches here (atomic claim)
  await queueAdapter.enqueue({ /* ... */ });

  logger.info({ dedupKey, prNumber }, 'PR feedback enqueued');
}
```

**Race Condition Resolved**:
```
T+0s:  Webhook SET NX dedupKey → returns 1 (success)
T+0s:  Polling SET NX dedupKey → returns 0 (already exists)
T+1s:  Webhook enqueues item
T+1s:  Polling skips (wasSet = false)
Result: Item enqueued exactly once ✅
```

**Recommendation**: Use `SET key value EX ttl NX` for atomic deduplication

---

### Pattern 3: PhaseTracker Service (Existing)

**Current Implementation** (in `phase-tracker-service.ts`):
```typescript
async isDuplicate(owner: string, repo: string, issue: number, phase: string): Promise<boolean> {
  const key = `phase-tracker:${owner}:${repo}:${issue}:${phase}`;
  const exists = await redis.exists(key);
  return exists === 1;
}

async markProcessed(owner: string, repo: string, issue: number, phase: string): Promise<void> {
  const key = `phase-tracker:${owner}:${repo}:${issue}:${phase}`;
  await redis.set(key, '1', 'EX', this.ttlSeconds);
}
```

**Problem**: NOT atomic! (check then set, race window)

**Fix Needed** (for this feature):
```typescript
async tryMarkProcessed(owner: string, repo: string, issue: number, phase: string): Promise<boolean> {
  const key = `phase-tracker:${owner}:${repo}:${issue}:${phase}`;
  const result = await redis.set(key, '1', 'EX', this.ttlSeconds, 'NX');
  return result === 'OK';  // true if we won the race, false if duplicate
}
```

**Usage**:
```typescript
const wasMarked = await phaseTracker.tryMarkProcessed(owner, repo, issueNumber, 'address-pr-feedback');
if (!wasMarked) {
  logger.info('Duplicate detected, skipping');
  return;
}
// Guaranteed single processing
await queueAdapter.enqueue(item);
```

**Recommendation**: Add `tryMarkProcessed()` method to `PhaseTrackerService` for atomic deduplication

---

## Worker Branch Checkout Strategy

### Problem: Which Branch to Check Out?

**Scenario**: Issue #199 already has an implementation in progress
- Feature branch `199-pr-feedback-monitor` exists remotely
- PR #42 is open against `develop` branch
- PR has unresolved review comments
- Worker needs to make changes and push to PR branch

**Question**: Should worker check out default branch or PR branch?

---

### Option 1: Check Out Default Branch
```typescript
// Clone default branch (e.g., 'develop')
await repoCheckout.ensureCheckout(workerId, owner, repo, 'develop');

// Fetch PR branch
await exec(`git fetch origin ${prBranch}:${prBranch}`);

// Merge PR branch into default
await exec(`git merge ${prBranch}`);

// Make changes, commit
await cliSpawner.spawn(/* ... */);
await exec(`git commit -am "Address review feedback"`);

// Push to PR branch (force?)
await exec(`git push origin HEAD:${prBranch}`);
```

**Problems**:
- Merge conflicts if default branch has diverged
- Creates merge commit (noisy history)
- Force push might overwrite collaborator changes
- Complex, error-prone

---

### Option 2: Check Out PR Branch (Recommended)
```typescript
// Clone default branch first (for fresh checkout)
await repoCheckout.ensureCheckout(workerId, owner, repo, 'develop');

// Fetch and check out PR branch
await repoCheckout.switchBranch(checkoutPath, prBranch);

// Make changes, commit
await cliSpawner.spawn(/* ... */);
await exec(`git add . && git commit -m "Address review feedback"`);

// Push to PR branch (fast-forward)
await exec(`git push origin ${prBranch}`);
```

**Advantages**:
- Changes apply directly to PR state
- No merge conflicts (working on latest PR state)
- Fast-forward push (clean history)
- Reviewer sees changes in existing PR

**Implementation**:
```typescript
async function switchBranch(checkoutPath: string, branchName: string): Promise<void> {
  // Fetch remote branch
  await exec(`git fetch origin ${branchName}`, { cwd: checkoutPath });

  // Checkout branch (create local tracking branch if needed)
  try {
    await exec(`git checkout ${branchName}`, { cwd: checkoutPath });
  } catch (error) {
    // Branch doesn't exist locally, create tracking branch
    await exec(`git checkout -b ${branchName} origin/${branchName}`, { cwd: checkoutPath });
  }

  // Pull latest changes
  await exec(`git pull origin ${branchName}`, { cwd: checkoutPath });
}
```

**Recommendation**: Always check out PR branch when addressing feedback (Option 2)

---

## Review Thread Management

### GitHub Thread Model

**Thread Structure**:
```
Thread ID: abc123
  ├─ Initial Comment (by reviewer)
  │   "Please add error handling here"
  ├─ Reply 1 (by developer)
  │   "Good catch, will fix"
  ├─ Reply 2 (by agent) ← OUR REPLY
  │   "Added try-catch block with structured logging"
  └─ [Thread Resolution Status: unresolved]
```

**Key Points**:
- Thread = group of related comments on same code location
- Only one `isResolved` flag per thread (not per comment)
- Any participant can resolve/unresolve thread
- Agent must NOT resolve threads (leave for human reviewer)

---

### Fetching Unresolved Threads

**GraphQL Query** (recommended):
```typescript
async function fetchUnresolvedThreads(
  github: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number
): Promise<ReviewThread[]> {
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 1) {
                nodes {
                  id
                  body
                  path
                  line
                  author { login }
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = await github.graphql(query, { owner, repo, prNumber });

  return result.repository.pullRequest.reviewThreads.nodes
    .filter(thread => !thread.isResolved)
    .map(thread => ({
      id: extractNumericId(thread.id),  // convert GraphQL ID to REST ID
      path: thread.comments.nodes[0]?.path ?? null,
      line: thread.comments.nodes[0]?.line ?? null,
      body: thread.comments.nodes[0]?.body ?? '',
      resolved: thread.isResolved,
      reviewer: thread.comments.nodes[0]?.author.login ?? 'unknown',
    }));
}
```

**Why GraphQL**:
- Single query for all threads + resolution status
- REST API requires separate calls for thread status
- More efficient (1 call vs. N calls for N threads)

---

### Reply Strategy

**Single Reply Per Thread** (Q5 Answer: A):
```typescript
async function replyToThreads(
  github: GitHubClient,
  owner: string,
  repo: string,
  threads: ReviewThread[],
  cliOutput: string
): Promise<void> {
  for (const thread of threads) {
    try {
      // Generate reply based on CLI output
      const reply = generateReply(thread, cliOutput);

      // Post reply to thread
      await github.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        comment_id: thread.id,
        body: reply,
      });

      logger.info({ threadId: thread.id }, 'Replied to review thread');
    } catch (error) {
      // Don't fail entire job if one reply fails
      logger.warn({ err: error, threadId: thread.id }, 'Failed to reply to thread');
    }
  }
}
```

**Reply Generation**:
```typescript
function generateReply(thread: ReviewThread, cliOutput: string): string {
  // Extract relevant changes from CLI output
  // Simple approach: summarize changes made
  const summary = `✅ Addressed review feedback\n\n`;
  const changes = extractChangesForFile(cliOutput, thread.path);

  return summary + changes + '\n\n_This comment was posted by the Generacy agent._';
}
```

**Best Practices**:
- ✅ One reply per thread (clean conversation)
- ✅ Include summary of changes made
- ✅ Reference commit if helpful
- ❌ Don't spam multiple replies
- ❌ Don't resolve thread programmatically

---

## Adaptive Polling Implementation

### Health Tracking

**Webhook Health Metric**: Time since last webhook event

**States**:
1. **Healthy**: Webhook received within last 2× poll interval
2. **Unhealthy**: No webhook for > 2× poll interval

**Implementation**:
```typescript
interface MonitorState {
  webhookHealthy: boolean;
  lastWebhookEvent: number | null;  // Unix timestamp (ms)
  currentPollIntervalMs: number;
  basePollIntervalMs: number;
}

function updateAdaptivePolling(state: MonitorState): void {
  if (state.lastWebhookEvent === null) {
    // No webhook data yet, assume healthy
    return;
  }

  const timeSinceLastWebhook = Date.now() - state.lastWebhookEvent;
  const unhealthyThreshold = state.basePollIntervalMs * 2;

  if (timeSinceLastWebhook > unhealthyThreshold && state.webhookHealthy) {
    // Transition: healthy → unhealthy
    state.webhookHealthy = false;
    state.currentPollIntervalMs = Math.max(
      10000,  // min 10 seconds
      Math.floor(state.basePollIntervalMs / 3)  // 3x faster
    );

    logger.info(
      { timeSinceLastWebhook, newIntervalMs: state.currentPollIntervalMs },
      'Webhooks unhealthy, increasing poll frequency'
    );
  } else if (timeSinceLastWebhook <= unhealthyThreshold && !state.webhookHealthy) {
    // Transition: unhealthy → healthy
    state.webhookHealthy = true;
    state.currentPollIntervalMs = state.basePollIntervalMs;

    logger.info(
      { intervalMs: state.currentPollIntervalMs },
      'Webhooks recovered, restoring normal poll interval'
    );
  }
}
```

**Example Timeline**:
```
T+0s:   Poll interval: 60s, webhook healthy
T+60s:  Poll #1, no events
T+120s: Poll #2, webhook last seen 120s ago (> 2×60s threshold)
        → Unhealthy, interval → 20s
T+140s: Poll #3 (faster)
T+160s: Poll #4
T+165s: Webhook received!
        → Healthy, interval → 60s
T+225s: Poll #5 (back to normal)
```

**Benefits**:
- Automatic compensation for webhook failures
- Reduces detection latency when webhooks down
- Restores normal operation when webhooks recover
- No manual intervention required

---

## Error Handling and Retry Logic

### Error Categories

#### 1. Transient Errors (Retry)
- GitHub API rate limit exceeded → Wait until reset
- Network timeout → Retry with exponential backoff
- Redis connection lost → Retry with backoff

#### 2. Permanent Errors (Fail Fast)
- PR not found (deleted) → Skip, log warning
- Issue not found → Skip, log warning
- Issue not orchestrated → Skip, log info
- Invalid webhook signature → Return 401, log warning

#### 3. Partial Failures (Partial Success)
- Some review replies fail → Post successful ones, log warnings
- Worker timeout → Push partial changes, keep `waiting-for` label

---

### Retry Strategy for Worker

**Queue-Level Retry** (handled by `RedisQueueAdapter`):
```typescript
interface SerializedQueueItem extends QueueItem {
  attemptCount: number;  // incremented on release
}

async function release(workerId: string, item: QueueItem): Promise<void> {
  const attemptCount = item.attemptCount + 1;

  if (attemptCount >= this.maxRetries) {
    // Dead-letter: too many retries
    await redis.zadd(DEAD_LETTER_KEY, Date.now(), JSON.stringify(item));
    logger.warn({ item, attemptCount }, 'Item dead-lettered after max retries');
  } else {
    // Re-queue with same priority
    await redis.zadd(PENDING_KEY, item.priority, JSON.stringify({
      ...item,
      attemptCount,
    }));
    logger.info({ item, attemptCount }, 'Item released back to queue for retry');
  }
}
```

**Retry Limits**:
- `maxRetries`: 3 (configurable)
- After 3 failures → Dead-letter queue
- Manual intervention required for dead-lettered items

---

### Timeout Handling

**Worker Timeout** (Q7 Answer: A - partial completion):
```typescript
async function handlePrFeedback(context: WorkerContext, metadata: PrFeedbackMetadata): Promise<void> {
  const timeout = context.config.phaseTimeoutMs;  // 10 min default

  try {
    await cliSpawner.spawnWithTimeout(context, prompt, outputCapture, timeout);
  } catch (error) {
    if (error instanceof TimeoutError) {
      logger.warn({ prNumber: metadata.prNumber }, 'Worker timed out, saving partial progress');

      // Push whatever changes were made
      await pushChanges(context.checkoutPath, prBranch);

      // Reply to threads that were addressed (best effort)
      await replyToAddressedThreads(context, metadata, outputCapture);

      // Keep waiting-for label (will be retried)
      // Don't remove label here, let retry handle it

      // Re-throw to trigger queue release (retry)
      throw error;
    }

    // Other errors: also retry
    throw error;
  }

  // Success: remove waiting-for label
  await github.removeLabels(owner, repo, issueNumber, ['waiting-for:address-pr-feedback']);
}
```

**Benefits**:
- Partial work is not lost
- Reviewer sees incremental progress
- Retry picks up where it left off (fetches fresh threads)
- Eventually completes all feedback

---

### Reply Failure Handling

**Partial Success Strategy** (Q9 Answer: A):
```typescript
async function replyToThreads(
  github: GitHubClient,
  owner: string,
  repo: string,
  threads: ReviewThread[]
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;

  for (const thread of threads) {
    try {
      await github.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        comment_id: thread.id,
        body: generateReply(thread, cliOutput),
      });

      success++;
      logger.info({ threadId: thread.id }, 'Replied to review thread');
    } catch (error) {
      failed++;
      logger.warn({ err: error, threadId: thread.id }, 'Failed to reply to thread');
      // Continue to next thread
    }
  }

  if (failed > 0) {
    // Post summary comment on PR
    await github.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: `⚠️ Addressed review feedback, but failed to reply to ${failed}/${threads.length} threads. Changes are visible in the latest commit.`,
    });
  }

  return { success, failed };
}
```

**Outcome**:
- Changes are pushed (reviewer can see them)
- `waiting-for:address-pr-feedback` label removed (don't retry)
- Summary comment alerts reviewer to manual check replies
- Better than failing entire job and rolling back

---

## Performance Optimization

### Concurrency Limiting

**Semaphore Pattern** (from `LabelMonitorService`):
```typescript
class Semaphore {
  private count: number;
  private waiting: Array<() => void> = [];

  constructor(max: number) {
    this.count = max;
  }

  async acquire(): Promise<() => void> {
    if (this.count > 0) {
      this.count--;
      return () => this.release();
    }

    return new Promise<() => void>((resolve) => {
      this.waiting.push(() => {
        this.count--;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.count++;
    const next = this.waiting.shift();
    if (next) next();
  }
}
```

**Usage in Polling**:
```typescript
async function poll(): Promise<void> {
  const semaphore = new Semaphore(this.options.maxConcurrentPolls);  // 3
  const repos = this.options.repositories;

  const pollTasks = repos.map(({ owner, repo }) =>
    semaphore.acquire().then(async (release) => {
      try {
        await this.pollRepo(owner, repo);
      } finally {
        release();
      }
    })
  );

  await Promise.allSettled(pollTasks);
}
```

**Benefits**:
- Limits concurrent GitHub API calls to 3
- Prevents rate limit exhaustion
- Fair scheduling across repos
- Simple, no external dependencies

---

### Conditional Requests (Future Optimization)

**ETag Caching**:
```typescript
const cachedETag = cache.get(`pr-list:${owner}:${repo}`);

const response = await octokit.pulls.list({
  owner,
  repo,
  state: 'open',
  headers: cachedETag ? { 'If-None-Match': cachedETag } : {},
});

if (response.status === 304) {
  // Not modified, use cached data
  logger.debug({ owner, repo }, 'PR list not modified, skipping');
  return;
}

// Cache new ETag
cache.set(`pr-list:${owner}:${repo}`, response.headers.etag);
```

**Benefits**:
- Reduces API rate limit consumption
- Faster response times
- GitHub returns 304 if data unchanged

**Note**: Not implemented in initial version (can add later)

---

## Security Considerations

### Webhook Signature Verification

**HMAC-SHA256 Validation**:
```typescript
function verifySignature(
  secret: string | undefined,
  rawBody: string,
  signatureHeader: string | undefined
): boolean {
  if (!secret) {
    // Dev mode: no secret configured
    return true;
  }

  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const signature = signatureHeader.slice(7);  // remove 'sha256=' prefix
  const hmac = createHmac('sha256', secret).update(rawBody).digest('hex');

  // Timing-safe comparison prevents timing attacks
  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(hmac, 'hex'));
  } catch {
    return false;
  }
}
```

**Best Practices**:
- ✅ Use `timingSafeEqual()` to prevent timing attacks
- ✅ Parse raw body before JSON parsing (need original bytes)
- ✅ Return 401 on signature mismatch (not 200)
- ✅ Log invalid signatures (security monitoring)
- ❌ Don't log webhook secret in logs

---

### Rate Limit Protection

**Prevent Accidental DoS**:
```typescript
const MAX_THREADS_PER_PR = 100;

async function fetchUnresolvedThreads(
  github: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number
): Promise<ReviewThread[]> {
  const threads = await github.graphql(/* query */);

  if (threads.length > MAX_THREADS_PER_PR) {
    logger.warn(
      { prNumber, threadCount: threads.length },
      'PR has too many threads, truncating to prevent abuse'
    );
    return threads.slice(0, MAX_THREADS_PER_PR);
  }

  return threads;
}
```

**Benefits**:
- Prevents malicious PRs with 1000s of review comments
- Limits worker execution time
- Caps reply API calls

---

## Summary

This research document covered:

1. **GitHub API Integration**: Efficient use of REST and GraphQL endpoints
2. **PR-to-Issue Linking**: Dual-strategy approach (PR body + branch name)
3. **Webhook vs. Polling**: Hybrid strategy with adaptive failover
4. **Redis Deduplication**: Atomic SET NX pattern for race-free dedup
5. **Worker Branch Checkout**: Check out PR branch (not default branch)
6. **Review Thread Management**: GraphQL for thread status, single reply per thread
7. **Adaptive Polling**: Automatic frequency adjustment based on webhook health
8. **Error Handling**: Retry logic, partial completion, graceful degradation

**Key Takeaways**:
- Use GraphQL for thread resolution status (more efficient than REST)
- Atomic deduplication with `SET key value EX ttl NX` prevents webhook/poll races
- Checkout PR branch directly (not default branch + merge)
- Partial success is better than full rollback (push changes even if replies fail)
- Adaptive polling automatically compensates for webhook failures

---

*End of Technical Research Document*
