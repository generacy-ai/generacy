# Tasks: PR Feedback Monitor

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required), clarifications.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1-US5)

## Overview

This task breakdown implements the PR Feedback Monitor feature, which adds automated PR review feedback addressing to the orchestrator. The implementation follows a hybrid webhook + polling architecture and integrates with the existing worker dispatch system.

**Total Tasks**: 60 (34 implementation + 26 testing)
**Estimated Effort**: 8-10 development days (with parallel execution)

---

## Phase 1: Type Extensions and Configuration

### T001 [US1] Extend `QueueItem` type with `address-pr-feedback` command and metadata
**File**: `packages/orchestrator/src/types/monitor.ts`
- Add `'address-pr-feedback'` to the `command` union: `'process' | 'continue' | 'address-pr-feedback'`
- Add optional `metadata?: Record<string, unknown>` field to `QueueItem`
- Add new `PrFeedbackMetadata` interface with `prNumber: number` and `reviewThreadIds: number[]`
- Add `PrReviewEvent` interface with `owner`, `repo`, `prNumber`, `prBody`, `branchName`, `source: 'webhook' | 'poll'`
- Add `PrToIssueLink` interface with `prNumber`, `issueNumber`, `linkMethod: 'pr-body' | 'branch-name'`
- Add `GitHubPrReviewWebhookPayload` interface for webhook deserialization (model after existing `GitHubWebhookPayload` — include `action`, `review`, `comment`, `pull_request`, `repository` fields)
- Verify existing `SerializedQueueItem`, `QueueAdapter`, `QueueManager` all remain compatible (they extend `QueueItem`)

### T002 [P] [US1] Add `PrMonitorConfig` to configuration schema
**File**: `packages/orchestrator/src/config/schema.ts`
- Add `PrMonitorConfigSchema` with zod: `enabled` (boolean, default true), `pollIntervalMs` (int, min 5000, default 60000), `webhookSecret` (string, optional), `adaptivePolling` (boolean, default true), `maxConcurrentPolls` (int, min 1, max 20, default 3)
- Export `PrMonitorConfig` type
- Add `prMonitor: PrMonitorConfigSchema.default({})` to `OrchestratorConfigSchema`

### T003 [P] [US1] Add environment variable loading for PR monitor config
**File**: `packages/orchestrator/src/config/loader.ts`
- Add env var mappings: `PR_MONITOR_ENABLED` → `prMonitor.enabled`, `PR_MONITOR_POLL_INTERVAL_MS` → `prMonitor.pollIntervalMs`, `PR_MONITOR_WEBHOOK_SECRET` → `prMonitor.webhookSecret`, `PR_MONITOR_ADAPTIVE_POLLING` → `prMonitor.adaptivePolling`, `PR_MONITOR_MAX_CONCURRENT_POLLS` → `prMonitor.maxConcurrentPolls`
- Follow existing env loading pattern (check `process.env`, parse as int/boolean as appropriate)

### T004 [P] [US1] Export new config types from config barrel
**File**: `packages/orchestrator/src/config/index.ts`
- Add exports for `PrMonitorConfigSchema` and `PrMonitorConfig` type

### T005 [P] [US2] Add `waiting-for:address-pr-feedback` label definition
**File**: `packages/workflow-engine/src/actions/github/label-definitions.ts`
- Add `{ name: 'waiting-for:address-pr-feedback', color: 'FBCA04', description: 'Agent is addressing PR review feedback' }` to `WORKFLOW_LABELS` array (after the existing `waiting-for:pr-feedback` entry)

### T006 [P] [US4] Add `listOpenPullRequests` to `GitHubClient` interface
**File**: `packages/workflow-engine/src/actions/github/client/interface.ts`
- Add `listOpenPullRequests(owner: string, repo: string): Promise<PullRequest[]>` to the `GitHubClient` interface under PR Operations section

### T007 [US4] Implement `listOpenPullRequests` in `GhCliGitHubClient`
**File**: `packages/workflow-engine/src/actions/github/client/gh-cli.ts`
- Implement using `gh pr list -R {owner}/{repo} --state open --json number,title,body,state,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,labels,createdAt,updatedAt --limit 100`
- Map the JSON output to `PullRequest[]` type (handle field name differences between gh CLI JSON and our types — e.g., `headRefName` → `head.ref`, `isDraft` → `draft`)
- Handle empty result (no open PRs) gracefully

