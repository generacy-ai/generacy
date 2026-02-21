# Feature Specification: PR Feedback Monitor

**Branch**: `199-description-implement-pr` | **Date**: 2026-02-21 | **Status**: Draft

## Summary

The PR Feedback Monitor is an orchestrator component that automatically detects unresolved review comments on pull requests linked to orchestrated issues and triggers an automated feedback-addressing flow. The system uses a hybrid webhook + polling architecture to ensure reliable detection, atomically enqueues feedback-addressing tasks to prevent duplicates, and spawns Claude agents to read review comments, make code changes, commit and push updates, and reply to review threads—without auto-resolving them.

This feature enables the orchestrator to close the feedback loop on pull requests, reducing manual intervention while maintaining human oversight through the review process.

**Parent Epic**: generacy#195

---

## User Stories

### US1: Webhook-Based PR Review Detection

**As a** developer reviewing orchestrated PRs,
**I want** the orchestrator to immediately detect when I submit review comments,
**So that** feedback addressing begins within seconds of submission.

**Acceptance Criteria**:
- [ ] Orchestrator listens for `pull_request_review.submitted` and `pull_request_review_comment.created` GitHub webhook events
- [ ] Webhook endpoint verifies HMAC-SHA256 signatures to ensure authenticity
- [ ] Only processes events for repositories in the orchestrator's watch list
- [ ] Webhook-to-enqueue latency is under 500ms
- [ ] Non-review events (other GitHub webhook types) are gracefully ignored with 200 OK response

### US2: Automated Feedback Addressing

**As an** orchestrated agent,
**I want** to automatically address PR review feedback by making code changes and replying to threads,
**So that** reviewers see concrete responses without manual developer intervention.

**Acceptance Criteria**:
- [ ] Agent checks out the PR branch (not the default branch)
- [ ] Fresh unresolved review threads are fetched at processing time (not stale metadata from detection)
- [ ] Agent receives a structured prompt with all unresolved comments including file paths, line numbers, and reviewer names
- [ ] Agent makes changes, commits them with clear messages, and pushes to the PR branch
- [ ] Agent posts a single consolidated reply to each review thread explaining the changes
- [ ] Agent never auto-resolves review threads (human reviewer must resolve)
- [ ] `waiting-for:address-pr-feedback` label is removed from the linked issue upon completion

### US3: PR-to-Issue Linking

**As a** developer using standard GitHub conventions,
**I want** the orchestrator to automatically link PRs to orchestrated issues,
**So that** I don't need to manually configure PR-issue relationships.

