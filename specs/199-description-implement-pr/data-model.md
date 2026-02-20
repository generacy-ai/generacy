# Data Model: PR Feedback Monitor

This document describes the data models and type definitions used in the PR Feedback Monitor feature.

## Core Types

### QueueItem (Extended)

The `QueueItem` interface is extended to support the new `address-pr-feedback` command and PR-specific metadata.

```typescript
interface QueueItem {
  /** Repository owner (e.g., "generacy-ai") */
  owner: string;

  /** Repository name (e.g., "generacy") */
  repo: string;

  /** Issue number that this queue item processes */
  issueNumber: number;

  /** Workflow name (e.g., "speckit-feature", "speckit-bugfix") */
  workflowName: string;

  /**
   * Command type:
   * - 'process': Start new workflow from beginning
   * - 'continue': Resume workflow after gate completion
   * - 'address-pr-feedback': Address unresolved PR review comments (NEW)
   */
  command: 'process' | 'continue' | 'address-pr-feedback';

  /**
   * Priority score for queue ordering (lower = higher priority)
   * Typically a Unix timestamp in milliseconds for FIFO ordering
   */
  priority: number;

  /** ISO 8601 timestamp when this item was enqueued */
  enqueuedAt: string;

  /**
   * Optional metadata for command-specific data (NEW)
   * For 'address-pr-feedback' command, contains:
   *   - prNumber: PR number to address feedback for
   *   - reviewThreadIds: Array of review comment thread IDs
   */
  metadata?: Record<string, unknown>;
}
```

**Example - Address PR Feedback**:
```json
{
  "owner": "generacy-ai",
  "repo": "generacy",
  "issueNumber": 199,
  "workflowName": "speckit-feature",
  "command": "address-pr-feedback",
  "priority": 1709654321000,
  "enqueuedAt": "2024-03-05T14:32:01.000Z",
  "metadata": {
    "prNumber": 42,
    "reviewThreadIds": [123, 456, 789]
  }
}
```

### SerializedQueueItem (Extended)

Extended to support the new metadata field when serialized to Redis.

```typescript
interface SerializedQueueItem extends QueueItem {
  /** Number of times this item has been claimed and released (retry count) */
  attemptCount: number;

  /** Unique key for deduplication in the Redis sorted set */
  itemKey: string;

  /** Optional metadata (inherited from QueueItem, serialized to JSON) */
  metadata?: Record<string, unknown>;
}
```

**Redis Storage**:
- Stored in sorted set: `orchestrator:queue:pending`
- Score: `priority` field value
- Member: JSON-serialized `SerializedQueueItem`

---

## PR Monitor Types

### PrMonitorConfig

Configuration schema for the PR feedback monitor service.

```typescript
interface PrMonitorConfig {
  /** Whether PR monitoring is enabled (default: true) */
  enabled: boolean;

  /** Polling interval in milliseconds (default: 60000 = 1 minute) */
  pollIntervalMs: number;

  /**
   * Webhook secret for HMAC-SHA256 signature verification (optional)
   * If not provided, webhook signature verification is skipped (dev mode)
   * Can be shared with the issue label webhook secret
   */
  webhookSecret?: string;

  /**
   * Enable adaptive polling frequency based on webhook health (default: true)
   * When webhooks go unhealthy (no event received in 2x pollInterval),
   * the poll frequency increases to compensate
   */
  adaptivePolling: boolean;

  /**
   * Maximum concurrent GitHub API calls during polling (default: 3)
   * This limit applies across all watched repositories to prevent
   * overwhelming the GitHub API rate limit (5000 req/hr)
   */
  maxConcurrentPolls: number;
}
```

**Zod Schema**:
```typescript
export const PrMonitorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  pollIntervalMs: z.number().int().min(5000).default(60000),
  webhookSecret: z.string().optional(),
  adaptivePolling: z.boolean().default(true),
  maxConcurrentPolls: z.number().int().min(1).max(20).default(3),
});
```

**Environment Variables**:
```bash
PR_MONITOR_ENABLED=true
PR_MONITOR_POLL_INTERVAL_MS=60000
PR_MONITOR_ADAPTIVE_POLLING=true
PR_MONITOR_MAX_CONCURRENT_POLLS=3
# Webhook secret can be shared with issue webhook
WEBHOOK_SECRET=your-secret-here
```

---

### PrToIssueLink

Represents a successfully resolved link between a PR and an orchestrated issue.

```typescript
interface PrToIssueLink {
  /** Pull request number */
  prNumber: number;

  /** Linked issue number */
  issueNumber: number;

  /**
   * Method used to determine the link:
   * - 'pr-body': Extracted from PR description using closing keywords
   * - 'branch-name': Extracted from branch name pattern "{number}-{description}"
   */
  linkMethod: 'pr-body' | 'branch-name';
}
```