### T008 [US1] Add `tryMarkProcessed` atomic method to `PhaseTrackerService`
**File**: `packages/orchestrator/src/services/phase-tracker-service.ts`
- Add `tryMarkProcessed(owner, repo, issue, phase): Promise<boolean>` method
- Use Redis `SET key value EX ttl NX` for atomic check-and-set
- Return `true` if this call won the race (key was set — not a duplicate)
- Return `false` if already processed (duplicate)
- If Redis unavailable, return `true` (graceful degradation — treat as not duplicate)
- Add to `PhaseTracker` interface in `types/monitor.ts`

---

## Phase 2: PR-to-Issue Linking

### T009 [US3] Create `PrLinker` utility class
**File**: `packages/orchestrator/src/worker/pr-linker.ts` (NEW)
- Implement `parsePrBody(body: string): number | null` — regex for closing keywords (`close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved #N`, case-insensitive, word-boundary aware); return first matched issue number only
- Implement `parseBranchName(branch: string): number | null` — regex for `^(\d+)-` pattern; return captured number or null
- Implement `async linkPrToIssue(github: GitHubClient, owner: string, repo: string, pr: { number: number; body: string; head: { ref: string } }): Promise<PrToIssueLink | null>`:
  - Try PR body first, then branch name fallback
  - Verify linked issue exists and has an `agent:*` label (call `github.getIssue()`, check labels)
  - Return `null` for unlinked or non-orchestrated PRs
  - Log which linking method succeeded

### T010 [P] [US3] Write unit tests for `PrLinker`
**File**: `packages/orchestrator/src/worker/__tests__/pr-linker.test.ts` (NEW)
- Test `parsePrBody` with: `Closes #42`, `fixes #7`, `Resolves #100`, mixed case, multiple issues (verify first wins), no keywords, empty body
- Test `parseBranchName` with: `42-feature-name`, `7-fix`, `100-`, `not-a-number`, empty string, date-prefixed branches
- Test `linkPrToIssue` with: PR body priority over branch name, non-orchestrated issue (no `agent:*` label), issue not found, both methods failing → null
- Verify > 95% linking accuracy on standard PR conventions (SC-002)

---

## Phase 3: PR Feedback Monitor Service