**Acceptance Criteria**:
- [ ] PR body is parsed for closing keywords (close/closes/closed/fix/fixes/fixed/resolve/resolves/resolved #N)
- [ ] First matched issue number from PR body takes precedence
- [ ] If PR body has no match, branch name is parsed for issue number prefix (e.g., `199-description-implement-pr` → issue #199)
- [ ] Only PRs linked to issues with `agent:*` labels are processed (non-orchestrated issues are ignored)
- [ ] Linking failures are logged with structured metadata for debugging
- [ ] PR-to-issue linking accuracy exceeds 95% on standard GitHub conventions

### US4: Polling Fallback with Adaptive Intervals

**As a** system operator,
**I want** the orchestrator to fall back to polling when webhooks fail,
**So that** review detection remains reliable despite GitHub webhook delivery issues.

**Acceptance Criteria**:
- [ ] Polling checks all open PRs on watched repositories at a configurable interval (default: 60 seconds)
- [ ] Polling interval decreases by 50% when no webhook received in 2x the configured interval (adaptive increase in frequency)
- [ ] Polling interval resets to configured value when a webhook is received (recovery from degraded mode)
- [ ] Maximum concurrent polling operations is limited (default: 3 across all repositories)
- [ ] Polling gracefully stops on orchestrator shutdown without leaving hanging operations
- [ ] Polling detects unresolved threads within one poll cycle when webhooks are disabled

### US5: Dashboard Integration

**As a** project manager monitoring orchestrated workflows,
**I want** to see PR feedback addressing progress in the dashboard,
**So that** I can track agent activity and intervene if needed.

**Acceptance Criteria**:
- [ ] `workflow:started` SSE event is emitted when PR feedback addressing begins
- [ ] `workflow:progress` SSE events stream agent output during processing
- [ ] `workflow:completed` SSE event is emitted upon completion or failure
- [ ] SSE events include `command: 'address-pr-feedback'` and PR number metadata
- [ ] Dashboard displays PR feedback tasks in the active workflows list
- [ ] Dashboard shows linked PR URL and issue number for each feedback task

---

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Monitor PRs for new review comments via GitHub webhooks | P0 | Webhook events: `pull_request_review.submitted`, `pull_request_review_comment.created` |
| FR-002 | Verify webhook HMAC-SHA256 signatures | P0 | Reuse existing `verifySignature` utility from issue webhooks |
| FR-003 | Detect unresolved review threads on PRs | P0 | Ignore review state (`changes_requested`, `approved`, etc.); thread resolution is the source of truth |
| FR-004 | Link PRs to orchestrated issues via PR body keywords or branch naming | P0 | Priority: PR body > branch name. Only process PRs linked to issues with `agent:*` labels |
| FR-005 | Atomically enqueue `address-pr-feedback` command to Redis queue | P0 | Use `SET NX` to prevent webhook+poll race conditions |
| FR-006 | Add `waiting-for:address-pr-feedback` label to linked issue | P1 | Does not modify existing phase labels (`process:*`, `completed:*`) |
| FR-007 | Remove `waiting-for:address-pr-feedback` label when feedback addressed | P1 | Remove even if some thread replies fail (partial success) |
| FR-008 | Worker checks out PR branch and fetches fresh unresolved threads | P0 | Checkout uses `git fetch && git checkout <branch> && git reset --hard origin/<branch>` |
| FR-009 | Build structured prompt with all unresolved comments | P0 | Include file paths, line numbers, reviewer names, and comment bodies |
| FR-010 | Agent makes changes, commits, and pushes to PR branch | P0 | Commit message must clearly indicate feedback is being addressed |
| FR-011 | Post single reply to each review thread | P0 | Reply acknowledges the change; never call thread resolution API |
| FR-012 | Bypass gate system for `address-pr-feedback` command | P1 | Early return in `ClaudeCliWorker.handle()` before phase loop |
| FR-013 | Handle worker timeouts gracefully | P1 | Push partial changes, keep `waiting-for:address-pr-feedback` label, re-enqueue on next detection cycle |
| FR-014 | Resolve workflow name from issue labels | P1 | Query `process:*` or `completed:*` labels on linked issue to determine workflow |
| FR-015 | Handle multiple PRs per issue | P2 | Process only the most recently updated PR |
| FR-016 | Initialize PR monitor service conditionally | P1 | Only start when `prMonitor.enabled = true` and `repositories` list is non-empty |
| FR-017 | Gracefully shutdown PR monitor polling | P1 | Stop polling loop and wait for in-flight operations to complete on orchestrator shutdown |
| FR-018 | Emit SSE events for dashboard streaming | P1 | Reuse existing `workflow:*` event patterns with `command: 'address-pr-feedback'` |
| FR-019 | Concurrent polling across repositories with semaphore | P1 | Limit concurrent `listOpenPullRequests` calls to avoid GitHub API rate limits |
| FR-020 | Adaptive polling interval adjustment | P1 | Mirror `LabelMonitorService` adaptive polling pattern (50% interval decrease when webhooks unhealthy) |

---

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Webhook-to-enqueue latency | < 500ms | Timestamp delta between webhook receipt and Redis queue insertion (measured in integration tests) |
| SC-002 | PR-to-issue linking accuracy | > 95% | Percentage of PRs correctly linked using standard GitHub conventions (measured via unit tests with 100+ format variations) |
| SC-003 | Polling fallback coverage | 100% | When webhooks are disabled, polling detects all unresolved threads within one poll cycle (measured in integration tests) |
| SC-004 | Deduplication effectiveness | 0 duplicates | Concurrent webhook + poll events for same PR result in exactly one queue item (measured via race condition tests) |
| SC-005 | Reply completeness | 100% | All unresolved threads receive agent reply (measured by counting replies vs threads in integration tests) |
| SC-006 | Thread auto-resolve prevention | 0% | Agent never calls GitHub thread resolution API (verified via GitHub API call logs) |
| SC-007 | Worker timeout recovery | 100% | Partial changes are pushed and label is retained for retry (measured in timeout simulation tests) |
| SC-008 | Workflow name resolution accuracy | 100% | Correct workflow identified from issue labels for all orchestrated issues (measured via label parsing tests) |

---

## Technical Architecture

### Components

#### New Components

1. **PrFeedbackMonitorService** (`packages/orchestrator/src/services/pr-feedback-monitor-service.ts`)
   - Core monitoring service
   - Processes webhook events via `processPrReviewEvent()`
   - Runs background polling loop with adaptive intervals
   - Coordinates with `PrLinker` for PR-to-issue linking
   - Uses `PhaseTrackerService` for atomic deduplication
   - Enqueues to Redis via `RedisQueueAdapter`

2. **PrFeedbackHandler** (`packages/orchestrator/src/worker/pr-feedback-handler.ts`)
   - Worker handler for `address-pr-feedback` command
   - Checks out PR branch
   - Fetches fresh unresolved review threads
   - Builds structured feedback prompt
   - Spawns Claude CLI via `CliSpawner`
   - Posts replies to review threads
   - Manages `waiting-for:address-pr-feedback` label lifecycle

3. **PrLinker** (`packages/orchestrator/src/worker/pr-linker.ts`)
   - Utility for PR-to-issue linking
   - Parses PR body for closing keywords
   - Parses branch names for issue number prefix
   - Verifies linked issue has `agent:*` label
   - Returns `PrToIssueLink | null`

4. **PR Webhook Routes** (`packages/orchestrator/src/routes/pr-webhooks.ts`)
   - Fastify route setup for `POST /webhooks/github/pr-review`
   - HMAC-SHA256 signature verification
   - Event type filtering
   - Repository watch list validation

#### Extended Components

1. **QueueItem** type (`packages/orchestrator/src/types/monitor.ts`)
   - Add `'address-pr-feedback'` to command union
   - Add optional `metadata?: Record<string, unknown>` field
   - Add `PrFeedbackMetadata` type with `prNumber` and `reviewThreadIds`

2. **PhaseTrackerService** (`packages/orchestrator/src/services/phase-tracker-service.ts`)
   - Add `tryMarkProcessed()` method using atomic `SET NX` operation
   - Returns `boolean` (true = won race, false = duplicate)

3. **OrchestratorConfigSchema** (`packages/orchestrator/src/config/schema.ts`)
   - Add `PrMonitorConfigSchema` with fields: `enabled`, `pollIntervalMs`, `webhookSecret`, `adaptivePolling`, `maxConcurrentPolls`

4. **ClaudeCliWorker** (`packages/orchestrator/src/worker/claude-cli-worker.ts`)
   - Add early routing for `command === 'address-pr-feedback'`
   - Delegate to `PrFeedbackHandler.handle()` before phase loop

5. **GitHubClient** interface (`packages/workflow-engine/src/actions/github/client/interface.ts`)
   - Add `listOpenPullRequests(owner, repo): Promise<PullRequest[]>` method

6. **GhCliGitHubClient** (`packages/workflow-engine/src/actions/github/client/gh-cli.ts`)
   - Implement `listOpenPullRequests()` via `gh pr list --state open --json ...`

7. **WORKFLOW_LABELS** (`packages/workflow-engine/src/actions/github/label-definitions.ts`)
   - Add new label: `{ name: 'waiting-for:address-pr-feedback', color: 'FBCA04', description: 'Agent is addressing PR review feedback' }`

8. **Server** (`packages/orchestrator/src/server.ts`)
   - Initialize `PrFeedbackMonitorService` if `prMonitor.enabled`
   - Register PR webhook routes
   - Start polling on `onReady` hook
   - Stop polling on graceful shutdown

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                   GitHub PR Review Event                            │
│  (pull_request_review.submitted | pull_request_review_comment)     │
└────────────────────┬───────────────────────────┬────────────────────┘
                     │                           │
              ┌──────▼──────┐            ┌───────▼────────┐
              │   Webhook   │            │    Polling     │
              │ (immediate) │            │  (60s cycle)   │
              └──────┬──────┘            └───────┬────────┘
                     │                           │
                     └──────────┬────────────────┘
                                ▼
                 ┌──────────────────────────────┐
                 │ PrFeedbackMonitorService     │
                 │  .processPrReviewEvent()     │
                 └──────────┬───────────────────┘
                            ▼
                 ┌──────────────────────────────┐
                 │ PrLinker.linkPrToIssue()     │
                 │  (PR body → branch name)     │
                 └──────────┬───────────────────┘
                            ▼
                 ┌──────────────────────────────┐
                 │ PhaseTracker                 │
                 │  .tryMarkProcessed() [SET NX]│
                 │  (atomic deduplication)      │
                 └──────────┬───────────────────┘
                            ▼
                 ┌──────────────────────────────┐
                 │ RedisQueueAdapter.enqueue()  │
                 │  command: 'address-pr-feedback' │
                 │  metadata: { prNumber, ... } │
                 └──────────┬───────────────────┘
                            ▼
                 ┌──────────────────────────────┐
                 │ WorkerDispatcher             │
                 │   → ClaudeCliWorker.handle() │
                 └──────────┬───────────────────┘
                            ▼
                 ┌──────────────────────────────┐
                 │ PrFeedbackHandler            │
                 │  1. Checkout PR branch       │
                 │  2. Fetch fresh threads      │
                 │  3. Build prompt             │
                 │  4. Spawn Claude CLI         │
                 │  5. Commit & push changes    │
                 │  6. Reply to threads         │
                 │  7. Remove label             │
                 └──────────────────────────────┘
```

### GitHub API Usage

| Operation | API Method | Calls per Poll Cycle | Rate Limit Impact |
|-----------|-----------|---------------------|-------------------|
| List open PRs | `gh pr list --state open` | 1 per repository | ~3/min (3 repos × 1/min) |
| Get PR details | `gh pr view <number>` | 1 per PR | ~15/min (5 PRs/repo × 3 repos) |
| Get PR comments | `gh api /repos/{owner}/{repo}/pulls/{number}/comments` | 1 per PR | ~15/min |
| Get issue labels | `gh api /repos/{owner}/{repo}/issues/{number}` | 1 per linked PR | ~15/min |
| Reply to comment | `gh api POST /repos/{owner}/{repo}/pulls/{number}/comments/{id}/replies` | 1 per thread | ~5/min (avg 1 PR × 5 threads) |
| Add label | `gh api POST /repos/{owner}/{repo}/issues/{number}/labels` | 1 per enqueue | ~1/min |
| Remove label | `gh api DELETE /repos/{owner}/{repo}/issues/{number}/labels/{name}` | 1 per completion | ~1/min |

**Total estimated rate usage**: ~55 calls/min = 3,300 calls/hour out of 5,000/hour limit (66% utilization at steady state)

**Mitigation strategies**:
- `maxConcurrentPolls=3` limits API burst
- Webhook-first approach reduces polling frequency
- Adaptive polling decreases interval when webhooks healthy
- Early filtering (watch list, orchestrated issues) reduces unnecessary calls

---

## Configuration

### Environment Variables

```bash
# PR Monitor Configuration
PR_MONITOR_ENABLED=true                    # Enable PR feedback monitoring (default: true)
PR_MONITOR_POLL_INTERVAL_MS=60000          # Polling interval in milliseconds (default: 60000)
PR_MONITOR_WEBHOOK_SECRET=<secret>         # HMAC-SHA256 secret for webhook verification (optional)
PR_MONITOR_ADAPTIVE_POLLING=true           # Enable adaptive polling intervals (default: true)
PR_MONITOR_MAX_CONCURRENT_POLLS=3          # Max concurrent polling operations (default: 3)
```

### Configuration Schema

```typescript
export const PrMonitorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  pollIntervalMs: z.number().int().min(5000).default(60000),
  webhookSecret: z.string().optional(),
  adaptivePolling: z.boolean().default(true),
  maxConcurrentPolls: z.number().int().min(1).max(20).default(3),
});
```

---

## Assumptions

- **GitHub Conventions**: Developers use standard GitHub closing keywords in PR bodies or issue-number-prefixed branch names
- **Orchestrated Issues**: All PRs linked to orchestrated issues have an `agent:*` label on the linked issue
- **Redis Availability**: Redis is available for queue and deduplication operations (graceful degradation if unavailable)
- **Webhook Delivery**: GitHub webhooks are delivered with <5 minute delay under normal conditions
- **Review Thread Structure**: GitHub review comments use `in_reply_to_id` to form threads, and top-level comments have `resolved` field
- **Agent Authority**: Claude CLI agent has permission to push to PR branches (not protected from bot commits)
- **Single Worker**: Only one worker processes a given queue item (no concurrent execution of same task)
- **Review Thread API**: GitHub API `getPRComments()` returns `resolved` field on thread root comments (or fallback to GraphQL if not)
- **Partial Changes Acceptable**: Pushing partial changes on timeout is acceptable (reviewer sees incremental progress)

---

## Out of Scope

### Current Release

- **Automatic thread resolution**: Agent never resolves review threads; human reviewers must manually resolve after verifying changes
- **Multi-round feedback loops**: If reviewer adds new comments after agent addresses first batch, new detection cycle is triggered (no automatic iteration)
- **Reviewer-specific handling**: All review comments treated equally regardless of reviewer identity or review state (approved/changes requested)
- **Draft PR handling**: Draft PRs are processed same as non-draft PRs (no special filtering)
- **Per-thread reply customization**: All replies use same template; agent does not generate custom per-thread explanations
- **Conflicting feedback detection**: Agent attempts all changes even if review comments conflict; conflicts are left for human resolution
- **Cross-PR dependencies**: Each PR is processed independently; no coordination across multiple PRs for same issue
- **Review state changes**: Agent does not re-request review or change PR review state after addressing feedback
- **Inline suggestions**: GitHub inline code suggestions are not auto-applied; agent reads and interprets suggestions as text comments

### Future Enhancements

- **GraphQL thread resolution fallback**: If REST API `resolved` field is unreliable, use GraphQL `reviewThreads.isResolved` query
- **Custom reply generation**: Parse agent output to generate specific per-thread replies describing changes made
- **Reviewer notification**: Mention reviewer in reply (`@reviewer`) to trigger GitHub notification
- **Feedback prioritization**: Process `changes_requested` reviews before `commented` reviews
- **Thread grouping**: Group related threads (same file, same function) and address together
- **Incremental commit strategy**: One commit per thread instead of single commit for all changes
- **Feedback metrics**: Track time-to-address, feedback iteration count, resolution rate
- **Approval automation**: Auto-request re-review when all threads addressed (optional config)

---

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **GitHub API rate limits** | Medium | High | `maxConcurrentPolls=3`, webhook-first approach, early filtering, adaptive polling reduces frequency when webhooks healthy |
| **Webhook delivery failures** | Medium | Medium | Polling fallback detects within 60s, adaptive polling increases frequency when webhooks unhealthy |
| **PR-to-issue linking failures** | Medium | Medium | Dual strategy (PR body + branch name), verify `agent:*` label, structured logging for debugging |
| **Worker timeout on large PRs** | Medium | Medium | Partial completion strategy: push changes, keep label, retry on next cycle |
| **Webhook + poll race conditions** | Medium | Low | Atomic `SET NX` in `PhaseTracker.tryMarkProcessed()` guarantees exactly-once enqueue |
| **Thread reply failures** | Low | Low | Partial success: remove label, log warnings, reviewer sees commits even without replies |
| **Conflicting review comments** | Low | Medium | Agent attempts all changes, conflicts left for human resolution (documented in prompt) |
| **Branch protection rules** | Low | High | Document requirement for bot push permissions, validate in deployment guide |
| **Multiple workers claiming same item** | Very Low | Low | Redis queue claim mechanism prevents concurrent processing |
| **Stale review threads** | Low | Low | Fresh fetch at processing time ensures agent sees latest thread state |

---

## Testing Strategy

### Unit Tests

| Component | Test Coverage |
|-----------|--------------|
| `PrLinker` | PR body parsing (all closing keyword variations), branch name parsing (standard + edge cases), priority (body > branch), orchestration check |
| `PrFeedbackMonitorService` | Polling logic, enqueue logic, dedup, adaptive polling interval changes, workflow name resolution |
| `PrFeedbackHandler` | Branch checkout, prompt building, thread reply posting, label management, timeout handling |
| `PhaseTrackerService.tryMarkProcessed()` | Atomic SET NX behavior, race condition prevention, TTL expiry |
| `QueueItem` metadata | Serialization/deserialization with metadata field |
| Config schema | Validation, defaults, env var mapping |

### Integration Tests

| Scenario | Validates |
|----------|-----------|
| Webhook → enqueue → worker → reply | End-to-end flow with mocked GitHub API |
| Polling fallback (webhooks disabled) | SC-003: polling detects within one cycle |
| Concurrent webhook + poll | SC-004: exactly-once enqueue via atomic dedup |
| Worker timeout → partial completion | FR-013: partial changes pushed, label retained |
| Multiple PRs per issue | FR-015: most recent PR processed only |
| Reply posting failure | FR-007: label removed, warnings logged |
| Non-orchestrated PR | Ignored (no `agent:*` label) |
| PR without linked issue | Ignored (linking returns null) |

### Success Criteria Validation

Automated tests measure each success criterion:
- **SC-001**: Timestamp delta in webhook integration test
- **SC-002**: 100+ PR format variations in unit tests
- **SC-003**: Polling integration test with webhooks disabled
- **SC-004**: Concurrent webhook+poll race test
- **SC-005**: Reply count vs thread count in integration test
- **SC-006**: GitHub API call log inspection (no resolve calls)
- **SC-007**: Timeout simulation test verifying push + label retention
- **SC-008**: Label parsing accuracy across all workflow types

---

## Deployment Guide

### GitHub Webhook Setup

1. Navigate to repository settings → Webhooks
2. Add webhook:
   - **Payload URL**: `https://orchestrator.example.com/webhooks/github/pr-review`
   - **Content type**: `application/json`
   - **Secret**: Set `PR_MONITOR_WEBHOOK_SECRET` environment variable
   - **Events**: Select "Let me select individual events"
     - ✅ Pull request reviews
     - ✅ Pull request review comments
