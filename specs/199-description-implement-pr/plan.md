# Implementation Plan: PR Feedback Monitor

## Summary

This plan adds a **PR Feedback Monitor** to the orchestrator — a new service that detects unresolved review comments on PRs linked to orchestrated issues and triggers the feedback-addressing flow. The system uses a hybrid webhook + polling architecture (mirroring `LabelMonitorService`), integrates with the existing Redis queue and worker dispatcher, and extends `ClaudeCliWorker` with a new `address-pr-feedback` command that routes to a `PrFeedbackHandler`.

### Core Architecture

```
GitHub PR Review Events
        │
        ├─── Webhook: POST /webhooks/github/pr-review
        │         │
        │         ▼
        │    PrFeedbackMonitorService.processPrReviewEvent()
        │         │
        └─── Polling: list open PRs → check unresolved threads
                  │
                  ▼
             PrLinker.linkPrToIssue()
                  │ (PR body keywords → branch name fallback)
                  ▼
             PhaseTrackerService.tryMarkProcessed() [atomic dedup]
                  │
                  ▼
             RedisQueueAdapter.enqueue({ command: 'address-pr-feedback' })
                  │
                  ▼
             WorkerDispatcher → ClaudeCliWorker.handle()
                  │
                  ▼
             PrFeedbackHandler
                  ├── Checkout PR branch
                  ├── Fetch fresh unresolved threads
                  ├── Build prompt → spawn Claude CLI
                  ├── Push changes to PR branch
                  ├── Reply to each thread (never resolve)
                  └── Remove waiting-for:address-pr-feedback label
```

## Technical Context

| Aspect | Detail |
|--------|--------|
| Language | TypeScript (ES modules) |
| Server | Fastify |
| Queue | Redis sorted sets via `RedisQueueAdapter` |
| GitHub API | `gh` CLI via `GhCliGitHubClient` from `@generacy-ai/workflow-engine` |
| Deduplication | `PhaseTrackerService` (Redis `SET NX`) |
| Config | Zod schemas in `packages/orchestrator/src/config/schema.ts` |
| Testing | Vitest |

### Key Files (Existing)

| File | Role |
|------|------|
| `packages/orchestrator/src/types/monitor.ts` | `QueueItem`, `QueueAdapter`, `PhaseTracker` types |
| `packages/orchestrator/src/config/schema.ts` | `OrchestratorConfigSchema`, `MonitorConfigSchema` |
| `packages/orchestrator/src/services/label-monitor-service.ts` | Reference architecture (webhook+polling+adaptive) |
| `packages/orchestrator/src/services/phase-tracker-service.ts` | Redis deduplication |
| `packages/orchestrator/src/services/redis-queue-adapter.ts` | Queue enqueue/claim/complete |
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | Worker entry point — routes `process`/`continue` |
| `packages/orchestrator/src/worker/repo-checkout.ts` | Git clone/checkout/switch |
| `packages/orchestrator/src/routes/webhooks.ts` | Existing `POST /webhooks/github` for issue labels |
| `packages/orchestrator/src/server.ts` | Service initialization, lifecycle |
| `packages/workflow-engine/src/actions/github/client/interface.ts` | `GitHubClient` interface |
| `packages/workflow-engine/src/actions/github/label-definitions.ts` | `WORKFLOW_LABELS` |

### Key Files (New)

| File | Role |
|------|------|
| `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` | Core monitoring service |
| `packages/orchestrator/src/worker/pr-feedback-handler.ts` | Worker handler for `address-pr-feedback` |
| `packages/orchestrator/src/worker/pr-linker.ts` | PR-to-issue linking utility |
| `packages/orchestrator/src/routes/pr-webhooks.ts` | PR review webhook route |

---

## Implementation Phases

### Phase 1: Type Extensions and Configuration

**Goal**: Extend type system and configuration to support the new command and monitor.

#### 1.1 Extend `QueueItem` type

**File**: `packages/orchestrator/src/types/monitor.ts`

Add `'address-pr-feedback'` to the `command` union and an optional `metadata` field:

