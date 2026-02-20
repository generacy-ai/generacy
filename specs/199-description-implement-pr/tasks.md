# Tasks: PR Feedback Monitor for Orchestrated Issues

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1-US5)

---

## Phase 1: Type Extensions and Configuration (Foundation)

### T001 [US1] Extend QueueItem type with address-pr-feedback command
**File**: `packages/orchestrator/src/types/monitor.ts`
- Add `'address-pr-feedback'` to command union type
- Add optional `metadata?: Record<string, unknown>` field to QueueItem interface
- Export PrFeedbackMetadata interface with `prNumber` and `reviewThreadIds`
- Ensure TypeScript compiles without errors

### T002 [P] [US1] Add PR-specific type definitions
**File**: `packages/orchestrator/src/types/monitor.ts`
- Define `PrToIssueLink` interface (prNumber, issueNumber, linkMethod)
- Define `ReviewThread` interface (id, path, line, body, resolved, reviewer)
- Define `PrFeedbackMetadata` interface for queue metadata
- Add JSDoc comments for all new types

### T003 [P] [US1] Extend orchestrator config schema for PR monitor
**File**: `packages/orchestrator/src/config/schema.ts`
- Create `PrMonitorConfigSchema` with zod:
  - `enabled` (default: true)
  - `pollIntervalMs` (default: 60000, min: 5000)
  - `webhookSecret` (optional string)
  - `adaptivePolling` (default: true)
  - `maxConcurrentPolls` (default: 3, min: 1, max: 20)
- Export `PrMonitorConfig` type
- Add `prMonitor` field to `OrchestratorConfigSchema` with default empty object

### T004 [US1] Update RedisQueueAdapter to handle metadata field
**File**: `packages/orchestrator/src/services/redis-queue-adapter.ts`
- Verify metadata field serialization in `enqueue()` method
- Verify metadata field deserialization in `claim()` method
- Add unit tests for metadata round-trip (serialize → deserialize)

---

## Phase 2: PR-to-Issue Linking Utility

### T005 [US3] Implement PrLinker class with PR body parsing
**File**: `packages/orchestrator/src/worker/pr-linker.ts` (NEW)
- Create `PrLinker` class
- Implement `parsePrBody(prBody: string): number | null`
  - Define CLOSING_KEYWORDS array (close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved)
  - Parse PR body using regex for "keyword #number" patterns
  - Return first matched issue number (case-insensitive)
  - Return null if no match found
- Add JSDoc with examples

### T006 [US3] Implement branch name parsing in PrLinker
**File**: `packages/orchestrator/src/worker/pr-linker.ts`
- Implement `parseBranchName(branchName: string): number | null`
  - Match pattern `{number}-{description}` (e.g., "199-feature-name")
  - Extract and validate issue number
  - Return null for invalid formats
- Handle edge cases (leading zeros, non-numeric prefixes)

### T007 [US3] Implement PR-to-issue linking with GitHub API
**File**: `packages/orchestrator/src/worker/pr-linker.ts`
- Implement `linkPrToIssue()` method
  - Call `parsePrBody()` first (priority method)
  - Fallback to `parseBranchName()` if body parsing fails
  - Return `PrToIssueLink` with linkMethod indicator
  - Return null if both methods fail
- Add structured logging for link resolution (info level)

### T008 [US3] Implement orchestration verification in PrLinker
**File**: `packages/orchestrator/src/worker/pr-linker.ts`
- Implement `verifyOrchestrated()` method
  - Fetch issue labels via GitHub API
  - Check for any `agent:*` label
  - Return boolean (true if orchestrated)
  - Handle 404 errors gracefully (issue not found → false)
- Add error handling with try-catch

