# Data Model: PR Feedback Monitor

This document describes the type definitions, configuration schema, and Redis key patterns for the PR Feedback Monitor feature.

## Type Changes

### QueueItem (Extended)

**File**: `packages/orchestrator/src/types/monitor.ts`

Two changes to the existing interface:

```typescript
export interface QueueItem {
  owner: string;
  repo: string;
  issueNumber: number;
  workflowName: string;
  command: 'process' | 'continue' | 'address-pr-feedback';  // EXTENDED
  priority: number;
  enqueuedAt: string;
  metadata?: Record<string, unknown>;  // NEW
}
```

| Change | Type | Backward Compatible |
|--------|------|---------------------|
| `command` union extended | Non-breaking (additive) | Yes — existing `'process'` and `'continue'` values unchanged |
| `metadata` field added | Non-breaking (optional) | Yes — existing items without metadata deserialize as `undefined` |

**SerializedQueueItem** inherits both changes via `extends QueueItem`. No additional changes needed — `RedisQueueAdapter` already serializes/deserializes the full object via `JSON.stringify`/`JSON.parse`, so `metadata` flows through automatically.

---

## New Types

### PrFeedbackMetadata

Shape of `QueueItem.metadata` when `command === 'address-pr-feedback'`:

```typescript
export interface PrFeedbackMetadata {
  /** PR number to address feedback for */
  prNumber: number;
  /** Review comment IDs that were unresolved at enqueue time (snapshot for debugging) */
  reviewThreadIds: number[];
}
```

**Usage**:
```typescript
// Enqueue
const item: QueueItem = {
  // ...
  command: 'address-pr-feedback',
  metadata: { prNumber: 42, reviewThreadIds: [123, 456] } satisfies PrFeedbackMetadata,
};

// Worker
const { prNumber } = item.metadata as PrFeedbackMetadata;
// Always fetch fresh threads — don't rely on stale reviewThreadIds
```

### PrReviewEvent

Internal event type passed between webhook/polling and the monitor service:

```typescript
export interface PrReviewEvent {
  owner: string;
  repo: string;
  prNumber: number;
  prBody: string;        // For issue linking via closing keywords
  branchName: string;    // For issue linking via branch name pattern
  source: 'webhook' | 'poll';
}
```

### PrToIssueLink

Result of successful PR-to-issue linking:

```typescript
export interface PrToIssueLink {
  prNumber: number;
  issueNumber: number;
  linkMethod: 'pr-body' | 'branch-name';
}
```

**Linking logic** (priority order):
1. PR body closing keywords: `(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved) #N`
2. Branch name pattern: `^(\d+)-`
3. Verify issue has `agent:*` label (skip non-orchestrated)

---

## Configuration Schema

### PrMonitorConfigSchema (New)

**File**: `packages/orchestrator/src/config/schema.ts`

```typescript
export const PrMonitorConfigSchema = z.object({
  /** Whether PR feedback monitoring is enabled */
  enabled: z.boolean().default(true),
  /** Polling interval in milliseconds */
  pollIntervalMs: z.number().int().min(5000).default(60000),
  /** Webhook secret for HMAC-SHA256 signature verification */
  webhookSecret: z.string().optional(),
  /** Enable adaptive polling based on webhook health */
  adaptivePolling: z.boolean().default(true),
  /** Max concurrent GitHub API calls during polling (across all repos) */
  maxConcurrentPolls: z.number().int().min(1).max(20).default(3),
});
export type PrMonitorConfig = z.infer<typeof PrMonitorConfigSchema>;
```

**Added to OrchestratorConfigSchema**:
```typescript
export const OrchestratorConfigSchema = z.object({
  // ... existing fields unchanged ...
  prMonitor: PrMonitorConfigSchema.default({}),  // NEW
});
```

**Environment variables**:
| Variable | Config Key | Default |
|----------|-----------|---------|
| `PR_MONITOR_ENABLED` | `prMonitor.enabled` | `true` |
| `PR_MONITOR_POLL_INTERVAL_MS` | `prMonitor.pollIntervalMs` | `60000` |
| `PR_MONITOR_WEBHOOK_SECRET` | `prMonitor.webhookSecret` | (none) |
| `PR_MONITOR_ADAPTIVE_POLLING` | `prMonitor.adaptivePolling` | `true` |
| `PR_MONITOR_MAX_CONCURRENT_POLLS` | `prMonitor.maxConcurrentPolls` | `3` |

---

## GitHubClient Extension

### listOpenPullRequests (New method)

**File**: `packages/workflow-engine/src/actions/github/client/interface.ts`

```typescript
export interface GitHubClient {
  // ... existing methods ...

  /** List open pull requests for a repository */
  listOpenPullRequests(owner: string, repo: string): Promise<PullRequest[]>;
}
```