```typescript
export interface QueueItem {
  owner: string;
  repo: string;
  issueNumber: number;
  workflowName: string;
  command: 'process' | 'continue' | 'address-pr-feedback';
  priority: number;
  enqueuedAt: string;
  metadata?: Record<string, unknown>;
}
```

Add new types for PR feedback:

```typescript
export interface PrFeedbackMetadata {
  prNumber: number;
  reviewThreadIds: number[];
}

export interface PrReviewEvent {
  owner: string;
  repo: string;
  prNumber: number;
  prBody: string;
  branchName: string;
  source: 'webhook' | 'poll';
}

export interface PrToIssueLink {
  prNumber: number;
  issueNumber: number;
  linkMethod: 'pr-body' | 'branch-name';
}
```

#### 1.2 Add PR monitor configuration

**File**: `packages/orchestrator/src/config/schema.ts`

```typescript
export const PrMonitorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  pollIntervalMs: z.number().int().min(5000).default(60000),
  webhookSecret: z.string().optional(),
  adaptivePolling: z.boolean().default(true),
  maxConcurrentPolls: z.number().int().min(1).max(20).default(3),
});
export type PrMonitorConfig = z.infer<typeof PrMonitorConfigSchema>;
```

Add to `OrchestratorConfigSchema`:
```typescript
prMonitor: PrMonitorConfigSchema.default({}),
```

Add env var mapping in config loader for `PR_MONITOR_ENABLED`, `PR_MONITOR_POLL_INTERVAL_MS`, etc.

#### 1.3 Add label definition

**File**: `packages/workflow-engine/src/actions/github/label-definitions.ts`

The label `waiting-for:pr-feedback` already exists (line 37: `"Waiting to address PR feedback"`). The spec refers to `waiting-for:address-pr-feedback` — we will use a new label with that exact name to distinguish from the existing gate label:

```typescript
{ name: 'waiting-for:address-pr-feedback', color: 'FBCA04', description: 'Agent is addressing PR review feedback' },
```

**Rationale**: `waiting-for:pr-feedback` is the existing gate label that indicates a review is pending human action. `waiting-for:address-pr-feedback` specifically indicates the agent is actively addressing feedback. These are different states.

#### 1.4 Add `listOpenPullRequests` to `GitHubClient`

**File**: `packages/workflow-engine/src/actions/github/client/interface.ts`

The polling loop needs to list open PRs. The interface currently lacks this:

```typescript
listOpenPullRequests(owner: string, repo: string): Promise<PullRequest[]>;
```

**File**: `packages/workflow-engine/src/actions/github/client/gh-cli.ts`

Implement using `gh pr list --state open --json ...`.

**Acceptance Criteria**:
- TypeScript compiles without errors
- Existing queue items (without `metadata`) still deserialize correctly
- Config validation accepts both with and without `prMonitor` key
- `pnpm build` succeeds across all packages

---

### Phase 2: PR-to-Issue Linking

**Goal**: Implement reliable PR-to-issue linking using PR body keywords and branch naming patterns.

**File**: `packages/orchestrator/src/worker/pr-linker.ts` (NEW)

```typescript
export class PrLinker {
  /**
   * Regex for GitHub closing keywords.
   * Matches: close/closes/closed/fix/fixes/fixed/resolve/resolves/resolved #N
   * Case-insensitive, word-boundary aware.
   */
  private static readonly CLOSING_REGEX =
    /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)/gi;

  /**
   * Branch name pattern: {N}-{description}
   */
  private static readonly BRANCH_REGEX = /^(\d+)-/;

  /**
   * Parse PR body for closing keywords. Returns first matched issue number.
   */
  parsePrBody(body: string): number | null

  /**
   * Parse branch name for issue number prefix. Returns issue number or null.
   */
  parseBranchName(branch: string): number | null

  /**
   * Link a PR to its orchestrated issue.
   * Priority: PR body > branch name.
   * Verifies the linked issue has an agent:* label.
   */
  async linkPrToIssue(
    github: GitHubClient,
    owner: string,
    repo: string,
    pr: { number: number; body: string; head: { ref: string } }
  ): Promise<PrToIssueLink | null>
}
```

