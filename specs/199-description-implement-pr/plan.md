# Implementation Plan: PR Feedback Monitor for Orchestrated Issues

## Summary

This implementation adds a **PR Feedback Monitor** service that detects unresolved review comments on pull requests linked to orchestrated issues and automatically triggers a feedback-addressing workflow. The system uses a hybrid webhook + polling approach (mirroring the existing `LabelMonitorService`), integrates with the existing queue/worker infrastructure, and extends the `ClaudeCliWorker` to handle a new `address-pr-feedback` command.

### Key Design Decisions

1. **Separate Service Architecture**: Create `PrFeedbackMonitorService` as a standalone service (similar to `LabelMonitorService`) for clean separation of concerns
2. **Extend QueueItem Type**: Add `'address-pr-feedback'` to the command union and add optional `metadata` field for PR-specific data
3. **Webhook + Polling Hybrid**: Mirror the proven `LabelMonitorService` pattern with webhook reception and polling fallback
4. **Strict Thread-Based Detection**: Ignore review state, only process PRs with `resolved: false` threads for accuracy
5. **Worker Command Extension**: Handle `address-pr-feedback` as a new command type in `ClaudeCliWorker` with specialized checkout and reply logic

## Technical Context

**Language**: TypeScript
**Framework**: Fastify (REST API), Node.js
**Key Dependencies**:
- `@octokit/rest` - GitHub API client
- `ioredis` - Redis client for queue and deduplication
- `fastify` - Web framework for webhook routes
- `@generacy-ai/workflow-engine` - Label definitions and GitHub client

**Project Structure**:
```
packages/orchestrator/
├── src/
│   ├── services/
│   │   ├── pr-feedback-monitor-service.ts (NEW)
│   │   ├── label-monitor-service.ts (reference)
│   │   └── phase-tracker-service.ts (shared)
│   ├── worker/
│   │   ├── claude-cli-worker.ts (EXTEND)
│   │   ├── pr-feedback-handler.ts (NEW)
│   │   └── pr-linker.ts (NEW)
│   ├── types/
│   │   └── monitor.ts (EXTEND - QueueItem)
│   ├── config/
│   │   └── schema.ts (EXTEND - add prMonitor config)
│   ├── routes/
│   │   └── webhooks.ts (EXTEND - add PR review webhook)
│   └── server.ts (EXTEND - initialize PR monitor)
```

## Architecture Overview

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     GitHub Webhooks & Polling                    │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 │ PR Review Events
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│              PrFeedbackMonitorService                            │
│  ┌──────────────────┐          ┌──────────────────┐            │
│  │ Webhook Handler  │          │ Polling Loop     │            │
│  │ (Fastify Route)  │          │ (Background)     │            │
│  └────────┬─────────┘          └────────┬─────────┘            │
│           │                              │                       │
│           └──────────┬───────────────────┘                       │
│                      │                                           │
│                      ▼                                           │
│           ┌──────────────────────┐                              │
│           │   PrLinker           │ (PR-to-Issue Linking)        │
│           │  - PR body parsing   │                              │
│           │  - Branch name parse │                              │
│           └──────────┬───────────┘                              │
│                      │                                           │
│                      ▼                                           │
│           ┌──────────────────────┐                              │
│           │  Thread Detection    │ (GitHub API)                 │
│           │  resolved: false     │                              │
│           └──────────┬───────────┘                              │
└─────────────────────┼────────────────────────────────────────────┘
                      │
                      │ Enqueue if unresolved
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                  RedisQueueAdapter                               │
│  command: 'address-pr-feedback'                                  │
│  metadata: { prNumber, reviewThreadIds }                         │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 │ Claimed by dispatcher
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│              WorkerDispatcher                                    │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│             ClaudeCliWorker                                      │
│  ┌──────────────────────────────────────────────────────┐       │
│  │  handle(item: QueueItem)                             │       │
│  │    if (item.command === 'address-pr-feedback'):      │       │
│  │      → PrFeedbackHandler                             │       │
│  └────────────────────┬─────────────────────────────────┘       │
│                       │                                          │
│                       ▼                                          │
│           ┌───────────────────────┐                             │
│           │ PrFeedbackHandler     │                             │
│           │ - Checkout PR branch  │                             │
│           │ - Fetch threads       │                             │
│           │ - Build prompt        │                             │
│           │ - Spawn Claude CLI    │                             │
│           │ - Reply to threads    │                             │
│           │ - Update labels       │                             │
│           └───────────────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Event Detection**:
   - Webhook receives `pull_request_review.submitted` event → parse PR number & repo
   - OR Polling cycle lists open PRs → check each for unresolved threads

2. **PR-to-Issue Linking**:
   - Parse PR body for "Closes #N" keywords (priority)
   - Parse branch name for "{N}-description" pattern (fallback)
   - Query GitHub API to verify issue exists and has `agent:*` label

3. **Unresolved Thread Detection**:
   - Fetch review threads via GitHub API (`GET /repos/{owner}/{repo}/pulls/{pr}/comments`)
   - Filter for `resolved: false`
   - Skip if no unresolved threads exist

4. **Enqueue & Deduplication**:
   - Build `QueueItem` with `command: 'address-pr-feedback'` and `metadata: { prNumber, reviewThreadIds }`
   - Check `PhaseTrackerService` with key `phase-tracker:{owner}:{repo}:{issue}:address-pr-feedback`
   - If not duplicate: enqueue, add `waiting-for:address-pr-feedback` label to issue