**Implementation** (`gh-cli.ts`): Uses `gh pr list --state open --json number,title,body,state,isDraft,headRefName,baseRefName,labels,createdAt,updatedAt`.

---

## Label Definitions

### waiting-for:address-pr-feedback (New)

**File**: `packages/workflow-engine/src/actions/github/label-definitions.ts`

```typescript
{ name: 'waiting-for:address-pr-feedback', color: 'FBCA04', description: 'Agent is addressing PR review feedback' },
```

**Distinction from existing labels**:
| Label | Meaning |
|-------|---------|
| `waiting-for:pr-feedback` (existing, line 37) | Gate label — human review is pending |
| `waiting-for:address-pr-feedback` (new) | Agent is actively working on addressing feedback |

### Label State Transitions

```
Initial State (PR has unresolved comments):
  phase:implement, agent:in-progress

After Enqueue:
  phase:implement, agent:in-progress, waiting-for:address-pr-feedback  ← ADDED

After Completion:
  phase:implement, agent:in-progress  ← waiting-for:address-pr-feedback REMOVED

Key: Phase labels (phase:*, process:*) are NEVER modified during PR feedback flow.
```

---

## Redis Key Patterns

### Phase Tracker (Deduplication)

**Key**: `phase-tracker:{owner}:{repo}:{issue}:address-pr-feedback`

**Example**: `phase-tracker:generacy-ai:generacy:199:address-pr-feedback`

| Property | Value |
|----------|-------|
| Type | String |
| Value | `"1"` |
| TTL | 86400 seconds (24 hours) |
| Set method | `SET key "1" EX 86400 NX` (atomic, prevents race) |

**Lifecycle**:
1. PR feedback detected → `SET NX` wins → enqueue
2. Worker completes → key expires after 24h (or cleared for retry)
3. New feedback on same issue → detected after TTL expiry or explicit clear

### Queue Keys (Existing, unchanged)

| Key | Type | Purpose |
|-----|------|---------|
| `orchestrator:queue:pending` | Sorted Set | Pending queue items (score = priority) |
| `orchestrator:queue:claimed:{workerId}` | Hash | Items claimed by a worker |
| `orchestrator:worker:{workerId}:heartbeat` | String (TTL) | Worker liveness |
| `orchestrator:queue:dead-letter` | Sorted Set | Failed items after max retries |

Queue items with `metadata` are stored as JSON within these existing structures — no new keys needed.

---

## PhaseTrackerService Extension

### tryMarkProcessed (New method)

**File**: `packages/orchestrator/src/services/phase-tracker-service.ts`

```typescript
export interface PhaseTracker {
  isDuplicate(...): Promise<boolean>;      // existing
  markProcessed(...): Promise<void>;       // existing
  clear(...): Promise<void>;               // existing
  tryMarkProcessed(                        // NEW: atomic check-and-set
    owner: string, repo: string, issue: number, phase: string
  ): Promise<boolean>;
}
```

**Implementation**:
```typescript
async tryMarkProcessed(
  owner: string, repo: string, issue: number, phase: string
): Promise<boolean> {
  if (!this.redis) {
    this.logger.warn('Redis unavailable, allowing processing');
    return true;
  }
  const key = buildKey(owner, repo, issue, phase);
  const result = await this.redis.set(key, '1', 'EX', this.ttlSeconds, 'NX');
  return result === 'OK';
}
```

**Why**: The existing `isDuplicate()` + `markProcessed()` sequence has a TOCTOU race window. For the PR monitor where webhook and poll may fire simultaneously, `SET NX` guarantees exactly one winner.

---

## Example Data Flow

```
1. GitHub → Webhook: pull_request_review.submitted on PR #42
2. Route extracts PrReviewEvent:
   { owner: "org", repo: "app", prNumber: 42, prBody: "Closes #199", branchName: "199-feature", source: "webhook" }
3. PrLinker.parsePrBody("Closes #199") → issueNumber: 199
4. PrLinker.verifyOrchestrated(199) → true (has agent:in-progress label)
5. PhaseTracker.tryMarkProcessed("org", "app", 199, "address-pr-feedback") → true
6. Resolve workflow: issue labels include completed:specify → workflowName: "speckit-feature"
7. Enqueue QueueItem:
   { owner: "org", repo: "app", issueNumber: 199, workflowName: "speckit-feature",
     command: "address-pr-feedback", metadata: { prNumber: 42, reviewThreadIds: [101, 102] } }
8. Add label: waiting-for:address-pr-feedback on issue #199
9. WorkerDispatcher claims item → ClaudeCliWorker.handle()
10. PrFeedbackHandler:
    a. Checkout branch 199-feature
    b. Fetch fresh comments → 2 unresolved
    c. Build prompt → spawn Claude CLI
    d. Push changes to 199-feature
    e. Reply to thread 101, reply to thread 102
    f. Remove label: waiting-for:address-pr-feedback
11. Queue complete
```

---

*End of Data Model*