**Key behaviors**:
- First issue number from PR body keywords wins (Q1: B)
- Branch name fallback only when PR body has no match
- Verify linked issue has `agent:*` label (skip non-orchestrated)
- Return `null` for unlinked or non-orchestrated PRs

**Tests**: `packages/orchestrator/src/worker/__tests__/pr-linker.test.ts`
- Various closing keyword formats (case variations, multiple issues)
- Branch name parsing (standard, edge cases like dates)
- PR body priority over branch name
- Non-orchestrated issue filtering

**Acceptance Criteria**:
- > 95% linking accuracy on standard PR conventions (SC-002)
- Handles malformed bodies/branches gracefully (returns null)

---

### Phase 3: PR Feedback Monitor Service

**Goal**: Core monitoring service with webhook processing and polling fallback.

**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` (NEW)

Mirror `LabelMonitorService` architecture with these key differences:
- Polls open PRs (not issue labels)
- Checks review threads for `resolved: false`
- Uses `PrLinker` for PR-to-issue linking
- Enqueues `address-pr-feedback` command

```typescript
export class PrFeedbackMonitorService {
  constructor(
    logger: Logger,
    createClient: GitHubClientFactory,
    phaseTracker: PhaseTracker,
    queueAdapter: QueueAdapter,
    config: PrMonitorConfig,
    repositories: RepositoryConfig[],
  )

  /** Process a PR review event (shared by webhook and polling). */
  async processPrReviewEvent(event: PrReviewEvent): Promise<boolean>

  /** Start background polling loop. */
  async startPolling(): Promise<void>

  /** Stop polling (graceful shutdown). */
  stopPolling(): void

  /** Record webhook receipt for adaptive polling health. */
  recordWebhookEvent(): void

  /** Get current monitor state. */
  getState(): Readonly<MonitorState>
}
```

#### Polling Logic

```
For each watched repository (concurrency limited by semaphore):
  1. List open PRs via github.listOpenPullRequests()
  2. For each PR:
     a. Link to issue via PrLinker
     b. Skip if not linked or not orchestrated
     c. Fetch review comments via github.getPRComments()
     d. Filter for resolved === false
     e. If unresolved threads exist → enqueuePrFeedback()
  3. When multiple PRs exist for same issue → process most recent only (FR-015)
```

#### Enqueue Logic

```
1. Check dedup: phaseTracker.tryMarkProcessed(owner, repo, issue, 'address-pr-feedback')
   - Uses atomic SET NX to prevent webhook+poll race (Q8)
   - If already marked → skip (duplicate)