3. Save webhook
4. Verify delivery in GitHub webhook delivery logs

### Rollout Strategy

**Phase 1: Validation**
- Deploy with `PR_MONITOR_ENABLED=false`
- Verify orchestrator starts without errors
- Check config parsing and validation

**Phase 2: Polling Only**
- Set `PR_MONITOR_ENABLED=true`
- Do **not** configure webhook yet
- Monitor logs for polling cycles
- Verify PR detection and linking

**Phase 3: Webhook Integration**
- Configure webhook on test repository
- Test with sample PR review
- Verify end-to-end flow
- Check SSE events in dashboard

**Phase 4: Production**
- Enable for production repositories
- Monitor GitHub API rate usage
- Adjust `pollIntervalMs` if needed
- Set up alerting for webhook failures

### Monitoring

**Key Metrics**:
- Webhook-to-enqueue latency (target: <500ms)
- Polling cycle duration (target: <10s per repo)
- GitHub API rate limit usage (target: <80%)
- Deduplication rate (target: <1% duplicates)
- Worker timeout rate (target: <5%)
- Thread reply success rate (target: >95%)

**Alerts**:
- Webhook signature validation failures
- GitHub API rate limit approaching (>90%)
- Polling cycle failures
- Worker timeout rate >10%
- Redis connection failures