5. **Worker Processing**:
   - `WorkerDispatcher` claims item from queue
   - `ClaudeCliWorker.handle()` routes to `PrFeedbackHandler` based on command
   - Handler checks out PR branch, fetches fresh threads, builds prompt
   - Spawns Claude CLI with feedback prompt
   - Pushes changes, replies to threads (without resolving), updates labels

## Implementation Phases

### Phase 1: Type Extensions and Configuration (Foundation)

**Goal**: Extend type definitions and configuration schema to support PR feedback monitoring.

**Files**:
- `packages/orchestrator/src/types/monitor.ts`
- `packages/orchestrator/src/config/schema.ts`

**Tasks**:
1. **Extend QueueItem type** (Q2 Answer: A):
   ```typescript
   export interface QueueItem {
     owner: string;
     repo: string;
     issueNumber: number;
     workflowName: string;
     command: 'process' | 'continue' | 'address-pr-feedback'; // EXTENDED
     priority: number;
     enqueuedAt: string;
     metadata?: Record<string, unknown>; // NEW (Q16 Answer: A)
   }
   ```

2. **Add PR monitor config schema** (Q17 Answer: A):
   ```typescript
   export const PrMonitorConfigSchema = z.object({
     enabled: z.boolean().default(true),
     pollIntervalMs: z.number().int().min(5000).default(60000),
     webhookSecret: z.string().optional(), // shared with issue webhook
     adaptivePolling: z.boolean().default(true),
     maxConcurrentPolls: z.number().int().min(1).max(20).default(3),
   });
   export type PrMonitorConfig = z.infer<typeof PrMonitorConfigSchema>;

   // Extend OrchestratorConfigSchema
   export const OrchestratorConfigSchema = z.object({
     // ... existing fields
     prMonitor: PrMonitorConfigSchema.default({}), // NEW
   });
   ```

3. **Add PR-specific types**:
   ```typescript
   export interface PrToIssueLink {
     prNumber: number;
     issueNumber: number;
     linkMethod: 'pr-body' | 'branch-name';
   }

   export interface ReviewThread {
     id: number;
     path: string | null;
     line: number | null;
     body: string;
     resolved: boolean;
     reviewer: string;
   }

   export interface PrFeedbackMetadata {
     prNumber: number;
     reviewThreadIds: number[];
   }
   ```

**Acceptance Criteria**:
- [ ] TypeScript compiles without errors
- [ ] Config validation tests pass
- [ ] `metadata` field is properly serialized/deserialized in `RedisQueueAdapter`

---

### Phase 2: PR-to-Issue Linking Utility

**Goal**: Implement reliable PR-to-issue linking using PR body references and branch naming conventions.

**Files**:
- `packages/orchestrator/src/worker/pr-linker.ts` (NEW)
- `packages/orchestrator/src/worker/__tests__/pr-linker.test.ts` (NEW)

**Tasks**:
1. **Implement PrLinker class**:
   ```typescript
   export class PrLinker {
     private static readonly CLOSING_KEYWORDS = [
       'close', 'closes', 'closed',
       'fix', 'fixes', 'fixed',
       'resolve', 'resolves', 'resolved'
     ];

     /**
      * Extract issue numbers from PR body using GitHub closing keywords.
      * Returns first matched issue number or null.
      */
     parsePrBody(prBody: string): number | null;

     /**
      * Extract issue number from branch name (e.g., "199-feature-name" → 199).
      * Returns issue number or null.
      */
     parseBranchName(branchName: string): number | null;

     /**
      * Link PR to issue using both methods (Q1 Answer: B - first issue only).
      * Prefer PR body reference over branch name (FR-2).
      */
     async linkPrToIssue(
       github: GitHubClient,
       owner: string,
       repo: string,
       pr: { number: number; body: string; head: { ref: string } }
     ): Promise<PrToIssueLink | null>;

     /**
      * Verify that the linked issue is orchestrated (has agent:* label).
      */
     async verifyOrchestrated(
       github: GitHubClient,
       owner: string,
       repo: string,
       issueNumber: number
     ): Promise<boolean>;
   }
   ```

2. **Write comprehensive tests**:
   - PR body parsing with various closing keywords
   - Branch name parsing (valid/invalid formats)
   - Link resolution priority (body over branch)
   - Edge cases (multiple issues, no match, invalid formats)

**Acceptance Criteria**:
- [ ] Unit tests cover >90% of PrLinker code
- [ ] Handles malformed PR bodies and branch names gracefully
- [ ] Returns null for non-orchestrated issues

---

### Phase 3: PR Feedback Monitor Service

**Goal**: Create the core monitoring service that detects PR feedback events via webhooks and polling.