2. Resolve workflow name from issue labels (process:* or completed:*) (Q13/FR-014)
3. Build QueueItem with command: 'address-pr-feedback', metadata: { prNumber, reviewThreadIds }
4. Enqueue via queueAdapter.enqueue()
5. Add 'waiting-for:address-pr-feedback' label to issue (Q3: don't touch phase labels)
```

#### Adaptive Polling (Q18: mirror label monitor)

- Track `lastWebhookEvent` timestamp
- If no webhook in 2x `pollIntervalMs` → decrease interval by 50% (spec says 50%, not 3x)
- Reset to base interval when webhook received
- Minimum interval: 10 seconds

**Note on spec discrepancy**: FR-009 says "Mirror LabelMonitorService adaptive polling pattern" but US4 says "decrease by 50%". The label monitor divides by 3 (ADAPTIVE_DIVISOR = 3). Following US4 literally: use 50% reduction (divide by 2).

#### Atomic Deduplication

The current `PhaseTrackerService` uses non-atomic check-then-set (`isDuplicate` + `markProcessed`). Need to add an atomic method:

**File**: `packages/orchestrator/src/services/phase-tracker-service.ts` (EXTEND)

```typescript
/**
 * Atomically check and mark as processed.
 * Returns true if this call won the race (not a duplicate).
 * Returns false if already processed (duplicate).
 */
async tryMarkProcessed(
  owner: string, repo: string, issue: number, phase: string
): Promise<boolean> {
  if (!this.redis) return true; // degraded mode
  const key = buildKey(owner, repo, issue, phase);
  const result = await this.redis.set(key, '1', 'EX', this.ttlSeconds, 'NX');
  return result === 'OK';
}
```

**Acceptance Criteria**:
- Polling detects unresolved threads within one poll cycle (SC-003)
- Deduplication: 0 duplicate enqueues from concurrent webhook+poll (SC-004)
- Adaptive polling increases frequency when webhooks go unhealthy (US4)
- Graceful shutdown stops polling cleanly (US4)

---

### Phase 4: Webhook Route

**Goal**: Accept PR review webhook events on a dedicated endpoint.

**File**: `packages/orchestrator/src/routes/pr-webhooks.ts` (NEW)

```typescript
export interface PrWebhookRouteOptions {
  monitorService: PrFeedbackMonitorService;
  webhookSecret?: string;
  watchedRepos: Set<string>;
}

export async function setupPrWebhookRoutes(
  server: FastifyInstance,
  options: PrWebhookRouteOptions,
): Promise<void>
```

**Endpoint**: `POST /webhooks/github/pr-review`

**Event handling**:
- Verify HMAC-SHA256 signature (reuse `verifySignature` from `webhooks.ts`)
- Accept `pull_request_review.submitted` and `pull_request_review_comment.created`
- Check `X-GitHub-Event` header to determine event type
- Extract PR number, body, branch from payload
- Build `PrReviewEvent` and pass to `monitorService.processPrReviewEvent()`
- Record webhook event for adaptive polling health

**Auth**: Skip auth for this route (add `/webhooks/github/pr-review` to `skipRoutes` in auth middleware).

**Acceptance Criteria**:
- Webhook-to-enqueue latency < 500ms (SC-001)
- HMAC signature validation works
- Non-review events return 200 (don't trigger GitHub retries)

---

### Phase 5: PR Feedback Handler (Worker Extension)

**Goal**: Extend `ClaudeCliWorker` to handle the `address-pr-feedback` command.

#### 5.1 Create PrFeedbackHandler

**File**: `packages/orchestrator/src/worker/pr-feedback-handler.ts` (NEW)

```typescript
export class PrFeedbackHandler {
  constructor(
    private readonly config: WorkerConfig,
    private readonly logger: Logger,
    private readonly processFactory: ProcessFactory,
    private readonly sseEmitter?: SSEEventEmitter,
  )

  async handle(item: QueueItem, checkoutPath: string): Promise<void>
}
```

**Processing flow**:

1. **Extract metadata**: `const { prNumber } = item.metadata as PrFeedbackMetadata`
2. **Fetch PR**: `github.getPullRequest(owner, repo, prNumber)` → get branch name
3. **Checkout PR branch**: `repoCheckout.switchBranch(checkoutPath, pr.head.ref)` (Q11: A)
4. **Fetch fresh unresolved threads**: `github.getPRComments(owner, repo, prNumber)` → filter `resolved === false` (US2: fetch at processing time, not stale metadata)
5. **If no unresolved threads**: Remove label, return early
6. **Build feedback prompt**: Include all unresolved comments with file paths and line numbers
7. **Spawn Claude CLI**: Using existing `CliSpawner` with `phaseTimeoutMs` timeout
8. **Push changes**: Stage all, commit, push to PR branch
9. **Reply to threads**: `github.replyToPRComment()` for each thread (Q5: single reply per thread, never resolve)
10. **Remove label**: `github.removeLabels(owner, repo, issueNumber, ['waiting-for:address-pr-feedback'])`

**Error handling**:
- **Timeout** (Q7: A): Push partial changes, keep label, re-enqueue on next detection cycle
- **Reply failure** (Q9: A): Still remove label, log warnings for failed replies
- **Thread resolution** (SC-006): Never call resolve API — agent only replies

**SSE events** (Q20: A): Emit `workflow:started`, `workflow:progress`, `workflow:completed` with `command: 'address-pr-feedback'`.

#### 5.2 Extend ClaudeCliWorker.handle()

**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts` (EXTEND)

Add early routing for `address-pr-feedback` before the existing `process`/`continue` logic:

```typescript
async handle(item: QueueItem): Promise<void> {
  // ... existing setup (workerId, logger, SSE started event)

  if (item.command === 'address-pr-feedback') {
    const handler = new PrFeedbackHandler(
      this.config, workerLogger, this.processFactory, this.sseEmitter,
    );
    // Clone repo + checkout will be handled inside handler
    const defaultBranch = await this.repoCheckout.getDefaultBranch(item.owner, item.repo);
    const checkoutPath = await this.repoCheckout.ensureCheckout(
      workerId, item.owner, item.repo, defaultBranch,
    );
    await handler.handle(item, checkoutPath);
    return; // Early return — don't fall through to phase loop (FR-012)
  }

  // ... existing process/continue logic (unchanged)
}
```

**Acceptance Criteria**:
- Agent checks out PR branch (not default) (US2)
- Fresh unresolved threads fetched at processing time (US2)
- Prompt contains all comments with file paths and line numbers (US2)
- Changes committed and pushed to PR branch (US2)
- Single consolidated reply per thread (US2)
- Threads never auto-resolved (SC-006)
- `waiting-for:address-pr-feedback` removed on completion (US2)
- SSE events emitted for dashboard streaming (US5)

---

### Phase 6: Server Integration

**Goal**: Wire up the PR monitor service in server initialization and lifecycle.

**File**: `packages/orchestrator/src/server.ts` (EXTEND)

#### Initialization (after label monitor setup, ~line 188)

```typescript
let prFeedbackMonitorService: PrFeedbackMonitorService | null = null;
if (config.prMonitor.enabled && config.repositories.length > 0) {
  const prPhaseTracker = new PhaseTrackerService(server.log, redisClient);
  const prQueueAdapter = redisQueueAdapter ?? /* fallback logging adapter */;

  prFeedbackMonitorService = new PrFeedbackMonitorService(
    server.log,
    createGitHubClient,
    prPhaseTracker,
    prQueueAdapter,
    config.prMonitor,
    config.repositories,
  );
}
```

#### Route registration (after issue webhook routes, ~line 219)

```typescript
if (prFeedbackMonitorService) {
  const watchedRepos = new Set(config.repositories.map(r => `${r.owner}/${r.repo}`));
  await setupPrWebhookRoutes(server, {
    monitorService: prFeedbackMonitorService,
    webhookSecret: config.prMonitor.webhookSecret,
    watchedRepos,
  });
}
```

#### Auth skip routes

Add `/webhooks/github/pr-review` to `skipRoutes`:
```typescript
skipRoutes: ['/health', '/metrics', '/webhooks/github', '/webhooks/github/pr-review'],
```

#### Lifecycle hooks

**onReady** (~line 230):
```typescript
if (prFeedbackMonitorService) {
  prFeedbackMonitorService.startPolling().catch((error) => {
    server.log.error({ err: error }, 'PR feedback monitor polling failed');
  });
}
```

**Graceful shutdown** (~line 253):
```typescript
if (prFeedbackMonitorService) {
  prFeedbackMonitorService.stopPolling();
}
```

**Acceptance Criteria**:
- PR monitor starts polling on server ready (FR-016)
- Polling stops cleanly on shutdown (FR-016)
- Skip initialization when `prMonitor.enabled = false` (FR-016)
- No impact on existing label monitor or dispatcher

---

### Phase 7: Testing and Validation

**Goal**: Comprehensive testing to validate all functional requirements and success criteria.

#### Unit Tests

| Test Suite | File | Covers |
|-----------|------|--------|
| PrLinker | `worker/__tests__/pr-linker.test.ts` | PR body parsing, branch name parsing, link resolution, orchestration check |
| PrFeedbackMonitorService | `services/__tests__/pr-feedback-monitor-service.test.ts` | Polling, enqueue, dedup, adaptive polling, workflow name resolution |
| PrFeedbackHandler | `worker/__tests__/pr-feedback-handler.test.ts` | Branch checkout, prompt building, thread replies, label management, timeout |
| QueueItem metadata | `types/__tests__/monitor.test.ts` | Serialization, deserialization with metadata |
| PrMonitorConfig | `config/__tests__/schema.test.ts` | Config validation, defaults, env vars |

#### Integration Tests

| Test | Validates |
|------|-----------|
| Webhook → enqueue → worker → reply | End-to-end flow with mocked GitHub API |
| Polling fallback (no webhooks) | SC-003: polling detects within one cycle |
| Webhook + poll dedup race | SC-004: 0 duplicate enqueues |
| Worker timeout → partial completion | FR-013: push partial, keep label |
| Multiple PRs per issue | FR-015: process most recent only |
| Reply posting failure | FR-007: remove label, log warnings |

#### Success Criteria Validation

| ID | Metric | Target | Test Method |
|----|--------|--------|-------------|
| SC-001 | Webhook-to-enqueue latency | < 500ms | Timestamp delta in integration test |
| SC-002 | PR-to-issue linking accuracy | > 95% | Unit tests with 100+ PR format variations |
| SC-003 | Polling fallback coverage | 100% | Integration test: disable webhook, verify poll detects |
| SC-004 | Deduplication effectiveness | 0 duplicates | Concurrent webhook + poll test |
| SC-005 | Reply completeness | 100% | Verify all unresolved threads receive reply |
| SC-006 | Thread auto-resolve prevention | 0% | Verify `replyToPRComment` used (not resolve API) |

---

## Key Technical Decisions

### 1. Separate `PrFeedbackMonitorService` vs extending `LabelMonitorService`

**Decision**: Separate service (Q12: A, FR-016)

**Rationale**: PR review events and issue label events are fundamentally different event sources with different webhook types, polling strategies, and processing logic. Keeping them separate follows SRP, enables independent configuration (`prMonitor` vs `monitor`), and avoids bloating `LabelMonitorService` which is already 489 lines.

### 2. Atomic deduplication via `tryMarkProcessed`

**Decision**: Add `SET NX` method to `PhaseTrackerService`

**Rationale**: The existing `isDuplicate()` + `markProcessed()` pattern has a TOCTOU race between check and set. For PR feedback where webhook and poll may process the same PR simultaneously, atomic `SET key value EX ttl NX` guarantees exactly one winner. This is additive — existing code using `isDuplicate`/`markProcessed` is unaffected.

### 3. Reuse existing `GitHubClient` methods

**Decision**: Use `getPRComments()` and `replyToPRComment()` from existing interface

**Rationale**: The `GitHubClient` interface already has these methods implemented via `gh` CLI. The `Comment` type already has `path`, `line`, `in_reply_to_id`, and `resolved` fields. No need for GraphQL — the existing REST-based `gh api` calls provide thread resolution status.

**Missing**: Need to add `listOpenPullRequests()` to the interface and implement in `GhCliGitHubClient`.

### 4. Label naming: `waiting-for:address-pr-feedback`

**Decision**: Create new label (not reuse `waiting-for:pr-feedback`)

**Rationale**: The existing `waiting-for:pr-feedback` (line 37) serves as a general gate label meaning "PR needs human review feedback". The new `waiting-for:address-pr-feedback` specifically means "agent is actively addressing PR feedback". These are semantically different states — one is waiting for human action, the other is waiting for agent action.

### 5. Adaptive polling: 50% reduction vs 3x speedup

**Decision**: Follow spec US4 — decrease interval by 50% (divide by 2)

**Rationale**: The spec explicitly states "Polling interval decreases by 50%" (US4). The existing `LabelMonitorService` uses `ADAPTIVE_DIVISOR = 3` which is a 66% reduction. We follow the spec for this service since it's explicitly stated, though the difference is minor.

### 6. Prompt construction approach

**Decision**: Build a structured text prompt with all review comments

**Rationale**: The prompt includes all unresolved review comments with file paths, line numbers, and reviewer names. This gives Claude CLI full context to make targeted changes. The prompt instructs the agent to: make changes, commit, and reply to each thread — but never resolve threads.

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| GitHub API rate limits during polling | Medium | High | `maxConcurrentPolls=3` across repos, webhook-first approach |
| Webhook delivery failure | Medium | Medium | Polling fallback detects within one cycle, adaptive frequency increase |
| PR-to-issue linking failure | Medium | Medium | Dual strategy (body + branch), verify `agent:*` label, structured logging |
| Worker timeout on large PRs | Medium | Medium | Partial completion: push changes, keep label, retry next cycle (Q7) |
| Webhook + poll race condition | Medium | Low | Atomic `SET NX` dedup in PhaseTracker (Q8) |
| Reply posting failures | Low | Low | Partial success: remove label, log warnings, reviewer sees commits (Q9) |
| `listOpenPullRequests` not available | N/A | N/A | Add to GitHubClient interface + GhCliGitHubClient implementation |

---

## Deployment Notes

### GitHub Webhook Configuration

New webhook (in addition to existing issue webhook):
- **Payload URL**: `https://orchestrator.example.com/webhooks/github/pr-review`
- **Content type**: `application/json`
- **Secret**: Same as issue webhook secret (or separate)
- **Events**: `Pull request review`, `Pull request review comment`

### Environment Variables

```bash
PR_MONITOR_ENABLED=true              # default: true
PR_MONITOR_POLL_INTERVAL_MS=60000    # default: 60000 (1 min)
PR_MONITOR_ADAPTIVE_POLLING=true     # default: true
PR_MONITOR_MAX_CONCURRENT_POLLS=3    # default: 3
PR_MONITOR_WEBHOOK_SECRET=<secret>   # optional, for signature verification
```

### Rollout Strategy

1. Deploy with `PR_MONITOR_ENABLED=false` — validate server starts correctly
2. Enable with polling only (no webhook configured)
3. Configure webhook on test repository, validate end-to-end
4. Enable for production repositories

### Redis Changes

- New keys: `phase-tracker:{owner}:{repo}:{issue}:address-pr-feedback` (TTL: 24h)
- Queue items in `orchestrator:queue:pending` gain optional `metadata` field
- No migration needed (all changes are additive)

---

## Appendix: Clarification Answers Applied

| Q# | Answer | Implementation Impact |
|----|--------|----------------------|
| Q1 | B: First issue only | `PrLinker.parsePrBody()` returns first match |
| Q2 | A: Extend type union | `command: '...' \| 'address-pr-feedback'` |
| Q3 | A: Keep phase labels | Only add/remove `waiting-for:address-pr-feedback` |
| Q4 | A: Queue after current completes | PhaseTracker blocks re-enqueue while in progress |
| Q5 | A: Single reply per thread | One `replyToPRComment()` call per thread |
| Q6 | A: Process all in parallel | Each issue gets its own queue item |
| Q7 | A: Partial completion + retry | Push partial changes, keep label |
| Q8 | A: Redis dedup sufficient | Atomic `SET NX` in `tryMarkProcessed()` |
| Q9 | A: Partial success | Remove label, log warnings for failed replies |
| Q10 | A: Across all repos | `maxConcurrentPolls=3` global semaphore |
| Q11 | A: Checkout PR branch | `repoCheckout.switchBranch(checkoutPath, pr.head.ref)` |
| Q12 | A: New PrFeedbackMonitorService | Separate service class |
| Q13 | A: Read from issue labels | Query `process:*` or `completed:*` labels |
| Q14 | A: Most recent PR only | Sort by `updated_at`, take first |
| Q15 | A: Thread-only detection | Ignore review state, check `resolved: false` |
| Q16 | A: Extend QueueItem with metadata | `metadata?: Record<string, unknown>` |
| Q17 | A: Separate prMonitor config | `PrMonitorConfigSchema` in config |
| Q18 | A: Mirror label monitor | 50% interval decrease when webhooks unhealthy |
| Q19 | A: No gate integration | Early return in worker, no gate check |
| Q20 | A: Reuse workflow events | `workflow:started/progress/completed` SSE events |

---

*End of Implementation Plan*