**Example**:
```json
{
  "prNumber": 42,
  "issueNumber": 199,
  "linkMethod": "pr-body"
}
```

**Linking Logic**:
1. **PR Body Parsing** (priority):
   - Search for closing keywords: `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved`
   - Pattern: `(close|closes|...) #(\d+)`
   - Returns first matched issue number

2. **Branch Name Parsing** (fallback):
   - Pattern: `^(\d+)-.*`
   - Example: `199-pr-feedback-monitor` → issue 199

3. **Preference**: PR body reference over branch name (as per FR-2)

---

### ReviewThread

Represents a review comment thread on a pull request.

```typescript
interface ReviewThread {
  /**
   * GitHub review comment ID
   * Used for replying to the thread via GitHub API
   */
  id: number;

  /**
   * File path for inline comments (e.g., "src/services/monitor.ts")
   * Null for general PR comments
   */
  path: string | null;

  /**
   * Line number for inline comments
   * Null for general PR comments
   */
  line: number | null;

  /** Comment body text (Markdown) */
  body: string;

  /**
   * Thread resolution status
   * false = unresolved (requires agent attention)
   * true = resolved (skip)
   */
  resolved: boolean;

  /** GitHub username of the reviewer who left the comment */
  reviewer: string;
}
```

**Example - Inline Comment**:
```json
{
  "id": 123456,
  "path": "packages/orchestrator/src/services/pr-monitor.ts",
  "line": 42,
  "body": "This logic should handle edge cases when the PR body is empty",
  "resolved": false,
  "reviewer": "code-reviewer"
}
```

**Example - General PR Comment**:
```json
{
  "id": 789012,
  "path": null,
  "line": null,
  "body": "Overall looks good, but please add tests for the new service",
  "resolved": false,
  "reviewer": "senior-dev"
}
```

**GitHub API Mapping**:
- Fetched from: `GET /repos/{owner}/{repo}/pulls/{pr}/comments`
- Reply endpoint: `POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/replies`
- **Never call**: `PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}` with `resolved: true`

---

### PrFeedbackMetadata

Metadata stored in `QueueItem.metadata` for the `address-pr-feedback` command.

```typescript
interface PrFeedbackMetadata {
  /** Pull request number to address feedback for */
  prNumber: number;

  /**
   * Array of review comment thread IDs that were unresolved at enqueue time
   * NOTE: This is a snapshot. The worker fetches fresh threads to handle
   * edge cases where threads are resolved between enqueue and processing.
   */
  reviewThreadIds: number[];
}
```

**Usage in Worker**:
```typescript
const metadata = item.metadata as PrFeedbackMetadata;
const prNumber = metadata.prNumber;

// Fetch fresh threads (don't trust stale metadata)
const threads = await fetchUnresolvedThreads(owner, repo, prNumber);
```

**Why Store ThreadIds?**:
- Debugging: Know which threads triggered the enqueue
- Observability: Log thread count in enqueue event
- Future: Could be used for partial retry if some threads fail

---

### PrReviewEvent

Internal event type passed between webhook handler and monitor service.

```typescript
interface PrReviewEvent {
  /** Repository owner */
  owner: string;

  /** Repository name */
  repo: string;

  /** Pull request number */
  prNumber: number;

  /** PR description body (for issue linking via closing keywords) */
  prBody: string;

  /** PR branch name (for issue linking via branch name pattern) */
  branchName: string;

  /** Source of detection */
  source: 'webhook' | 'poll';
}
```

**Webhook Flow**:
```typescript
// Webhook handler extracts event data from GitHub payload
const event: PrReviewEvent = {
  owner: payload.repository.owner.login,
  repo: payload.repository.name,
  prNumber: payload.pull_request.number,
  prBody: payload.pull_request.body,
  branchName: payload.pull_request.head.ref,
  source: 'webhook',
};

// Pass to monitor service for processing
await prMonitorService.processPrReviewEvent(event);
```

**Polling Flow**:
```typescript
// Polling loop fetches open PRs from GitHub API
const openPrs = await github.listPullRequests(owner, repo, { state: 'open' });

for (const pr of openPrs) {
  const event: PrReviewEvent = {
    owner,
    repo,
    prNumber: pr.number,
    prBody: pr.body,
    branchName: pr.head.ref,
    source: 'poll',
  };

  await prMonitorService.processPrReviewEvent(event);
}
```

---

## Webhook Payloads

### PR Review Submitted

**GitHub Event**: `pull_request_review.submitted`