**Files**:
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` (NEW)
- `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts` (NEW)

**Tasks**:
1. **Implement PrFeedbackMonitorService** (Q12 Answer: A - separate service):
   ```typescript
   export class PrFeedbackMonitorService {
     private readonly logger: Logger;
     private readonly createClient: GitHubClientFactory;
     private readonly phaseTracker: PhaseTracker;
     private readonly queueAdapter: QueueAdapter;
     private readonly prLinker: PrLinker;
     private readonly options: PrMonitorOptions;
     private abortController: AbortController | null = null;
     private state: MonitorState; // reuse type from label monitor

     constructor(/* deps */);

     /**
      * Start polling loop (background task).
      */
     async startPolling(): Promise<void>;

     /**
      * Stop polling loop (graceful shutdown).
      */
     stopPolling(): void;

     /**
      * Process a PR review event (shared by webhook and polling).
      * Q15 Answer: A - only check resolved: false threads, ignore review state.
      */
     async processPrReviewEvent(event: PrReviewEvent): Promise<boolean>;

     /**
      * Record webhook event for adaptive polling health tracking.
      * Q18 Answer: A - mirror label monitor logic.
      */
     recordWebhookEvent(): void;

     /**
      * Get monitor state (for observability).
      */
     getState(): Readonly<MonitorState>;
   }
   ```

2. **Implement polling logic** (Q6 Answer: A, Q10 Answer: A):
   ```typescript
   private async poll(): Promise<void> {
     const semaphore = new Semaphore(this.options.maxConcurrentPolls); // 3 total
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

   private async pollRepo(owner: string, repo: string): Promise<void> {
     const client = this.createClient();
     const openPrs = await client.listPullRequests(owner, repo, { state: 'open' });

     for (const pr of openPrs) {
       const link = await this.prLinker.linkPrToIssue(client, owner, repo, pr);
       if (!link) continue; // not orchestrated

       const threads = await this.fetchReviewThreads(client, owner, repo, pr.number);
       const unresolvedThreads = threads.filter(t => !t.resolved);

       if (unresolvedThreads.length > 0) {
         await this.enqueuePrFeedback(owner, repo, link.issueNumber, pr.number, unresolvedThreads);
       }
     }
   }
   ```

3. **Implement enqueue logic** (Q4 Answer: A, Q8 Answer: A):
   ```typescript
   private async enqueuePrFeedback(
     owner: string,
     repo: string,
     issueNumber: number,
     prNumber: number,
     threads: ReviewThread[]
   ): Promise<void> {
     const phase = 'address-pr-feedback';

     // Deduplication (Q8: Redis handles race conditions)
     const isDuplicate = await this.phaseTracker.isDuplicate(owner, repo, issueNumber, phase);
     if (isDuplicate) {
       this.logger.info({ owner, repo, issueNumber, prNumber }, 'Skipping duplicate PR feedback event');
       return;
     }

     // Determine workflow name (Q13 Answer: A - read from labels)
     const workflowName = await this.resolveWorkflowName(owner, repo, issueNumber);

     const queueItem: QueueItem = {
       owner,
       repo,
       issueNumber,
       workflowName,
       command: 'address-pr-feedback',
       priority: Date.now(), // FIFO
       enqueuedAt: new Date().toISOString(),
       metadata: {
         prNumber,
         reviewThreadIds: threads.map(t => t.id),
       },
     };

     await this.queueAdapter.enqueue(queueItem);
     await this.phaseTracker.markProcessed(owner, repo, issueNumber, phase);

     // Add waiting label to issue (Q3 Answer: A - don't change phase labels)
     const client = this.createClient();
     await client.addLabels(owner, repo, issueNumber, ['waiting-for:address-pr-feedback']);

     this.logger.info({ owner, repo, issueNumber, prNumber }, 'PR feedback enqueued');
   }
   ```

**Acceptance Criteria**:
- [ ] Polling detects unresolved threads within one poll cycle
- [ ] Deduplication prevents double-enqueue from webhook + poll race
- [ ] Adaptive polling increases frequency when webhooks go unhealthy
- [ ] Graceful shutdown stops polling without data loss

---

### Phase 4: Webhook Route Extension

**Goal**: Extend the webhook route handler to accept PR review events.

**Files**:
- `packages/orchestrator/src/routes/webhooks.ts` (EXTEND)

**Tasks**:
1. **Add PR review webhook handler**:
   ```typescript
   server.post(
     '/webhooks/github/pr-review',
     {},
     async (request: FastifyRequest, reply: FastifyReply) => {
       const body = request.body as { parsed: unknown; raw: string };
       const rawBody = body.raw;
       const payload = body.parsed as PrReviewWebhookPayload;

       // Verify signature (shared webhookSecret)
       const signatureHeader = request.headers['x-hub-signature-256'] as string | undefined;
       if (!verifySignature(webhookSecret, rawBody, signatureHeader)) {
         server.log.warn('Invalid PR webhook signature');
         return reply.status(401).send({ error: 'Invalid signature' });
       }

       // Only handle review submitted/comment created events
       if (!['pull_request_review.submitted', 'pull_request_review_comment.created'].includes(payload.action)) {
         return reply.status(200).send({ status: 'ignored', reason: 'not a review event' });
       }

       // Verify watched repository
       const repoKey = `${payload.repository.owner.login}/${payload.repository.name}`;
       if (!watchedRepos.has(repoKey)) {
         return reply.status(200).send({ status: 'ignored', reason: 'not a watched repository' });
       }

       // Record webhook health
       prMonitorService.recordWebhookEvent();

       // Process the review event
       const processed = await prMonitorService.processPrReviewEvent({
         owner: payload.repository.owner.login,
         repo: payload.repository.name,
         prNumber: payload.pull_request.number,
         prBody: payload.pull_request.body,
         branchName: payload.pull_request.head.ref,
         source: 'webhook',
       });

       return reply.status(200).send({ status: processed ? 'processed' : 'ignored' });
     }
   );
   ```

**Acceptance Criteria**:
- [ ] Webhook accepts `pull_request_review.submitted` events
- [ ] Webhook signature validation works (same secret as issue webhook)
- [ ] Ignored events return 200 status (don't trigger retries)
- [ ] Latency < 500ms from event receipt to enqueue (SC-001)

---

### Phase 5: PR Feedback Handler (Worker Extension)

**Goal**: Extend `ClaudeCliWorker` to handle the `address-pr-feedback` command.

**Files**:
- `packages/orchestrator/src/worker/pr-feedback-handler.ts` (NEW)
- `packages/orchestrator/src/worker/claude-cli-worker.ts` (EXTEND)
- `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts` (NEW)

**Tasks**:
1. **Implement PrFeedbackHandler** (Q11 Answer: A - checkout PR branch):
   ```typescript
   export class PrFeedbackHandler {
     constructor(
       private readonly config: WorkerConfig,
       private readonly logger: Logger,
       private readonly processFactory: ProcessFactory,
       private readonly sseEmitter?: SSEEventEmitter,
     ) {}

     /**
      * Handle address-pr-feedback command.
      * Q7 Answer: A - partial completion with retry on timeout.
      */
     async handle(context: WorkerContext, metadata: PrFeedbackMetadata): Promise<void> {
       const { owner, repo, issueNumber } = context.item;
       const { prNumber } = metadata;

       // 1. Fetch PR to get branch name
       const pr = await context.github.getPullRequest(owner, repo, prNumber);
       const branchName = pr.head.ref;

       // 2. Checkout PR branch (Q11 Answer: A)
       const repoCheckout = new RepoCheckout(this.config.workspaceDir, this.logger);
       await repoCheckout.switchBranch(context.checkoutPath, branchName);

       // 3. Fetch fresh unresolved threads (ignore stale metadata)
       const threads = await this.fetchUnresolvedThreads(context.github, owner, repo, prNumber);

       if (threads.length === 0) {
         this.logger.info({ prNumber }, 'No unresolved threads, skipping');
         await this.completeWithoutChanges(context);
         return;
       }

       // 4. Build feedback prompt
       const prompt = this.buildFeedbackPrompt(threads, pr.html_url);

       // 5. Spawn Claude CLI with timeout
       const cliSpawner = new CliSpawner(this.processFactory, this.logger, this.config.shutdownGracePeriodMs);
       const outputCapture = new OutputCapture(this.logger, this.sseEmitter, context);

       try {
         await cliSpawner.spawnWithTimeout(
           context,
           ['--prompt', prompt],
           outputCapture,
           this.config.phaseTimeoutMs, // 10 min default
         );
       } catch (error) {
         // Timeout or failure (Q7: partial completion)
         this.logger.warn({ err: error, prNumber }, 'PR feedback addressing timed out or failed');
         // Don't remove waiting label - re-enqueue will happen
         throw error;
       }

       // 6. Push changes to PR branch
       await this.pushChanges(context.checkoutPath, branchName);

       // 7. Reply to review threads (Q5 Answer: A - single reply per thread)
       await this.replyToThreads(context.github, owner, repo, threads, outputCapture.getOutput());

       // 8. Update labels (Q3 Answer: A - don't change phase labels)
       await context.github.removeLabels(owner, repo, issueNumber, ['waiting-for:address-pr-feedback']);
       // Optional: await context.github.addLabels(owner, repo, issueNumber, ['completed:address-pr-feedback']);

       this.logger.info({ prNumber }, 'PR feedback addressed successfully');
     }

     /**
      * Build prompt for Claude CLI with review feedback.
      */
     private buildFeedbackPrompt(threads: ReviewThread[], prUrl: string): string {
       let prompt = `You are addressing PR review feedback. Read the comments below, make the necessary changes, and reply to each comment explaining what you changed. Never resolve the threads yourself.\n\n`;
       prompt += `PR: ${prUrl}\n\n`;
       prompt += `Review Comments:\n`;

       for (const thread of threads) {
         prompt += `\n---\n`;
         prompt += `Reviewer: ${thread.reviewer}\n`;
         if (thread.path) {
           prompt += `File: ${thread.path}:${thread.line}\n`;
         }
         prompt += `Comment: ${thread.body}\n`;
       }

       return prompt;
     }

     /**
      * Reply to review threads via GitHub API.
      * Q9 Answer: A - mark as partial success if reply fails.
      */
     private async replyToThreads(
       github: GitHubClient,
       owner: string,
       repo: string,
       threads: ReviewThread[],
       cliOutput: string,
     ): Promise<void> {
       for (const thread of threads) {
         try {
           const reply = this.generateReply(thread, cliOutput);
           await github.replyToReviewComment(owner, repo, thread.id, reply);
           this.logger.info({ threadId: thread.id }, 'Replied to review thread');
         } catch (error) {
           this.logger.warn({ err: error, threadId: thread.id }, 'Failed to reply to review thread');
           // Continue to next thread (partial success)
         }
       }
     }
   }
   ```

2. **Extend ClaudeCliWorker.handle()**:
   ```typescript
   async handle(item: QueueItem): Promise<void> {
     // ... existing setup

     if (item.command === 'address-pr-feedback') {
       const metadata = item.metadata as PrFeedbackMetadata;
       const handler = new PrFeedbackHandler(
         this.config,
         workerLogger,
         this.processFactory,
         this.sseEmitter,
       );
       await handler.handle(context, metadata);
       return;
     }

     // ... existing process/continue logic
   }
   ```

**Acceptance Criteria**:
- [ ] Worker checks out PR branch before running Claude CLI
- [ ] Unresolved threads are fetched fresh (not from stale metadata)
- [ ] Prompt includes all review comments with file paths
- [ ] Claude CLI is spawned with feedback prompt
- [ ] Changes are pushed to PR branch
- [ ] Review threads receive agent replies (Q5: single reply per thread)
- [ ] Threads are NOT auto-resolved (SC-006: 0% auto-resolved)
- [ ] Labels are updated correctly (Q3: keep phase labels unchanged)
- [ ] SSE events are emitted (Q20 Answer: A - reuse workflow events)

---

### Phase 6: Server Integration

**Goal**: Wire up the PR monitor service in the server initialization flow.

**Files**:
- `packages/orchestrator/src/server.ts` (EXTEND)

**Tasks**:
1. **Initialize PrFeedbackMonitorService**:
   ```typescript
   // After label monitor initialization
   let prFeedbackMonitorService: PrFeedbackMonitorService | null = null;
   if (config.prMonitor.enabled && config.repositories.length > 0) {
     const phaseTracker = new PhaseTrackerService(server.log, redisClient);
     const queueAdapter = redisQueueAdapter ?? /* fallback */;

     prFeedbackMonitorService = new PrFeedbackMonitorService(
       server.log,
       createGitHubClient,
       phaseTracker,
       queueAdapter,
       config.prMonitor,
       config.repositories,
     );
   }
   ```

2. **Register webhook routes**:
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

3. **Start polling on server ready**:
   ```typescript
   server.addHook('onReady', async () => {
     // ... existing label monitor polling

     if (prFeedbackMonitorService) {
       prFeedbackMonitorService.startPolling().catch((error) => {
         server.log.error({ err: error }, 'PR feedback monitor polling failed');
       });
     }
   });
   ```

4. **Graceful shutdown**:
   ```typescript
   setupGracefulShutdown(server, {
     cleanup: [
       async () => {
         // ... existing cleanup

         if (prFeedbackMonitorService) {
           prFeedbackMonitorService.stopPolling();
         }
       },
     ],
   });
   ```

**Acceptance Criteria**:
- [ ] PR monitor starts polling when server is ready
- [ ] Polling stops gracefully on server shutdown
- [ ] No memory leaks or hanging connections
- [ ] Works correctly when `prMonitor.enabled = false`

---

### Phase 7: Testing & Validation

**Goal**: Comprehensive testing to validate all functional and non-functional requirements.

**Files**:
- `packages/orchestrator/src/__tests__/integration/pr-feedback-flow.test.ts` (NEW)
- Update all unit tests for modified components

**Tasks**:
1. **Unit Tests**:
   - `PrLinker`: PR body parsing, branch name parsing, link resolution
   - `PrFeedbackMonitorService`: polling, enqueue logic, deduplication
   - `PrFeedbackHandler`: prompt building, thread replies, label management
   - `ClaudeCliWorker`: command routing for `address-pr-feedback`

2. **Integration Tests**:
   - End-to-end flow: webhook → enqueue → worker → reply
   - Polling fallback when webhooks are disabled
   - Deduplication across webhook + poll paths
   - Timeout handling (partial completion)
   - Multiple PRs for same issue (Q14 Answer: A - most recent only)

3. **Load Tests**:
   - Concurrency limit enforcement (`maxConcurrentPolls = 3`)
   - Queue depth under high PR review volume
   - Rate limit handling (pause when GitHub rate limit hit)

4. **Manual Validation**:
   - SC-002: PR-to-issue linking accuracy > 95%
   - SC-005: 100% of unresolved comments receive agent reply
   - SC-006: 0% of threads auto-resolved by agent

**Acceptance Criteria**:
- [ ] All unit tests pass with >85% coverage
- [ ] Integration tests cover happy path and error scenarios
- [ ] Success criteria SC-001 through SC-006 validated
- [ ] No regressions in existing label monitor or worker flows

---

## API Contracts

### Webhook Payload Schema

**Endpoint**: `POST /webhooks/github/pr-review`

**Headers**:
- `X-Hub-Signature-256`: HMAC-SHA256 signature for verification
- `X-GitHub-Event`: `pull_request_review` or `pull_request_review_comment`

**Payload** (example for `pull_request_review.submitted`):
```json
{
  "action": "submitted",
  "review": {
    "id": 123456,
    "state": "changes_requested",
    "body": "Please fix the validation logic"
  },
  "pull_request": {
    "number": 42,
    "title": "Implement PR feedback monitor",
    "body": "Closes #199\n\nThis PR implements...",
    "head": {
      "ref": "199-pr-feedback-monitor"
    },
    "html_url": "https://github.com/owner/repo/pull/42"
  },
  "repository": {
    "owner": { "login": "generacy-ai" },
    "name": "generacy"
  }
}
```

**Response**:
```json
{
  "status": "processed" | "ignored" | "duplicate",
  "event": {
    "prNumber": 42,
    "linkedIssue": 199
  }
}
```

---

## Data Models

### QueueItem (Extended)

```typescript
interface QueueItem {
  owner: string;
  repo: string;
  issueNumber: number;
  workflowName: string;
  command: 'process' | 'continue' | 'address-pr-feedback'; // EXTENDED
  priority: number;
  enqueuedAt: string;
  metadata?: {
    // For address-pr-feedback command
    prNumber?: number;
    reviewThreadIds?: number[];
    // Extensible for future commands
    [key: string]: unknown;
  };
}
```

### PrMonitorConfig

```typescript
interface PrMonitorConfig {
  enabled: boolean; // default: true
  pollIntervalMs: number; // default: 60000 (1 min)
  webhookSecret?: string; // shared with issue webhook
  adaptivePolling: boolean; // default: true
  maxConcurrentPolls: number; // default: 3 (across all repos)
}
```

### PrToIssueLink

```typescript
interface PrToIssueLink {
  prNumber: number;
  issueNumber: number;
  linkMethod: 'pr-body' | 'branch-name';
}
```

### ReviewThread

```typescript
interface ReviewThread {
  id: number; // GitHub review comment ID
  path: string | null; // file path for inline comments
  line: number | null; // line number for inline comments
  body: string; // comment text
  resolved: boolean; // thread resolution status
  reviewer: string; // GitHub username of reviewer
}
```

---

## Key Technical Decisions

### 1. **Separate Service vs. Extend LabelMonitor**
**Decision**: Create `PrFeedbackMonitorService` as a separate service (Q12 Answer: A)
**Rationale**:
- Clean separation of concerns (issue labels vs. PR reviews are different event sources)
- Independent configuration and state management
- Easier to test and maintain
- Mirrors proven architecture of `LabelMonitorService`

### 2. **QueueItem Command Extension**
**Decision**: Extend `command` type union to include `'address-pr-feedback'` (Q2 Answer: A)
**Rationale**:
- Type-safe command routing in `ClaudeCliWorker`
- Clear distinction from `process`/`continue` flows
- Enables command-specific logic (checkout PR branch vs. create branch)
- Better observability in logs and metrics

### 3. **Metadata Storage**
**Decision**: Add optional `metadata` field to `QueueItem` (Q16 Answer: A)
**Rationale**:
- Flexible, extensible design for future commands
- Avoids encoding PR data in priority score or command string
- Properly serialized/deserialized by `RedisQueueAdapter`
- Type-safe via `Record<string, unknown>` with runtime validation

### 4. **Review State vs. Thread-Based Detection**
**Decision**: Ignore review state, only check `resolved: false` threads (Q15 Answer: A)
**Rationale**:
- More accurate: a reviewer can approve while leaving unresolved threads for follow-up
- Simpler logic: single source of truth (thread resolution status)
- Avoids edge cases with `dismissed` reviews and state transitions
- Aligns with user story: "agent addresses unresolved comments"

### 5. **Label Management During Feedback**
**Decision**: Keep existing phase labels unchanged (Q3 Answer: A)
**Rationale**:
- PR feedback is an interrupt/side-quest, not a formal phase
- Preserves workflow state (e.g., issue stays in `phase:implement`)
- Only add/remove `waiting-for:address-pr-feedback` for tracking
- Simplifies gate checking (no integration needed, Q19 Answer: A)

### 6. **Worker Timeout Handling**
**Decision**: Partial completion with retry on timeout (Q7 Answer: A)
**Rationale**:
- Don't discard agent's partial work (some threads may be addressed)
- Push whatever changes were made, reply to addressed threads
- Keep `waiting-for:address-pr-feedback` label for retry
- Prevents wasted work on complex PRs with many review threads

### 7. **Adaptive Polling Strategy**
**Decision**: Mirror label monitor logic (Q18 Answer: A)
**Rationale**:
- Proven approach: increase frequency when no webhooks received in 2x pollInterval
- Consistent behavior across monitoring services
- Reduces latency when webhooks are unavailable
- Automatically recovers when webhooks resume

### 8. **Concurrency Limiting**
**Decision**: `maxConcurrentPolls` limits API calls across all repos (Q10 Answer: A)
**Rationale**:
- Prevents overwhelming GitHub API (rate limit: 5000 req/hr)
- Fair resource allocation across multiple repos
- Simpler to configure (single global limit)
- Consistent with `LabelMonitorService` semaphore pattern

### 9. **Branch Checkout Strategy**
**Decision**: Checkout existing PR branch (Q11 Answer: A)
**Rationale**:
- Changes must be made on top of current PR state
- Avoids conflicts from default branch divergence
- Aligns with PR review workflow (review what's in the PR)
- Worker can directly push to PR branch after changes

### 10. **Reply Strategy**
**Decision**: Single consolidated reply per thread (Q5 Answer: A)
**Rationale**:
- Clean, organized thread conversations
- Summarizes all changes in one comment
- Avoids notification spam to reviewers
- Simplifies testing and validation (SC-005)

---

## Risk Mitigation Strategies

### Risk 1: GitHub API Rate Limits
**Likelihood**: Medium
**Impact**: High (polling stops, events missed)

**Mitigation**:
- Respect `X-RateLimit-Remaining` headers, pause polling when limit approached
- Use conditional requests (`If-None-Match`) where possible
- Webhook-first approach (polling is fallback only)
- `maxConcurrentPolls` limits concurrent API calls
- Structured logging of rate limit status for monitoring

### Risk 2: Webhook Delivery Failures
**Likelihood**: Medium
**Impact**: Medium (delayed feedback addressing)

**Mitigation**:
- Polling fallback catches missed webhook events within one poll cycle (SC-003)
- Adaptive polling increases frequency when webhooks go unhealthy
- Redis deduplication prevents double-processing when webhook arrives late (Q8)
- Idempotent enqueue logic (PhaseTracker prevents duplicates)

### Risk 3: PR-to-Issue Linking Failures
**Likelihood**: Medium
**Impact**: Medium (PR not processed)

**Mitigation**:
- Dual linking methods (PR body + branch name) increase success rate
- Fallback chain: PR body (priority) → branch name → skip
- Validation: verify issue exists and has `agent:*` label
- Structured logging of link failures for debugging
- Target: >95% linking accuracy (SC-002)

### Risk 4: Worker Timeout on Large PRs
**Likelihood**: Medium
**Impact**: Medium (partial addressing)

**Mitigation**:
- Partial completion strategy: push changes made so far, reply to addressed threads
- Keep `waiting-for:address-pr-feedback` label for automatic retry
- `phaseTimeoutMs` configurable (default 10 min, can extend for PR feedback)
- Structured logging of timeout events for tuning
- Q7 Answer: Prefer partial work over full rollback

### Risk 5: Concurrent Feedback While Agent is Working
**Likelihood**: Low
**Impact**: Low (new comments missed)

**Mitigation**:
- Q4 Answer: Skip new events until current completes, process fresh comments in next cycle
- PhaseTracker deduplication prevents concurrent processing of same issue
- Worker always fetches fresh threads (ignores stale metadata)
- Worst case: reviewer adds comment, agent completes, next poll cycle detects new comment

### Risk 6: Reply Posting Failures
**Likelihood**: Low
**Impact**: Low (reviewer doesn't see agent response)

**Mitigation**:
- Q9 Answer: Mark as partial success, remove `waiting-for` label, let reviewer see changes
- Continue to next thread on failure (don't fail entire job)
- Structured logging of reply failures
- Manual fallback: reviewer can see changes in PR commits

### Risk 7: Race Condition (Webhook + Polling)
**Likelihood**: Medium
**Impact**: Low (wasted API call)

**Mitigation**:
- Q8 Answer: Trust PhaseTracker Redis deduplication
- Atomic check-and-set in `isDuplicate()`/`markProcessed()` sequence
- Both paths use same dedup key pattern
- Idempotent label operations (adding existing label is no-op)

---

## Testing Strategy

### Unit Tests
- **PrLinker**: Mocked GitHub API responses, cover all parsing edge cases
- **PrFeedbackMonitorService**: Mocked dependencies, test polling and enqueue logic
- **PrFeedbackHandler**: Mocked CliSpawner and GitHub client, test prompt building and replies
- **Config validation**: Test schema parsing with valid/invalid configs

### Integration Tests
- **End-to-end flow**: Real Redis, mocked GitHub API, test webhook → queue → worker → reply
- **Polling fallback**: Disable webhooks, verify polling detects events within one cycle
- **Deduplication**: Send duplicate webhook + poll events, verify single enqueue
- **Timeout handling**: Mock slow CLI, verify partial completion and retry

### Manual Tests
- **Live GitHub repo**: Create test PR with review comments, verify agent addresses feedback
- **Multiple PRs**: Test Q14 scenario (most recent PR processed)
- **Branch checkout**: Verify worker checks out PR branch, not default branch
- **Thread resolution**: Verify agent never auto-resolves threads (SC-006)

### Performance Tests
- **Polling concurrency**: 10 repos × 20 open PRs, verify maxConcurrentPolls respected
- **Queue throughput**: Enqueue 100 PR feedback items, verify FIFO processing
- **Webhook latency**: Measure time from webhook receipt to enqueue (target: <500ms, SC-001)

---

## Observability

### Structured Logging Events

**PR Feedback Detection**:
```json
{
  "level": "info",
  "msg": "PR feedback detected",
  "prNumber": 42,
  "linkedIssue": 199,
  "unresolvedThreads": 3,
  "linkMethod": "pr-body",
  "source": "webhook"
}
```

**Enqueue**:
```json
{
  "level": "info",
  "msg": "PR feedback enqueued",
  "owner": "generacy-ai",
  "repo": "generacy",
  "issue": 199,
  "prNumber": 42,
  "workflowName": "speckit-feature",
  "priority": 1645123456789
}
```

**Worker Processing**:
```json
{
  "level": "info",
  "msg": "Addressing PR feedback",
  "workerId": "uuid",
  "prNumber": 42,
  "unresolvedThreads": 3,
  "branchName": "199-pr-feedback-monitor"
}
```

**Reply Success**:
```json
{
  "level": "info",
  "msg": "Replied to review thread",
  "threadId": 12345,
  "prNumber": 42,
  "file": "src/services/pr-monitor.ts",
  "line": 42
}
```

### Metrics (for future dashboard)
- `pr_feedback_events_total` (by source: webhook/poll)
- `pr_feedback_enqueued_total`
- `pr_feedback_processed_total`
- `pr_feedback_threads_addressed_total`
- `pr_linking_failures_total` (by reason: not-orchestrated, parse-failed)
- `webhook_latency_ms` (p50, p95, p99)

### SSE Events
**Q20 Answer: A - Reuse workflow events**
- `workflow:started` with `command: 'address-pr-feedback'`
- `workflow:progress` during CLI execution
- `workflow:completed` after replies posted

---

## Deployment Considerations

### Environment Variables
```bash
# PR Monitor Configuration
PR_MONITOR_ENABLED=true
PR_MONITOR_POLL_INTERVAL_MS=60000
PR_MONITOR_ADAPTIVE_POLLING=true
PR_MONITOR_MAX_CONCURRENT_POLLS=3

# Shared webhook secret
WEBHOOK_SECRET=<same as issue webhook>

# Worker timeout (optional, increase for large PRs)
PHASE_TIMEOUT_MS=600000  # 10 min default
```

### GitHub Webhook Configuration
**New webhook required** (in addition to existing issue webhook):
- **Payload URL**: `https://orchestrator.example.com/webhooks/github/pr-review`
- **Content type**: `application/json`
- **Secret**: Same as issue webhook secret
- **Events**:
  - `Pull request review`
  - `Pull request review comment`

### Redis Schema Changes
**New keys**:
- `phase-tracker:{owner}:{repo}:{issue}:address-pr-feedback` (TTL: 24h)
- Queue items in `orchestrator:queue:pending` will have new `metadata` field

**Migration**: No migration needed (additive changes only)

### Rollout Strategy
1. **Phase 1**: Deploy with `PR_MONITOR_ENABLED=false`, validate server starts correctly
2. **Phase 2**: Enable polling only (`PR_MONITOR_ENABLED=true`, no webhook configured yet)
3. **Phase 3**: Configure webhook, test end-to-end flow on test repository
4. **Phase 4**: Enable for production repositories, monitor logs and metrics
5. **Phase 5**: Tune `pollIntervalMs` and `maxConcurrentPolls` based on observed load

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| SC-001: Webhook latency | < 500ms | Timestamp delta: webhook receipt → enqueue |
| SC-002: PR linking accuracy | > 95% | Manual validation: 100 test PRs, count successful links |
| SC-003: Polling fallback coverage | 100% | Integration test: disable webhook, verify poll detects event |
| SC-004: Deduplication effectiveness | 0 duplicates | Redis query: count duplicate `phase-tracker` keys |
| SC-005: Reply completeness | 100% | GitHub API: verify all unresolved threads have agent reply |
| SC-006: Thread auto-resolve prevention | 0% auto-resolved | GitHub API: verify `resolved: false` after agent reply |

---

## Appendix: Clarification Answers Summary

For reference, here are the selected answers to clarification questions:

| Question | Answer | Impact |
|----------|--------|--------|
| Q1: Multiple issue references in PR | B: First issue only | `PrLinker.parsePrBody()` returns first match |
| Q2: QueueItem command extension | A: Extend type union | Add `'address-pr-feedback'` to command type |
| Q3: Label workflow during PR feedback | A: Keep existing phase labels | Only add/remove `waiting-for:address-pr-feedback` |
| Q4: Multiple review events | A: Queue after current completes | PhaseTracker dedup blocks concurrent processing |
| Q5: Review comment reply strategy | A: Single reply per thread | `PrFeedbackHandler.replyToThreads()` posts one comment per thread |
| Q6: Polling PR selection | A: Process all in parallel | Enqueue all orchestrated PRs, dispatcher handles concurrency |
| Q7: Worker timeout | A: Partial completion with retry | Push partial changes, keep `waiting-for` label |
| Q8: Webhook vs. polling race | A: Redis dedup sufficient | PhaseTracker handles concurrent checks |
| Q9: Reply posting error | A: Mark as partial success | Remove `waiting-for` label, log warnings |
| Q10: Multi-repo polling | A: Across all repositories | `maxConcurrentPolls=3` total across all repos |
| Q11: Branch checkout | A: Check out PR branch | Fetch and checkout existing PR branch |
| Q12: Service architecture | A: New PrFeedbackMonitorService | Separate service class |
| Q13: Workflow name preservation | A: Read from issue labels | Query issue labels for `process:*` or `completed:*` |
| Q14: Concurrent feedback on multiple PRs | A: Process most recent PR only | Skip older PRs (out of scope per spec) |
| Q15: Review state filtering | A: Strict unresolved-thread-only | Ignore review state, check `resolved: false` |
| Q16: PR metadata in queue item | A: Extend QueueItem with metadata field | Add optional `metadata?: Record<string, unknown>` |
| Q17: Configuration grouping | A: Separate prMonitor config | Add `prMonitor` field to `OrchestratorConfigSchema` |
| Q18: Adaptive polling trigger | A: Mirror label monitor logic | If no webhook in 2x pollInterval, decrease interval by 50% |
| Q19: Gate integration | A: No gate integration | Treat as interrupt, don't participate in gate system |
| Q20: SSE event streaming | A: Reuse workflow events | Emit `workflow:started/progress/completed` events |

---

*End of Implementation Plan*