### Redis Schema

**New Keys**:
- `phase-tracker:{owner}:{repo}:{issue}:address-pr-feedback` (TTL: 24h)
  - Value: `"1"`
  - Purpose: Deduplication

**Queue Items**:
- Existing `orchestrator:queue:pending` sorted set
- New queue items include optional `metadata` field:
  ```json
  {
    "owner": "org",
    "repo": "repo",
    "issueNumber": 199,
    "workflowName": "feature-development",
    "command": "address-pr-feedback",
    "priority": 5,
    "enqueuedAt": "2026-02-21T12:00:00Z",
    "metadata": {
      "prNumber": 42,
      "reviewThreadIds": [101, 102, 103]
    }
  }
  ```

**No Migration Required**: All changes are additive; existing queue items without metadata remain compatible.

---

## Dependencies

### External Services
- **GitHub**: Webhook delivery, API access (gh CLI)
- **Redis**: Queue, deduplication, heartbeat

### Internal Packages
- `@generacy-ai/workflow-engine`: GitHubClient, label definitions
- `@generacy-ai/orchestrator`: Existing services (PhaseTracker, RedisQueueAdapter, WorkerDispatcher)

### Required Permissions
- **GitHub Token**: `repo` scope for PR read/write, issue labels, PR comments
- **Redis**: Read/write access to `orchestrator:*` keys
- **Git**: Push access to PR branches (not blocked by branch protection)

---

## Open Questions

*All clarification questions have been resolved. See [clarifications.md](./clarifications.md) for detailed answers.*

---

## Revision History

| Date | Version | Changes | Author |
|------|---------|---------|--------|
| 2026-02-21 | 1.0 | Initial comprehensive specification | Claude Sonnet 4.5 |

---

*Generated by speckit*