### T011 [US1] Create `PrFeedbackMonitorService` class
**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` (NEW)
- Constructor: accept `logger`, `createClient: GitHubClientFactory`, `phaseTracker: PhaseTracker`, `queueAdapter: QueueAdapter`, `config: PrMonitorConfig`, `repositories: RepositoryConfig[]`
- Maintain internal state: `MonitorState` (isPolling, webhookHealthy, lastWebhookEvent, currentPollIntervalMs, basePollIntervalMs)
- Implement `getState(): Readonly<MonitorState>`
- Implement `recordWebhookEvent(): void` — update `lastWebhookEvent` and `webhookHealthy`, reset poll interval to base

### T012 [US1] Implement `processPrReviewEvent()` in monitor service
**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
- Accept `PrReviewEvent` and return `Promise<boolean>` (processed or not)
- Create `GitHubClient` via factory
- Use `PrLinker.linkPrToIssue()` to find linked issue
- If not linked → return false
- Fetch PR review comments via `github.getPRComments()`, filter for `resolved === false`
- If no unresolved threads → return false
- Deduplicate via `phaseTracker.tryMarkProcessed(owner, repo, issue, 'address-pr-feedback')` — if duplicate, return false
- Resolve workflow name from issue labels (`process:*` or `completed:*` prefix)
- Build `QueueItem` with `command: 'address-pr-feedback'`, `metadata: { prNumber, reviewThreadIds }`
- Enqueue via `queueAdapter.enqueue()`
- Add `waiting-for:address-pr-feedback` label to linked issue
- Return true

### T013 [US4] Implement polling loop in monitor service
**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
- Implement `startPolling(): Promise<void>` — infinite loop with adaptive interval, controlled by `isPolling` flag
- Implement `stopPolling(): void` — set `isPolling` to false for graceful exit
- Implement `poll(): Promise<void>` — single poll cycle across all watched repositories
- Implement `pollRepo(owner, repo): Promise<void>`:
  - Call `github.listOpenPullRequests(owner, repo)`
  - For each open PR: link to issue, check for unresolved threads
  - When multiple PRs exist for same issue: process only the most recently updated PR (FR-015), log warning for skipped older PRs
  - Call `processPrReviewEvent()` for eligible PRs (builds `PrReviewEvent` with `source: 'poll'`)
- Use semaphore for `maxConcurrentPolls` across all repos (mirror `LabelMonitorService` pattern)
- Handle GitHub API rate limits gracefully (log warning, continue)

### T014 [US4] Implement adaptive polling in monitor service
**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
- In polling loop, calculate effective interval:
  - If `adaptivePolling` enabled and no webhook received in `2 * basePollIntervalMs` → decrease interval by 50% (divide by 2)
  - Minimum interval: 10 seconds
  - When `recordWebhookEvent()` is called → reset to `basePollIntervalMs`
- Update `currentPollIntervalMs` in state for observability
- Log when switching between normal and adaptive polling modes

### T015 [P] [US1] Write unit tests for `PrFeedbackMonitorService`
**File**: `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts` (NEW)
- Test `processPrReviewEvent`: successful enqueue, duplicate detection, unlinked PR, no unresolved threads, non-orchestrated issue
- Test polling: detects unresolved threads within one cycle (SC-003), skips non-watched repos
- Test deduplication: concurrent webhook+poll produce 0 duplicate enqueues (SC-004)
- Test adaptive polling: interval decrease when webhooks unhealthy, reset when webhook received
- Test workflow name resolution from issue labels
- Test graceful shutdown: stopPolling terminates polling loop
- Test multiple PRs per issue: only most recent processed (FR-015)

---

## Phase 4: Webhook Route

### T016 [US1] Create PR review webhook route
**File**: `packages/orchestrator/src/routes/pr-webhooks.ts` (NEW)
- Define `PrWebhookRouteOptions` interface: `monitorService: PrFeedbackMonitorService`, `webhookSecret?: string`, `watchedRepos: Set<string>`
- Implement `setupPrWebhookRoutes(server: FastifyInstance, options: PrWebhookRouteOptions): Promise<void>`
- Register `POST /webhooks/github/pr-review` endpoint
- Reuse `verifySignature` from existing `webhooks.ts` (extract to shared utility or import — prefer extracting to `packages/orchestrator/src/routes/webhook-utils.ts` if it makes the import cleaner, or just inline the same logic)
- Handle `X-GitHub-Event` header: accept `pull_request_review` and `pull_request_review_comment`, ignore others with 200 response
- For `pull_request_review.submitted`: extract `review`, `pull_request` from payload; check repo is in `watchedRepos`
- For `pull_request_review_comment.created`: extract `comment`, `pull_request` from payload; check repo is in `watchedRepos`
- Build `PrReviewEvent` from payload and call `monitorService.processPrReviewEvent()`
- Call `monitorService.recordWebhookEvent()` for adaptive polling health
- Return `{ status: 'processed' | 'duplicate' | 'ignored' }` with 200 status

### T017 [P] [US1] Write unit tests for PR webhook route
**File**: `packages/orchestrator/src/routes/__tests__/pr-webhooks.test.ts` (NEW)
- Test HMAC signature verification (valid, invalid, missing, no secret configured)
- Test event type filtering (accept `pull_request_review.submitted`, `pull_request_review_comment.created`, ignore others)
- Test repo filtering (accept watched, reject unwatched)
- Test webhook-to-enqueue latency < 500ms (SC-001)
- Test non-review events return 200 (don't trigger GitHub retries)

---

## Phase 5: PR Feedback Handler (Worker Extension)

### T018 [US2] Create `PrFeedbackHandler` class
**File**: `packages/orchestrator/src/worker/pr-feedback-handler.ts` (NEW)
- Constructor: accept `config: WorkerConfig`, `logger: Logger`, `processFactory: ProcessFactory`, `sseEmitter?: SSEEventEmitter`
- Implement `async handle(item: QueueItem, checkoutPath: string): Promise<void>`:
  1. Extract `prNumber` from `item.metadata as PrFeedbackMetadata`
  2. Create `GitHubClient` scoped to `checkoutPath` via `createGitHubClient(checkoutPath)`
  3. Fetch PR via `github.getPullRequest(owner, repo, prNumber)` → get branch name from `pr.head.ref`
  4. Switch to PR branch via `RepoCheckout.switchBranch(checkoutPath, pr.head.ref)` (or create new `RepoCheckout` instance)
  5. Fetch fresh unresolved threads: `github.getPRComments(owner, repo, prNumber)` → filter `resolved === false` (fetch at processing time, not from stale metadata)
  6. If no unresolved threads: remove `waiting-for:address-pr-feedback` label, return early
  7. Build structured prompt containing all unresolved comments with file paths (`comment.path`), line numbers (`comment.line`), author, and body; instruct agent to make changes, commit, push, and reply to each thread
  8. Spawn Claude CLI using `CliSpawner` (or direct `processFactory.spawn`) with the prompt and appropriate timeout
  9. After CLI completes: stage all, commit, push to PR branch
  10. Reply to each unresolved thread via `github.replyToPRComment()` — single consolidated reply per thread explaining what was changed; never call resolve-thread API (SC-006)
  11. Remove `waiting-for:address-pr-feedback` label from linked issue
- Emit SSE events: `workflow:started`, `workflow:progress`, `workflow:completed` with `command: 'address-pr-feedback'` (US5)

### T019 [US2] Implement error handling in `PrFeedbackHandler`
**File**: `packages/orchestrator/src/worker/pr-feedback-handler.ts`
- **Timeout handling** (FR-013): If CLI times out, push any partial changes that were made, keep `waiting-for:address-pr-feedback` label (don't remove), log timeout warning; the label stays so next detection cycle will re-enqueue
- **Reply failure** (FR-007): If posting replies fails for some threads, still remove `waiting-for:address-pr-feedback` label, log warnings for each failed reply; partial reply success is acceptable
- **Thread resolution prevention** (SC-006): Ensure no code path calls any thread-resolve API; only use `replyToPRComment()`
- Structured logging for all operations: feedback detection, prompt building, CLI spawn, push, reply posting, label management, errors (US5)

### T020 [US2] Extend `ClaudeCliWorker.handle()` to route `address-pr-feedback` command
**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`
- Import `PrFeedbackHandler` from `./pr-feedback-handler.js`
- Add early check at the start of `handle()`: if `item.command === 'address-pr-feedback'`, create `PrFeedbackHandler` instance and delegate
- Clone repo + checkout default branch (reuse existing logic): call `repoCheckout.getDefaultBranch()` and `repoCheckout.ensureCheckout()`
- Pass `checkoutPath` to `handler.handle(item, checkoutPath)` — the handler will switch to the PR branch internally
- Early return after handler completes — do not fall through to phase resolver / phase loop logic (FR-012)
- Ensure SSE `workflow:started` event is emitted before delegation (already exists at line 114)
- Wrap handler call in try/catch to emit `workflow:failed` SSE on error (match existing error handling pattern)