**Relevant Payload Fields**:
```typescript
interface PrReviewWebhookPayload {
  action: 'submitted' | 'edited' | 'dismissed';

  review: {
    id: number;
    state: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
    body: string;
    user: {
      login: string;
    };
  };

  pull_request: {
    number: number;
    title: string;
    body: string;
    state: 'open' | 'closed';
    html_url: string;
    head: {
      ref: string; // branch name
    };
  };

  repository: {
    name: string;
    owner: {
      login: string;
    };
    full_name: string;
  };
}
```

**Processing Logic**:
- Only process `action: 'submitted'`
- Ignore review `state` (use thread resolution status instead)
- Extract `pull_request.number`, `pull_request.body`, `pull_request.head.ref`
- Link PR to issue via `PrLinker`
- Fetch review threads, filter for `resolved: false`

---

### PR Review Comment Created

**GitHub Event**: `pull_request_review_comment.created`

**Relevant Payload Fields**:
```typescript
interface PrReviewCommentWebhookPayload {
  action: 'created' | 'edited' | 'deleted';

  comment: {
    id: number;
    path: string;
    line: number;
    body: string;
    user: {
      login: string;
    };
  };

  pull_request: {
    number: number;
    body: string;
    head: {
      ref: string;
    };
  };

  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
}
```

**Processing Logic**:
- Only process `action: 'created'`
- Same flow as review submitted
- Fetch all threads (not just the new comment) to handle full context

---

## Redis Schema

### Phase Tracker Key

**Pattern**: `phase-tracker:{owner}:{repo}:{issue}:address-pr-feedback`

**Example**: `phase-tracker:generacy-ai:generacy:199:address-pr-feedback`

**Purpose**: Deduplication to prevent double-processing of the same PR feedback event

**Value**: `"1"` (presence indicates processed)

**TTL**: 24 hours (86400 seconds)

**Operations**:
```typescript
// Check if duplicate
const exists = await redis.exists('phase-tracker:generacy-ai:generacy:199:address-pr-feedback');

// Mark as processed (after enqueue)
await redis.set(
  'phase-tracker:generacy-ai:generacy:199:address-pr-feedback',
  '1',
  'EX',
  86400
);

// Clear (before re-enqueue, not used for address-pr-feedback)
await redis.del('phase-tracker:generacy-ai:generacy:199:address-pr-feedback');
```

**Why Use PhaseTracker**:
- Atomic check-and-set prevents race conditions
- Shared with label monitor deduplication logic
- TTL auto-expires after 24h (prevents stale keys)
- Works across webhook + polling paths

---

### Queue Keys

**Pending Queue**: `orchestrator:queue:pending` (Redis sorted set)
- Score: `QueueItem.priority` (timestamp for FIFO)
- Member: JSON-serialized `SerializedQueueItem`

**Claimed Queue**: `orchestrator:queue:claimed:{workerId}` (Redis hash)
- Field: `itemKey` (e.g., `generacy-ai/generacy#199`)
- Value: JSON-serialized `SerializedQueueItem`

**Heartbeat Key**: `orchestrator:worker:{workerId}:heartbeat` (Redis string)
- Value: `"1"`
- TTL: 30 seconds (refreshed by worker dispatcher)

**Dead Letter Queue**: `orchestrator:queue:dead-letter` (Redis sorted set)
- Items that exceeded `maxRetries` (default: 3)

---

## Label States

### Labels During PR Feedback Flow

**Initial State** (PR has unresolved comments):
```
phase:implement
agent:in-progress
```

**After Enqueue** (waiting for worker to address feedback):
```
phase:implement
agent:in-progress
waiting-for:address-pr-feedback  ← ADDED
```

**During Processing** (worker is addressing feedback):
```
phase:implement
agent:in-progress
waiting-for:address-pr-feedback
```

**After Completion** (feedback addressed):
```
phase:implement
agent:in-progress
# waiting-for:address-pr-feedback → REMOVED
```

**Optional Tracking Label** (not required):
```
phase:implement
agent:in-progress
completed:address-pr-feedback  ← OPTIONAL
```

**Key Points**:
- Phase labels (`phase:implement`) are **never changed** during PR feedback
- `agent:in-progress` remains throughout (PR feedback is part of implementation)
- Only `waiting-for:address-pr-feedback` is added/removed for tracking
- Worker does NOT transition to a new phase after addressing feedback

---

## Type Relationships Diagram