### T009 [P] [US3] Write comprehensive PrLinker unit tests
**File**: `packages/orchestrator/src/worker/__tests__/pr-linker.test.ts` (NEW)
- Test `parsePrBody()`:
  - Valid closing keywords (Closes, Fixes, Resolves with #123)
  - Case insensitivity
  - Multiple issue references (returns first)
  - No matches (returns null)
  - Malformed body text
- Test `parseBranchName()`:
  - Valid format "123-description"
  - Invalid formats (no dash, no number, letters first)
  - Edge cases (leading zeros, special characters)
- Test `linkPrToIssue()`:
  - PR body takes priority over branch name
  - Fallback to branch name when body empty
  - Returns null when both fail
- Test `verifyOrchestrated()`:
  - Issue with agent:* label returns true
  - Issue without agent label returns false
  - Non-existent issue returns false
- Mock GitHub API responses
- Target >90% code coverage

---

## Phase 3: PR Feedback Monitor Service

### T010 [US1,US4] Create PrFeedbackMonitorService skeleton
**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` (NEW)
- Define class structure with constructor
- Inject dependencies (logger, GitHubClientFactory, PhaseTracker, QueueAdapter, PrLinker)
- Add config options and repositories list
- Define private fields (abortController, state)
- Add state getter `getState(): Readonly<MonitorState>`

### T011 [US1] Implement unresolved thread detection
**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
- Create `fetchReviewThreads()` private method
  - Call GitHub API: `GET /repos/{owner}/{repo}/pulls/{pr}/comments`
  - Map response to `ReviewThread[]` array
  - Handle pagination if needed
  - Handle API errors (rate limit, 404)
- Create `filterUnresolvedThreads()` helper
  - Filter threads where `resolved === false`
  - Ignore review state (submitted, changes_requested, etc.)

### T012 [US1,US2] Implement PR review event processing
**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
- Implement `processPrReviewEvent()` method
  - Accept event object (owner, repo, prNumber, prBody, branchName, source)
  - Call `prLinker.linkPrToIssue()` to get linked issue
  - Return false if no link found (log warning)
  - Call `prLinker.verifyOrchestrated()` to validate issue
  - Return false if not orchestrated (log info)
  - Fetch unresolved threads
  - Return false if no unresolved threads (log info)
  - Call `enqueuePrFeedback()` if threads exist
  - Return true on successful processing
- Add structured logging at each step

### T013 [US1] Implement workflow name resolution
**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
- Create `resolveWorkflowName()` private method
  - Fetch issue labels via GitHub API
  - Search for labels matching `process:*` pattern
  - Extract workflow name from label (e.g., `process:speckit-feature` → `speckit-feature`)
  - Fallback to `completed:*` labels if no `process:*` found
  - Return workflow name or throw error if not found
- Add error handling for issues without workflow labels

### T014 [US1] Implement enqueue logic with deduplication
**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
- Implement `enqueuePrFeedback()` private method
  - Check `phaseTracker.isDuplicate()` with key pattern `phase-tracker:{owner}:{repo}:{issue}:address-pr-feedback`
  - Skip and log if duplicate found
  - Call `resolveWorkflowName()` to get workflow
  - Build `QueueItem` object:
    - command: `'address-pr-feedback'`
    - priority: `Date.now()` (FIFO)
    - metadata: `{ prNumber, reviewThreadIds }`
  - Call `queueAdapter.enqueue(item)`
  - Call `phaseTracker.markProcessed()` atomically
  - Add `waiting-for:address-pr-feedback` label to issue via GitHub API
  - Log successful enqueue (info level)
- Handle errors (API failures, queue failures)

### T015 [US4] Implement polling loop infrastructure
**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
- Implement `startPolling()` method
  - Create AbortController for graceful shutdown
  - Start background polling loop with `setInterval`
  - Use configured `pollIntervalMs`
  - Call `poll()` on each tick
  - Catch and log errors without crashing
- Implement `stopPolling()` method
  - Abort controller signal
  - Clear interval
  - Log shutdown (info level)

### T016 [US4] Implement polling with concurrency limiting
**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
- Implement `poll()` private method
  - Create semaphore with `maxConcurrentPolls` limit
  - Map over all repositories
  - For each repo, acquire semaphore → call `pollRepo()` → release
  - Use `Promise.allSettled()` to prevent one failure from blocking others
- Implement `pollRepo()` private method
  - List open PRs via GitHub API
  - For each PR, call `prLinker.linkPrToIssue()`
  - Skip if not linked or not orchestrated
  - Fetch unresolved threads
  - If threads exist, call `enqueuePrFeedback()`
- Add structured logging (poll start, repo processing, PR count)

### T017 [P] [US4] Implement adaptive polling logic
**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
- Implement `recordWebhookEvent()` method
  - Update `lastWebhookReceivedAt` timestamp in state
  - Reset adaptive polling interval if currently adapted
- Add adaptive polling trigger in `poll()`:
  - Check if `lastWebhookReceivedAt` older than 2x pollInterval
  - If true, decrease pollInterval by 50% (min 5000ms)
  - Update state.adaptivePolling flag
  - Log adaptive polling activation (warn level)
- Reset interval when webhook received

### T018 [P] [US1,US2,US3,US4] Write PrFeedbackMonitorService unit tests
**File**: `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts` (NEW)
- Mock dependencies (GitHub client, PhaseTracker, QueueAdapter, PrLinker)
- Test `processPrReviewEvent()`:
  - Happy path (linked, orchestrated, unresolved threads → enqueue)
  - PR not linked → return false, no enqueue
  - Issue not orchestrated → return false, no enqueue
  - No unresolved threads → return false, no enqueue
- Test `enqueuePrFeedback()`:
  - Successful enqueue with correct QueueItem structure
  - Duplicate detection (PhaseTracker blocks)
  - Workflow name resolution
  - Label addition to issue
- Test `poll()`:
  - Concurrency limit enforced (maxConcurrentPolls)
  - All repos processed
  - Handles repo failures gracefully
- Test `pollRepo()`:
  - Lists open PRs
  - Links and verifies each PR
  - Enqueues when unresolved threads found
- Test adaptive polling:
  - Interval decreases when no webhooks
  - Resets when webhook received
- Test graceful shutdown:
  - `stopPolling()` aborts loop
  - No hanging promises
- Target >85% code coverage

---

## Phase 4: Webhook Route Extension

### T019 [US1,US4] Add PR review webhook payload types
**File**: `packages/orchestrator/src/types/webhooks.ts` (extend or create)
- Define `PrReviewWebhookPayload` interface
  - action: string
  - review: { id, state, body }
  - pull_request: { number, title, body, head: { ref }, html_url }
  - repository: { owner: { login }, name }
- Define `PrReviewEvent` interface for internal use
  - owner, repo, prNumber, prBody, branchName, source

### T020 [US1] Implement PR review webhook route handler
**File**: `packages/orchestrator/src/routes/webhooks.ts` (EXTEND)
- Add `POST /webhooks/github/pr-review` route
- Verify webhook signature using shared `WEBHOOK_SECRET`
  - Extract `X-Hub-Signature-256` header
  - Compute HMAC-SHA256 of raw body
  - Compare signatures (timing-safe)
  - Return 401 if mismatch
- Filter events:
  - Accept `pull_request_review.submitted` and `pull_request_review_comment.created`
  - Ignore other actions (return 200 with status: ignored)
- Verify repository is watched (check against config.repositories)
  - Return 200 with status: ignored if not watched
- Parse payload to extract PR details
- Call `prMonitorService.recordWebhookEvent()` for adaptive polling
- Call `prMonitorService.processPrReviewEvent()`
- Return JSON response:
  - `{ status: 'processed', event: { prNumber, linkedIssue } }` on success
  - `{ status: 'ignored', reason: '...' }` if skipped

### T021 [P] [US1] Write webhook route tests
**File**: `packages/orchestrator/src/routes/__tests__/webhooks.test.ts` (extend)
- Test signature verification:
  - Valid signature → 200
  - Invalid signature → 401
  - Missing signature → 401
- Test event filtering:
  - `pull_request_review.submitted` → processed
  - `pull_request_review_comment.created` → processed
  - Other actions → ignored
- Test repository filtering:
  - Watched repo → processed
  - Unwatched repo → ignored
- Test processing delegation:
  - Calls `processPrReviewEvent()` with correct parameters
  - Returns processed status on success
- Mock `PrFeedbackMonitorService`

---

## Phase 5: PR Feedback Handler (Worker Extension)

### T022 [US2] Create PrFeedbackHandler class skeleton
**File**: `packages/orchestrator/src/worker/pr-feedback-handler.ts` (NEW)
- Define class structure with constructor
- Inject dependencies (config, logger, processFactory, sseEmitter)
- Define `handle()` method signature (context, metadata)
- Add private helper method stubs:
  - `fetchUnresolvedThreads()`
  - `buildFeedbackPrompt()`
  - `pushChanges()`
  - `replyToThreads()`
  - `generateReply()`
  - `completeWithoutChanges()`

### T023 [US2] Implement PR branch checkout in handler
**File**: `packages/orchestrator/src/worker/pr-feedback-handler.ts`
- Implement branch checkout in `handle()`:
  - Fetch PR details via GitHub API to get head ref (branch name)
  - Use `RepoCheckout` utility (or Git commands) to checkout PR branch
  - Handle errors (branch not found, checkout conflicts)
  - Log checkout success (info level)

### T024 [US2] Implement fresh thread fetching
**File**: `packages/orchestrator/src/worker/pr-feedback-handler.ts`
- Implement `fetchUnresolvedThreads()` method
  - Call GitHub API to get review threads
  - Filter for `resolved: false`
  - Map to `ReviewThread[]` array
  - Return empty array if no unresolved threads
- Handle in `handle()`:
  - Skip processing if no threads (call `completeWithoutChanges()`)
  - Log thread count (info level)

### T025 [US2] Implement feedback prompt builder
**File**: `packages/orchestrator/src/worker/pr-feedback-handler.ts`
- Implement `buildFeedbackPrompt()` method
  - Start with instruction header:
    - "You are addressing PR review feedback. Read the comments below, make the necessary changes, and reply to each comment explaining what you changed. Never resolve the threads yourself."
  - Add PR URL
  - Add "Review Comments:" section
  - For each thread:
    - Reviewer name
    - File path and line (if inline comment)
    - Comment body
  - Return formatted prompt string
- Add proper escaping for special characters

### T026 [US2] Implement Claude CLI spawning with timeout
**File**: `packages/orchestrator/src/worker/pr-feedback-handler.ts`
- In `handle()` method:
  - Create `CliSpawner` instance
  - Create `OutputCapture` instance for SSE streaming
  - Build CLI arguments: `['--prompt', prompt]`
  - Call `cliSpawner.spawnWithTimeout()` with `phaseTimeoutMs`
  - Catch timeout errors:
    - Log warning (timeout occurred)
    - Continue to push partial changes
    - Don't remove `waiting-for` label (allow retry)
    - Rethrow error for worker error handling
  - Catch other errors:
    - Log error
    - Rethrow for worker error handling

### T027 [US2] Implement Git push for PR branch
**File**: `packages/orchestrator/src/worker/pr-feedback-handler.ts`
- Implement `pushChanges()` method
  - Stage all changes: `git add -A`
  - Commit with message: "Address PR review feedback"
  - Push to PR branch: `git push origin {branchName}`
  - Handle push errors (conflicts, authentication)
  - Log push success (info level)

### T028 [US2] Implement review thread reply logic
**File**: `packages/orchestrator/src/worker/pr-feedback-handler.ts`
- Implement `generateReply()` helper
  - Extract relevant changes from CLI output
  - Build reply message summarizing changes for specific thread
  - Include file path and line context
  - Keep concise (1-3 sentences per thread)
- Implement `replyToThreads()` method
  - Iterate over all unresolved threads
  - For each thread:
    - Call `generateReply()` to build response
    - Post reply via GitHub API: `POST /repos/{owner}/{repo}/pulls/comments/{threadId}/replies`
    - Log success (info level)
    - On error: log warning, continue to next thread (partial success)
  - Never call resolve thread API
  - Return count of successful replies

### T029 [US2] Implement label management in handler
**File**: `packages/orchestrator/src/worker/pr-feedback-handler.ts`
- In `handle()` method after successful completion:
  - Remove `waiting-for:address-pr-feedback` label via GitHub API
  - Optionally add `completed:address-pr-feedback` label (if desired)
  - Keep existing phase labels unchanged (`phase:*`, `process:*`)
  - Handle label API errors gracefully (log warning)
- Implement `completeWithoutChanges()`:
  - Remove `waiting-for` label
  - Log info (no changes needed)

### T030 [US2] Extend ClaudeCliWorker to route address-pr-feedback command
**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts` (EXTEND)
- In `handle()` method, add command routing:
  - Check `if (item.command === 'address-pr-feedback')`
  - Extract metadata: `const metadata = item.metadata as PrFeedbackMetadata`
  - Create `PrFeedbackHandler` instance
  - Call `handler.handle(context, metadata)`
  - Return early (don't fall through to process/continue logic)
- Add import for `PrFeedbackHandler`
- Validate metadata structure (has prNumber and reviewThreadIds)

### T031 [P] [US2] Write PrFeedbackHandler unit tests
**File**: `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts` (NEW)
- Mock dependencies (GitHub client, CliSpawner, RepoCheckout, ProcessFactory)
- Test `handle()` happy path:
  - Fetches PR and checks out branch
  - Fetches unresolved threads
  - Builds prompt correctly
  - Spawns CLI with timeout
  - Pushes changes to branch
  - Replies to all threads
  - Removes waiting label
- Test no unresolved threads scenario:
  - Skips CLI spawn
  - Calls `completeWithoutChanges()`
- Test timeout handling:
  - CLI times out
  - Partial changes pushed
  - Partial replies posted
  - Waiting label kept (no removal)
- Test reply failure:
  - Some threads succeed, some fail
  - Continues processing (doesn't stop on first failure)
  - Logs warnings for failures
- Test `buildFeedbackPrompt()`:
  - Includes all thread details
  - Formats correctly
  - Escapes special characters
- Test `replyToThreads()`:
  - Posts replies to GitHub API
  - Handles API errors gracefully
  - Never calls resolve thread API
- Target >85% code coverage

### T032 [P] [US2] Write ClaudeCliWorker extension tests
**File**: `packages/orchestrator/src/worker/__tests__/claude-cli-worker.test.ts` (extend)
- Test command routing for `address-pr-feedback`:
  - Routes to `PrFeedbackHandler`
  - Passes metadata correctly
  - Returns after handling (doesn't fall through)
- Test metadata validation:
  - Valid metadata accepted
  - Invalid/missing metadata throws error
- Mock `PrFeedbackHandler.handle()`

---

## Phase 6: Server Integration

### T033 [US1] Initialize PrFeedbackMonitorService in server
**File**: `packages/orchestrator/src/server.ts` (EXTEND)
- After label monitor initialization:
  - Check `if (config.prMonitor.enabled && config.repositories.length > 0)`
  - Create `PhaseTrackerService` instance (or reuse existing)
  - Create `PrFeedbackMonitorService` instance with dependencies:
    - logger: `server.log`
    - createClient: `createGitHubClient`
    - phaseTracker
    - queueAdapter
    - options: `config.prMonitor`
    - repositories: `config.repositories`
  - Store in server-scoped variable for shutdown

### T034 [US1] Register PR webhook routes in server
**File**: `packages/orchestrator/src/server.ts` (EXTEND)
- Import webhook setup function
- After PR monitor initialization:
  - Build watched repos set from `config.repositories`
  - Call webhook route registration:
    ```typescript
    await setupPrWebhookRoutes(server, {
      monitorService: prFeedbackMonitorService,
      webhookSecret: config.prMonitor.webhookSecret,
      watchedRepos,
    });
    ```

### T035 [US4] Start PR monitor polling on server ready
**File**: `packages/orchestrator/src/server.ts` (EXTEND)
- In `onReady` hook (after label monitor polling):
  - Check `if (prFeedbackMonitorService)`
  - Call `prFeedbackMonitorService.startPolling()`
  - Catch errors and log to `server.log.error`
  - Don't crash server if polling fails to start

### T036 [US1] Add PR monitor to graceful shutdown
**File**: `packages/orchestrator/src/server.ts` (EXTEND)
- In `setupGracefulShutdown()` cleanup array:
  - Add cleanup function:
    ```typescript
    async () => {
      if (prFeedbackMonitorService) {
        prFeedbackMonitorService.stopPolling();
      }
    }
    ```
  - Ensure polling stops before server shutdown completes

### T037 [P] [US1] Write server integration tests
**File**: `packages/orchestrator/src/__tests__/integration/server-integration.test.ts` (extend)
- Test PR monitor initialization:
  - Enabled when `prMonitor.enabled=true` and repos exist
  - Disabled when `prMonitor.enabled=false`
  - Disabled when no repositories configured
- Test polling lifecycle:
  - Starts on server ready
  - Stops on server shutdown
- Test webhook route registration:
  - Route exists when monitor enabled
  - Route not registered when monitor disabled
- Mock all dependencies

---

## Phase 7: Testing & Validation

### T038 [P] Write end-to-end integration test
**File**: `packages/orchestrator/src/__tests__/integration/pr-feedback-flow.test.ts` (NEW)
- Set up test infrastructure:
  - Real Redis instance (or mock)
  - Mocked GitHub API
  - Test server instance
- Test webhook → enqueue → worker → reply flow:
  - Send webhook event to `/webhooks/github/pr-review`
  - Verify QueueItem enqueued with correct structure
  - Simulate worker claiming item
  - Verify `PrFeedbackHandler` called
  - Verify changes pushed and replies posted
  - Verify labels updated correctly
- Test polling fallback:
  - Disable webhooks
  - Set up test PR with unresolved threads
  - Wait for poll cycle
  - Verify event detected and enqueued
- Test deduplication:
  - Send duplicate webhook events
  - Verify only one enqueue occurs
  - Send webhook + poll concurrently
  - Verify PhaseTracker prevents duplicates

### T039 [P] Write timeout handling integration test
**File**: `packages/orchestrator/src/__tests__/integration/pr-feedback-flow.test.ts` (extend)
- Mock slow CLI execution (exceeds phaseTimeoutMs)
- Verify timeout error thrown
- Verify partial changes pushed
- Verify `waiting-for` label NOT removed (retry enabled)
- Verify error logged appropriately

### T040 [P] Write multiple PR handling test
**File**: `packages/orchestrator/src/__tests__/integration/pr-feedback-flow.test.ts` (extend)
- Create scenario: issue has 2 PRs with unresolved threads
- Per spec (out of scope), only most recent PR processed
- Verify older PR skipped
- Verify most recent PR enqueued

### T041 [P] Write concurrency limit validation test
**File**: `packages/orchestrator/src/__tests__/integration/pr-feedback-concurrency.test.ts` (NEW)
- Set `maxConcurrentPolls = 3`
- Create 10 repos with open PRs
- Monitor concurrent API calls during poll cycle
- Verify never exceeds 3 concurrent polls
- Verify all repos eventually processed

### T042 [P] Write rate limit handling test
**File**: `packages/orchestrator/src/__tests__/integration/pr-feedback-rate-limit.test.ts` (NEW)
- Mock GitHub API rate limit response (429 or rate limit headers)
- Trigger polling
- Verify polling pauses when rate limit hit
- Verify structured logging of rate limit status
- Verify polling resumes after rate limit reset

### T043 [P] Validate success criteria SC-001 (webhook latency)
**File**: `packages/orchestrator/src/__tests__/integration/pr-feedback-performance.test.ts` (NEW)
- Send webhook event
- Measure timestamp delta from receipt to enqueue
- Assert latency < 500ms
- Run 100 iterations for statistical confidence

### T044 [P] Validate success criteria SC-002 (PR linking accuracy)
**File**: `packages/orchestrator/src/__tests__/validation/pr-linking-accuracy.test.ts` (NEW)
- Create 100 test PR scenarios:
  - 50 with valid PR body references
  - 30 with valid branch names
  - 10 with both methods
  - 10 with neither (should fail)
- Run through `PrLinker.linkPrToIssue()`
- Calculate success rate
- Assert > 95% accuracy

### T045 [P] Validate success criteria SC-003 (polling fallback)
**File**: `packages/orchestrator/src/__tests__/integration/pr-feedback-flow.test.ts` (extend)
- Disable webhooks
- Create PR with unresolved threads
- Wait for one poll cycle (60s max)
- Verify event detected and enqueued
- Assert 100% coverage within one cycle

### T046 [P] Validate success criteria SC-004 (deduplication)
**File**: `packages/orchestrator/src/__tests__/integration/pr-feedback-flow.test.ts` (extend)
- Send same PR review event multiple times
- Query Redis for `phase-tracker` keys
- Assert 0 duplicate enqueues
- Query queue for duplicate items
- Assert only one item in queue

### T047 [P] Validate success criteria SC-005 (reply completeness)
**File**: `packages/orchestrator/src/__tests__/integration/pr-feedback-flow.test.ts` (extend)
- Create PR with 5 unresolved threads
- Process via worker
- Query GitHub API for thread replies
- Assert all 5 threads have agent reply
- Assert 100% reply completeness

### T048 [P] Validate success criteria SC-006 (no auto-resolve)
**File**: `packages/orchestrator/src/__tests__/integration/pr-feedback-flow.test.ts` (extend)
- Create PR with unresolved threads
- Process via worker
- Query GitHub API for thread resolution status
- Assert all threads remain `resolved: false`
- Assert 0% auto-resolved

### T049 [P] Write load test for queue throughput
**File**: `packages/orchestrator/src/__tests__/load/pr-feedback-queue.test.ts` (NEW)
- Enqueue 100 PR feedback items
- Simulate worker processing (mock Claude CLI)
- Measure throughput (items/second)
- Verify FIFO ordering maintained
- Verify no queue deadlocks or starvation

### T050 [P] Manual validation with live GitHub repo
**Task**: Manual testing (not automated)
- Create test repository
- Create test PR with review comments
- Configure orchestrator to watch test repo
- Trigger webhook (or wait for poll)
- Verify agent addresses feedback correctly
- Verify no threads auto-resolved
- Verify changes pushed to PR branch
- Verify replies posted correctly

---

## Phase 8: Documentation & Deployment

### T051 [P] Add configuration documentation
**File**: `packages/orchestrator/README.md` (extend)
- Document PR monitor configuration options:
  - `prMonitor.enabled`
  - `prMonitor.pollIntervalMs`
  - `prMonitor.webhookSecret`
  - `prMonitor.adaptivePolling`
  - `prMonitor.maxConcurrentPolls`
- Add example configuration
- Document environment variable mappings

### T052 [P] Document GitHub webhook setup
**File**: `packages/orchestrator/docs/WEBHOOKS.md` (extend or create)
- Add PR review webhook setup instructions:
  - Payload URL format
  - Content type (application/json)
  - Secret (shared with issue webhook)
  - Events to enable (pull_request_review, pull_request_review_comment)
- Add troubleshooting section for webhook issues

### T053 [P] Add deployment checklist
**File**: `packages/orchestrator/docs/DEPLOYMENT.md` (extend or create)
- Add PR monitor deployment steps:
  1. Deploy with `PR_MONITOR_ENABLED=false`
  2. Validate server starts
  3. Enable polling only (no webhook)
  4. Test polling detection
  5. Configure GitHub webhook
  6. Test end-to-end flow
  7. Enable for production repos
  8. Monitor metrics and logs
- Add rollback procedure

### T054 [P] Document observability and metrics
**File**: `packages/orchestrator/docs/OBSERVABILITY.md` (extend or create)
- Document structured log events:
  - PR feedback detection
  - Enqueue events
  - Worker processing
  - Reply success/failure
- Document future metrics (for dashboard):
  - `pr_feedback_events_total`
  - `pr_feedback_enqueued_total`
  - `pr_feedback_processed_total`
  - `pr_feedback_threads_addressed_total`
  - `pr_linking_failures_total`
  - `webhook_latency_ms`
- Add SSE event schema

### T055 [P] Update CHANGELOG
**File**: `packages/orchestrator/CHANGELOG.md`
- Add entry for PR Feedback Monitor feature:
  - Version number
  - Feature description
  - Breaking changes (none expected)
  - New configuration options
  - Migration notes (none required)

---

## Dependencies & Execution Order

### Phase Dependencies (Sequential)

**Must complete in order**:
1. **Phase 1** (Foundation) → all other phases depend on type definitions
2. **Phase 2** (PrLinker) → Phase 3, 5 depend on linking logic
3. **Phase 3** (Monitor Service) → Phase 4, 6 depend on service
4. **Phase 4** (Webhook Routes) → Phase 6 (server integration)
5. **Phase 5** (Worker Handler) → Phase 6, 7 (testing requires handler)
6. **Phase 6** (Server Integration) → Phase 7 (integration tests require full system)
7. **Phase 7** (Testing) → Phase 8 (docs should reflect tested behavior)
8. **Phase 8** (Documentation) → can proceed after Phase 7

### Parallel Opportunities Within Phases

**Phase 1** (all can run in parallel):
- T002 (PR types) || T003 (config schema) || T001 (QueueItem extension)
- T004 blocks on T001 completing

**Phase 2**:
- T005-T008 sequential (build PrLinker methods incrementally)
- T009 parallel after T005-T008

**Phase 3**:
- T010-T017 sequential (build service incrementally)
- T018 parallel after T010-T017

**Phase 4**:
- T019-T020 sequential
- T021 parallel after T020

**Phase 5**:
- T022-T030 sequential (build handler incrementally)
- T031, T032 parallel after T030

**Phase 6**:
- T033-T036 sequential (server integration order matters)
- T037 parallel after T036

**Phase 7** (all validation tasks can run in parallel):
- T038-T050 all parallel (independent test scenarios)

**Phase 8** (all documentation tasks can run in parallel):
- T051-T055 all parallel

### Critical Path

**Longest sequential dependency chain**:
```
T001 → T004 → T010 → T011 → T012 → T013 → T014 → T015 → T016 → T022 → T023 → T024 → T025 → T026 → T027 → T028 → T029 → T030 → T033 → T034 → T035 → T036 → T038
```

**Estimated critical path duration**: ~40-50 hours (assumes 1-2 hours per task on critical path)

### Parallelization Strategy

**Maximum parallel tasks by phase**:
- Phase 1: 3 tasks (T001, T002, T003)
- Phase 2: 1 task (sequential build, then T009)
- Phase 3: 1 task (sequential build, then T018)
- Phase 4: 1 task (sequential, then T021)
- Phase 5: 2 tasks (T031, T032 after main sequence)
- Phase 6: 1 task (sequential, then T037)
- Phase 7: 13 tasks (all validation tests)
- Phase 8: 5 tasks (all documentation)

**Recommended execution**:
1. Start with Phase 1 tasks in parallel
2. Phase 2-6: sequential build with parallel tests
3. Phase 7: run all validation tests concurrently for fast feedback
4. Phase 8: write all docs concurrently

---

## Test Coverage Requirements

### Unit Tests
- **Target**: >85% code coverage for all new code
- **Files requiring tests**:
  - `pr-linker.ts` (T009)
  - `pr-feedback-monitor-service.ts` (T018)
  - `pr-feedback-handler.ts` (T031)
  - `claude-cli-worker.ts` extensions (T032)
  - Webhook routes (T021)

### Integration Tests
- **Target**: Cover all functional requirements (FR-1 through FR-8)
- **Files requiring tests**:
  - End-to-end flow (T038)
  - Timeout handling (T039)
  - Multiple PR handling (T040)
  - Concurrency limits (T041)
  - Rate limit handling (T042)

### Validation Tests
- **Target**: Validate all success criteria (SC-001 through SC-006)
- **Tasks**: T043-T048

### Manual Testing
- **Target**: Validate real GitHub integration
- **Task**: T050

---

## Rollout Checklist

- [ ] Phase 1 complete: Type definitions compile
- [ ] Phase 2 complete: PrLinker unit tests pass (>90% coverage)
- [ ] Phase 3 complete: Monitor service unit tests pass (>85% coverage)
- [ ] Phase 4 complete: Webhook route tests pass
- [ ] Phase 5 complete: Handler unit tests pass (>85% coverage)
- [ ] Phase 6 complete: Server integration tests pass
- [ ] Phase 7 complete: All validation tests pass, success criteria met
- [ ] Phase 8 complete: Documentation updated
- [ ] Deploy to staging with `PR_MONITOR_ENABLED=false`
- [ ] Enable polling on staging, validate no errors
- [ ] Configure test webhook, validate end-to-end flow
- [ ] Monitor logs and metrics for 24 hours
- [ ] Deploy to production with polling enabled
- [ ] Configure production webhooks
- [ ] Monitor success criteria metrics for 1 week

---

**Total Tasks**: 55 (50 implementation + 5 documentation)
**Estimated Duration**: 80-100 hours (with parallelization: ~50-60 hours)
**Critical Path**: ~40-50 hours

---

*End of Task List*