### T021 [P] [US2] Write unit tests for `PrFeedbackHandler`
**File**: `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts` (NEW)
- Test PR branch checkout (not default branch)
- Test fresh unresolved thread fetch at processing time
- Test prompt contains all comments with file paths and line numbers
- Test push to PR branch after CLI completes
- Test single consolidated reply per thread (SC-005)
- Test threads never auto-resolved (SC-006): verify `replyToPRComment` is called but never any resolve API
- Test `waiting-for:address-pr-feedback` label removed on completion
- Test timeout: partial changes pushed, label kept
- Test reply failure: label still removed, warnings logged
- Test no unresolved threads at processing time: early return, label removed
- Test SSE events emitted (workflow:started, workflow:completed)

### T022 [P] [US2] Write tests for `ClaudeCliWorker` `address-pr-feedback` routing
**File**: `packages/orchestrator/src/worker/__tests__/claude-cli-worker.test.ts` (EXTEND existing or NEW)
- Test `address-pr-feedback` command routes to `PrFeedbackHandler`
- Test early return (no phase loop execution)
- Test repo checkout is performed before handler delegation
- Test error handling wraps handler errors

---

## Phase 6: Server Integration

### T023 [US1] Initialize `PrFeedbackMonitorService` in server startup
**File**: `packages/orchestrator/src/server.ts`
- After label monitor setup (~line 188): create `PrFeedbackMonitorService` when `config.prMonitor.enabled` and `config.repositories.length > 0`
- Create a `PhaseTrackerService` instance (can share Redis client)
- Use `redisQueueAdapter ?? fallback logging adapter` pattern (match existing label monitor)
- Store as `prFeedbackMonitorService` variable