```
┌─────────────────────┐
│   QueueItem         │
│  (command: string)  │◄──────┐
└──────┬──────────────┘       │
       │                      │
       │ metadata             │
       ▼                      │
┌──────────────────────┐      │
│ PrFeedbackMetadata   │      │
│  - prNumber          │      │
│  - reviewThreadIds[] │      │
└──────────────────────┘      │
                              │
                              │
┌──────────────────────┐      │
│  PrReviewEvent       │      │
│  (webhook/poll data) │      │
└──────┬───────────────┘      │
       │                      │
       │ processPrReviewEvent()
       ▼                      │
┌──────────────────────┐      │
│  PrLinker            │      │
│  - parsePrBody()     │      │
│  - parseBranchName() │      │
└──────┬───────────────┘      │
       │                      │
       │ linkPrToIssue()      │
       ▼                      │
┌──────────────────────┐      │
│  PrToIssueLink       │      │
│  - prNumber          │      │
│  - issueNumber       │      │
│  - linkMethod        │      │
└──────┬───────────────┘      │
       │                      │
       │ fetchReviewThreads() │
       ▼                      │
┌──────────────────────┐      │
│  ReviewThread[]      │      │
│  - id, path, line    │      │
│  - body, resolved    │      │
│  - reviewer          │      │
└──────┬───────────────┘      │
       │                      │
       │ enqueue()            │
       └──────────────────────┘
```

---

## Migration Notes

### Backward Compatibility

**QueueItem Extension**:
- Existing queue items (with `command: 'process' | 'continue'`) remain valid
- `metadata` field is optional, so old items without it work fine
- Redis serialization handles missing `metadata` gracefully (deserialized as `undefined`)

**No Breaking Changes**:
- `RedisQueueAdapter` already handles unknown queue item fields
- `WorkerDispatcher` routes based on `command` field (new command is isolated)
- `ClaudeCliWorker` adds new handler branch without affecting existing flows

**Config Migration**:
- `prMonitor` config is optional (defaults to enabled)
- Can be disabled with `PR_MONITOR_ENABLED=false`
- No changes to existing `monitor` config (issue label monitoring)

---

## Example Data Flow

### Complete PR Feedback Flow

**1. PR Created**:
```
PR #42: "Implement PR feedback monitor"
Body: "Closes #199\n\nThis PR implements..."
Branch: 199-pr-feedback-monitor
```

**2. Review Submitted**:
```json
{
  "review": {
    "state": "changes_requested"
  },
  "pull_request": {
    "number": 42,
    "body": "Closes #199",
    "head": { "ref": "199-pr-feedback-monitor" }
  }
}
```

**3. Webhook Received** → `PrReviewEvent`:
```json
{
  "owner": "generacy-ai",
  "repo": "generacy",
  "prNumber": 42,
  "prBody": "Closes #199",
  "branchName": "199-pr-feedback-monitor",
  "source": "webhook"
}
```

**4. PR Linked to Issue** → `PrToIssueLink`:
```json
{
  "prNumber": 42,
  "issueNumber": 199,
  "linkMethod": "pr-body"
}
```

**5. Review Threads Fetched** → `ReviewThread[]`:
```json
[
  {
    "id": 123,
    "path": "src/services/monitor.ts",
    "line": 42,
    "body": "Add error handling for API failures",
    "resolved": false,
    "reviewer": "senior-dev"
  },
  {
    "id": 456,
    "path": "src/services/monitor.ts",
    "line": 87,
    "body": "Extract this logic into a helper function",
    "resolved": false,
    "reviewer": "senior-dev"
  }
]
```

**6. Queue Item Enqueued** → `QueueItem`:
```json
{
  "owner": "generacy-ai",
  "repo": "generacy",
  "issueNumber": 199,
  "workflowName": "speckit-feature",
  "command": "address-pr-feedback",
  "priority": 1709654321000,
  "enqueuedAt": "2024-03-05T14:32:01.000Z",
  "metadata": {
    "prNumber": 42,
    "reviewThreadIds": [123, 456]
  }
}
```

**7. Worker Claims Item**:
- Checkout branch `199-pr-feedback-monitor`
- Fetch fresh threads (still 2 unresolved)
- Build prompt with review comments
- Spawn Claude CLI

**8. Claude CLI Output**:
```
Added try-catch block in monitor.ts:42
Extracted helper function validatePrLink() in monitor.ts:87
```

**9. Worker Replies to Threads**:
- Thread 123: "Added error handling with try-catch block and structured logging"
- Thread 456: "Extracted logic into validatePrLink() helper function for reusability"

**10. Labels Updated**:
- Remove: `waiting-for:address-pr-feedback`
- Keep: `phase:implement`, `agent:in-progress`

**11. Workflow Continues**:
- Worker returns to normal phase loop
- Issue remains in `phase:implement`
- Next phase: validation or further implementation

---

*End of Data Model Documentation*