### T024 [US1] Register PR webhook routes in server
**File**: `packages/orchestrator/src/server.ts`
- After issue webhook routes (~line 219): if `prFeedbackMonitorService` exists, call `setupPrWebhookRoutes(server, { monitorService, webhookSecret, watchedRepos })`
- Import `setupPrWebhookRoutes` from `./routes/pr-webhooks.js`

### T025 [US1] Add auth skip for PR webhook endpoint
**File**: `packages/orchestrator/src/server.ts`
- Add `/webhooks/github/pr-review` to `skipRoutes` array in `createAuthMiddleware` call (line 109)

### T026 [US4] Add lifecycle hooks for PR monitor service
**File**: `packages/orchestrator/src/server.ts`
- In `onReady` hook (~line 230): if `prFeedbackMonitorService`, call `prFeedbackMonitorService.startPolling()` in background (non-blocking, with `.catch()` error log)
- In graceful shutdown cleanup (~line 253): if `prFeedbackMonitorService`, call `prFeedbackMonitorService.stopPolling()`

### T027 [P] [US5] Verify SSE event integration
**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`
- Verify that the existing `sseEmitter` is passed through to `PrFeedbackHandler` when routing `address-pr-feedback` command
- Ensure SSE events include `command: 'address-pr-feedback'` in the data payload for dashboard filtering

---

## Phase 7: Testing and Validation

### T028 [US1] Write integration test: webhook → enqueue → worker flow
**File**: `packages/orchestrator/src/__tests__/pr-feedback-integration.test.ts` (NEW)
- End-to-end test with mocked GitHub API:
  1. Send PR review webhook event to `/webhooks/github/pr-review`
  2. Verify event is processed and enqueued
  3. Verify `waiting-for:address-pr-feedback` label is added
  4. Verify queue item has correct `command` and `metadata`
- Test webhook-to-enqueue latency < 500ms (SC-001)

### T029 [P] [US4] Write integration test: polling fallback
**File**: `packages/orchestrator/src/__tests__/pr-feedback-integration.test.ts`
- Disable webhooks, verify polling detects unresolved threads within one cycle (SC-003)
- Verify adaptive polling increases frequency when no webhooks received

### T030 [P] [US1] Write integration test: deduplication
**File**: `packages/orchestrator/src/__tests__/pr-feedback-integration.test.ts`
- Send identical events via webhook + poll concurrently
- Verify single queue item (SC-004: 0 duplicate enqueues)

### T031 [US2] Write integration test: worker processes feedback end-to-end
**File**: `packages/orchestrator/src/__tests__/pr-feedback-integration.test.ts`
- Mock GitHub API and CLI spawner
- Verify: PR branch checkout, unresolved thread fetch, prompt construction, push, reply to each thread, label removal
- Verify reply completeness: all unresolved threads receive agent reply (SC-005)
- Verify thread auto-resolve prevention: resolved status unchanged (SC-006)

### T032 [US2] Write integration test: multiple PRs per issue
**File**: `packages/orchestrator/src/__tests__/pr-feedback-integration.test.ts`
- Create scenario with 2 PRs linked to same issue
- Verify only the most recently updated PR is processed (FR-015)
- Verify warning logged for skipped older PR

### T033 [US2] Write integration test: partial failure scenarios
**File**: `packages/orchestrator/src/__tests__/pr-feedback-integration.test.ts`
- Test worker timeout → partial changes pushed, label kept for retry (FR-013)
- Test reply posting failure → label still removed, warnings logged (FR-007)

### T034 Build verification
**Files**:
- All modified packages
- Run `pnpm build` across all packages to verify TypeScript compilation
- Run `pnpm test` to verify all existing tests still pass
- Run new test suites to verify all new tests pass

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 must complete before Phase 2 (types needed by PrLinker)
- Phase 1 must complete before Phase 3 (types + config needed by monitor service)
- Phase 2 must complete before Phase 3 (PrLinker used by monitor service)
- Phase 3 must complete before Phase 4 (monitor service used by webhook route)
- Phases 3 + 4 must complete before Phase 5 (monitor enqueues items handled by worker)
- Phases 3 + 4 + 5 must complete before Phase 6 (server wires everything together)
- Phase 6 must complete before Phase 7 integration tests (server integration required)

**Parallel opportunities within phases**:

*Phase 1*: T002, T003, T004, T005, T006 can all run in parallel (different files, no dependencies). T001 should run first (defines types used by T008). T007 depends on T006. T008 depends on T001 (for `PhaseTracker` interface update).

*Phase 2*: T009 and T010 are sequential (implementation before tests), but T010 can begin once T009 is done.

*Phase 3*: T011 → T012 → T013 → T014 are sequential (building up the service). T015 can run in parallel once T014 is done.

*Phase 4*: T016 → T017 are sequential. T016 depends on Phase 3 (needs monitor service type).

*Phase 5*: T018 → T019 are sequential (error handling builds on handler). T020 depends on T018. T021 and T022 are parallel with each other, depend on T018-T020.

*Phase 6*: T023 → T024 → T025 → T026 are sequential (server wiring). T027 is parallel.

*Phase 7*: T028-T033 can all run in parallel. T034 depends on all prior tasks.

**Critical path** (longest sequential dependency chain):
T001 → T008 → T009 → T011 → T012 → T013 → T014 → T016 → T018 → T019 → T020 → T023 → T024 → T025 → T026 → T028 → T034

---

## Phase 8: Documentation

### T035 [P] Document PR monitor configuration
**File**: `packages/orchestrator/README.md` (EXTEND)
- Add PR Monitor section explaining purpose and architecture
- Document all environment variables: `PR_MONITOR_ENABLED`, `PR_MONITOR_POLL_INTERVAL_MS`, `PR_MONITOR_WEBHOOK_SECRET`, `PR_MONITOR_ADAPTIVE_POLLING`, `PR_MONITOR_MAX_CONCURRENT_POLLS`
- Document adaptive polling behavior and webhook health monitoring
- Add example configuration
- Link to deployment guide

### T036 [P] Create PR feedback monitor deployment guide
**File**: `docs/PR_FEEDBACK_MONITOR.md` (NEW)
- **GitHub Webhook Setup**: Step-by-step instructions for configuring webhook (payload URL, secret, event selection)
- **Rollout Strategy**: Phase 1 (disabled), Phase 2 (polling only), Phase 3 (webhook on test repo), Phase 4 (production)
- **Monitoring**: Key metrics (webhook latency, polling cycle duration, API rate usage, dedup rate, timeout rate, reply success rate)
- **Alerts**: Webhook signature failures, API rate limits, polling failures, timeout spikes, Redis connection failures
- **Troubleshooting**: Common issues (webhook delivery, signature verification, PR linking failures, worker timeouts)

### T037 [P] Document Redis schema changes
**File**: `docs/REDIS_SCHEMA.md` (EXTEND or NEW)
- Document new key pattern: `phase-tracker:{owner}:{repo}:{issue}:address-pr-feedback` (TTL: 24h)
- Document queue item metadata field schema: `PrFeedbackMetadata`
- Note: no migration required (all changes are additive)
- Add example queue item with metadata

### T038 [P] Update architecture documentation
**File**: `docs/ARCHITECTURE.md` (EXTEND)
- Add `PrFeedbackMonitorService` to orchestrator services diagram
- Add PR webhook route to API diagram
- Add data flow diagram: GitHub → webhook/poll → monitor → queue → worker → GitHub
- Show integration with `PhaseTrackerService`, `RedisQueueAdapter`, `WorkerDispatcher`, `ClaudeCliWorker`

### T039 [P] Add feature to CHANGELOG
**File**: `CHANGELOG.md` (EXTEND)
- Add new section for PR Feedback Monitor feature
- List key capabilities: webhook + polling detection, atomic deduplication, automated feedback addressing
- Note breaking changes: none (additive only)
- Reference user stories US1-US5

---

## Phase 9: Final Validation

### T040 Run comprehensive test suite
**Command**: `pnpm test`
- Execute all unit tests across packages
- Execute all integration tests
- Verify all new tests pass
- Verify no regressions in existing tests
- Generate coverage report: target >80% for new files

### T041 Verify success criteria
**Tests**: Review test results against spec success criteria
- **SC-001**: Webhook-to-enqueue latency < 500ms (T028)
- **SC-002**: PR-to-issue linking accuracy > 95% (T010: 100+ format variations)
- **SC-003**: Polling fallback coverage 100% (T029)
- **SC-004**: Deduplication effectiveness 0 duplicates (T030)
- **SC-005**: Reply completeness 100% (T031)
- **SC-006**: Thread auto-resolve prevention 0% (T031)
- **SC-007**: Worker timeout recovery 100% (T033)
- **SC-008**: Workflow name resolution accuracy 100% (T015)

### T042 Type checking and linting
**Commands**: `pnpm typecheck`, `pnpm lint`
- Run TypeScript compiler across all packages
- Verify no type errors
- Run ESLint across all modified files
- Fix any linting issues
- Run Prettier to ensure consistent formatting

### T043 Manual testing: webhook flow
**Environment**: Test deployment
- Deploy orchestrator to test environment
- Configure GitHub webhook on test repository
- Create test PR with review comments on orchestrated issue
- Submit review comments
- Verify webhook received within 500ms
- Verify queue item created with correct metadata
- Verify worker processes item
- Verify agent addresses feedback, commits, pushes
- Verify agent posts replies to review threads
- Verify threads not auto-resolved
- Verify label removed from issue
- Check dashboard SSE events display correctly

### T044 Manual testing: polling fallback
**Environment**: Test deployment
- Disable webhook (don't configure on GitHub)
- Enable polling: `PR_MONITOR_ENABLED=true`, `PR_MONITOR_POLL_INTERVAL_MS=30000`
- Create test PR with review comments
- Wait for poll cycle (observe logs)
- Verify PR detected within one poll cycle
- Verify processing identical to webhook flow
- Monitor adaptive polling behavior: create unresolved threads, observe interval changes when no webhooks

### T045 Manual testing: edge cases
**Environment**: Test deployment
- **Multiple PRs per issue**: Create 2 PRs for same issue, verify most recent processed only
- **Non-orchestrated PR**: Create PR linked to non-orchestrated issue (no `agent:*` label), verify ignored
- **PR with no linked issue**: Create PR without closing keywords or issue number in branch, verify ignored
- **PR linking priority**: Create PR with closing keyword in body AND issue number in branch name (different issues), verify body wins
- **Worker timeout**: Create PR with large number of complex review comments, reduce `phaseTimeoutMs`, verify partial completion and label retention
- **Reply posting failure**: Mock GitHub API to fail on some reply calls, verify partial success (label still removed)

### T046 Performance testing: GitHub API rate limits
**Environment**: Test deployment
- Configure multiple watched repositories (5+)
- Enable polling with default interval (60s)
- Monitor GitHub API usage via `gh api rate_limit` over 1 hour
- Verify usage stays under 80% of limit (5000 calls/hour)
- Test concurrent polling: verify `maxConcurrentPolls` respected (check logs for semaphore queueing)
- Create multiple PRs with review comments, verify webhook processing doesn't spike API usage

### T047 Performance testing: Redis and queue throughput
**Environment**: Test deployment with Redis
- Create 20+ PRs with review comments across multiple repositories
- Trigger simultaneous webhook events (use GitHub webhook redeliver)
- Verify atomic deduplication: check Redis for exactly one phase-tracker key per PR-issue pair
- Verify queue throughput: all items enqueued within 2 seconds
- Verify worker dispatch: items processed in priority order

### T048 Integration validation: dashboard streaming
**Environment**: Test deployment with dashboard frontend
- Open dashboard in browser
- Create PR with review comments
- Submit review
- Verify `workflow:started` event appears in dashboard active workflows
- Verify `workflow:progress` events stream agent output in real-time
- Verify `workflow:completed` event updates workflow status
- Check event metadata includes: `command: 'address-pr-feedback'`, PR number, issue number

### T049 Security validation
**Tests**: Security review
- Verify webhook HMAC-SHA256 signature validation works correctly
- Test invalid signatures are rejected (401 response)
- Test missing signatures handled gracefully
- Verify PR webhook route bypasses auth middleware (in skipRoutes)
- Review agent prompt for injection risks (ensure review comment bodies are properly escaped)
- Verify git operations use safe practices (no command injection via branch names or PR bodies)

### T050 Final cleanup and polish
**Files**: All modified files
- Remove any debug logging or TODOs
- Ensure all comments are accurate and helpful
- Verify all imports are used (no unused imports)
- Ensure consistent error handling patterns across new files
- Review variable names for clarity
- Update any stale inline documentation

### T051 Pre-merge checklist
**Tasks**: Final verification before merge
- [ ] All unit tests passing
- [ ] All integration tests passing
- [ ] All manual tests completed successfully
- [ ] All success criteria validated (SC-001 through SC-008)
- [ ] Documentation complete (README, deployment guide, architecture docs)
- [ ] CHANGELOG updated
- [ ] No TypeScript errors
- [ ] No linting errors
- [ ] Code review ready (self-review completed)
- [ ] Performance metrics within targets (API rate usage <80%, webhook latency <500ms)

---

## Success Criteria Validation Matrix

| ID | Metric | Target | Validation Method | Task |
|----|--------|--------|-------------------|------|
| SC-001 | Webhook-to-enqueue latency | < 500ms | Timestamp delta in integration test | T028, T043 |
| SC-002 | PR-to-issue linking accuracy | > 95% | Unit tests with 100+ PR format variations | T010 |
| SC-003 | Polling fallback coverage | 100% | Integration test with webhooks disabled | T029, T044 |
| SC-004 | Deduplication effectiveness | 0 duplicates | Concurrent webhook + poll race test | T030, T047 |
| SC-005 | Reply completeness | 100% | Verify all unresolved threads receive reply | T031, T043 |
| SC-006 | Thread auto-resolve prevention | 0% | Verify no resolve API calls in handler | T021, T031, T043 |
| SC-007 | Worker timeout recovery | 100% | Timeout simulation test verifying push + label retention | T033, T045 |
| SC-008 | Workflow name resolution accuracy | 100% | Label parsing tests across all workflow types | T015 |

---

## Risk Mitigation Tracking

| Risk | Mitigation | Validation Task |
|------|------------|-----------------|
| GitHub API rate limits | `maxConcurrentPolls=3`, webhook-first, adaptive polling | T046 |
| Webhook delivery failures | Polling fallback within 60s, adaptive frequency | T029, T044 |
| PR-to-issue linking failures | Dual strategy (body + branch), `agent:*` label check | T010, T045 |
| Worker timeout on large PRs | Partial completion strategy: push changes, keep label | T033, T045 |
| Webhook + poll race conditions | Atomic `SET NX` deduplication | T030, T047 |
| Reply posting failures | Partial success: remove label, log warnings | T033, T045 |
| Conflicting review comments | Agent attempts all, conflicts left for human | T045 |
| Branch protection rules | Document bot push permissions requirement | T036 |

---

## Implementation Notes

### Type Safety
- All new types are exported from appropriate barrel files
- Existing interfaces extended with proper type guards
- Metadata field uses discriminated union pattern for type safety
- All GitHub API responses typed according to actual `gh` CLI output

### Error Handling
- All async operations wrapped in try-catch with structured logging
- Partial failure strategies documented and tested (timeout, reply failures)
- Graceful degradation when Redis unavailable (monitoring continues, no dedup)
- Non-critical errors (reply failures) don't block completion

### Testing Strategy
- Unit tests for all business logic (parsing, linking, enqueueing)
- Integration tests for end-to-end flows (webhook → queue → worker)
- Performance tests for API rate limits and throughput
- Manual tests for UI/UX validation (dashboard SSE events)
- All success criteria have automated + manual validation

### Configuration
- All config values have sensible defaults
- Environment variables follow existing naming convention
- Adaptive polling can be disabled via config flag
- Webhook secret is optional (for local testing)

### Observability
- Structured logging at all key decision points
- SSE events for real-time dashboard updates
- `MonitorState` exposes internal state for debugging
- GitHub API call logging for rate limit tracking
- Phase tracker keys use descriptive names for Redis debugging

---

**Status**: Ready for implementation
**Last Updated**: 2026-02-21
**Total Tasks**: 51 (34 implementation + 17 testing/validation)
**Estimated Effort**: 8-10 development days (with parallel execution opportunities)
