# Tasks: Webhook Auto-Configuration for Smee

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Core Service Implementation

### T001 Create WebhookSetupService class structure
**File**: `packages/orchestrator/src/services/webhook-setup-service.ts`
- Create class with pino-style logger constructor
- Define main method signature: `ensureWebhooks(smeeChannelUrl, repositories)`
- Add private helper method stubs:
  - `ensureWebhookForRepo(owner, repo, smeeChannelUrl)`
  - `listRepoWebhooks(owner, repo)`
  - `createRepoWebhook(owner, repo, smeeChannelUrl)`
  - `updateRepoWebhook(owner, repo, webhookId, updates)`
- Define return types: `WebhookSetupSummary`, `WebhookSetupResult`
- Add JSDoc comments for public methods

### T002 Implement webhook listing logic
**File**: `packages/orchestrator/src/services/webhook-setup-service.ts`
- Implement `listRepoWebhooks()` using `executeCommand` utility
- Call `gh api GET /repos/{owner}/{repo}/hooks`
- Parse JSON response to `GitHubWebhook[]` type
- Handle parse errors gracefully
- Return empty array on error

### T003 Implement webhook matching logic
**File**: `packages/orchestrator/src/services/webhook-setup-service.ts`
- Add case-insensitive URL comparison helper
- Match on `config.url` field only
- Return matching webhook or undefined
- No URL normalization (simple string comparison)

### T004 Implement webhook creation logic
**File**: `packages/orchestrator/src/services/webhook-setup-service.ts`
- Implement `createRepoWebhook()` using `executeCommand`
- Call `gh api POST /repos/{owner}/{repo}/hooks`
- Body: `{ config: { url, content_type: "json" }, events: ["issues"], active: true }`
- Return webhook ID on success
- Throw error on failure (caught by caller)

### T005 Implement webhook reactivation with event merge
**File**: `packages/orchestrator/src/services/webhook-setup-service.ts`
- Implement `updateRepoWebhook()` using `executeCommand`
- Call `gh api PATCH /repos/{owner}/{repo}/hooks/{hook_id}`
- Merge existing events: `[...new Set([...existingEvents, "issues"])]`
- Single PATCH call updates both `active: true` and merged events
- Return success/failure

### T006 Implement per-repo orchestration logic
**File**: `packages/orchestrator/src/services/webhook-setup-service.ts`
- Implement `ensureWebhookForRepo()`:
  - List existing webhooks
  - Check for matching webhook
  - If none: create new → return `action: 'created'`
  - If active match: skip → return `action: 'skipped'`
  - If inactive match: reactivate + merge events → return `action: 'reactivated'`
  - If event mismatch: log warning → return `action: 'skipped'`
- Per-repo error handling with try/catch
- Return `WebhookSetupResult` for each repo

### T007 Implement ensureWebhooks main method
**File**: `packages/orchestrator/src/services/webhook-setup-service.ts`
- Loop through all repositories
- Call `ensureWebhookForRepo()` for each
- Catch per-repo errors, log warnings, continue
- Aggregate results into `WebhookSetupSummary`
- Count totals: created, skipped, reactivated, failed
- Return summary

### T008 Add error handling and logging
**File**: `packages/orchestrator/src/services/webhook-setup-service.ts`
- Handle 403/404 errors: log warning with "Insufficient permissions (admin:repo_hook required)"
- Handle 500 errors: log warning with "GitHub API error"
- Handle network errors: log warning with error message
- All errors return `action: 'failed'` with error message
- Log levels:
  - `info`: created, skipped, reactivated
  - `warn`: permissions, event mismatches, errors
  - `error`: unexpected failures

### T009 Add Smee URL validation warning
**File**: `packages/orchestrator/src/services/webhook-setup-service.ts`
- Check if URL starts with `https://smee.io/`
- If not: log warning: "SMEE_CHANNEL_URL does not point to smee.io — ensure this URL is correct"
- Continue with auto-config (support self-hosted proxies)
- Add check to `ensureWebhooks()` method

### T010 [P] Define webhook types
**File**: `packages/orchestrator/src/types/index.ts`
- Define `GitHubWebhook` interface:
  - `id: number`
  - `active: boolean`
  - `config: { url: string }`
  - `events: string[]`
- Add JSDoc comments
- Export type

### T011 [P] Export WebhookSetupService
**File**: `packages/orchestrator/src/services/index.ts`
- Export `WebhookSetupService` class
- Export `WebhookSetupSummary` type
- Export `WebhookSetupResult` type

### T012 Write unit tests for webhook listing
**File**: `packages/orchestrator/src/services/__tests__/webhook-setup-service.test.ts`
- Mock `executeCommand` utility
- Test `listRepoWebhooks()`:
  - Success case: returns parsed webhooks
  - Parse error: returns empty array
  - Network error: returns empty array
- Assert correct `gh api` arguments

### T013 Write unit tests for webhook creation
**File**: `packages/orchestrator/src/services/__tests__/webhook-setup-service.test.ts`
- Mock `executeCommand` utility
- Test `createRepoWebhook()`:
  - Success case: returns webhook ID
  - 403 error: throws with permission message
  - 500 error: throws with API error message
- Assert correct POST body structure

### T014 Write unit tests for webhook matching
**File**: `packages/orchestrator/src/services/__tests__/webhook-setup-service.test.ts`
- Test case-insensitive URL matching
- Test exact match found
- Test no match (different URL)
- Test partial match ignored

### T015 Write unit tests for webhook reactivation
**File**: `packages/orchestrator/src/services/__tests__/webhook-setup-service.test.ts`
- Mock `executeCommand` utility
- Test `updateRepoWebhook()`:
  - Reactivate with event merge: `["push"]` → `["push", "issues"]`
  - Already has issues: `["issues", "push"]` → unchanged
  - Single PATCH call with both updates
- Assert correct PATCH body

### T016 Write unit tests for ensureWebhooks
**File**: `packages/orchestrator/src/services/__tests__/webhook-setup-service.test.ts`
- Test scenarios:
  - No webhooks exist → creates new (action: 'created')
  - Matching webhook active → skips (action: 'skipped')
  - Matching webhook inactive → reactivates (action: 'reactivated')
  - Permission error (403) → warns and continues (action: 'failed')
  - Non-Smee URL → warns but proceeds
  - Event mismatch → warns but skips
  - Network error (500) → fails gracefully (action: 'failed')
  - Multiple repos → processes all, returns aggregate summary
- Verify logging calls with correct levels and fields

---

## Phase 2: Smee Receiver Exponential Backoff

### T017 Add exponential backoff state tracking
**File**: `packages/orchestrator/src/services/smee-receiver.ts`
- Add `reconnectAttempt` counter to class state
- Add constants: `BASE_RECONNECT_DELAY_MS = 5000`, `MAX_BACKOFF_MS = 300000`
- Initialize attempt counter to 0

### T018 Implement exponential backoff calculation
**File**: `packages/orchestrator/src/services/smee-receiver.ts`
- Add helper method: `calculateBackoffDelay(attempt: number): number`
- Formula: `Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, attempt), MAX_BACKOFF_MS)`
- Progression: 5s → 10s → 20s → 40s → 80s → 160s → 300s (capped)

### T019 Update reconnection loop with backoff
**File**: `packages/orchestrator/src/services/smee-receiver.ts`
- Modify reconnection while loop:
  - On successful connection: reset `reconnectAttempt = 0`
  - On error: calculate backoff delay from current attempt
  - Log with `{ reconnectMs, attempt }` fields
  - Increment `reconnectAttempt++`
  - Sleep for calculated delay
- Update log message to include attempt number

### T020 Update constructor options
**File**: `packages/orchestrator/src/services/smee-receiver.ts`
- Rename `reconnectDelayMs` → `baseReconnectDelayMs` (if exists)
- Default: 5000 ms
- Add JSDoc documenting exponential backoff behavior
- Update existing call sites (if any)

### T021 [P] Write unit tests for exponential backoff
**File**: `packages/orchestrator/src/services/__tests__/smee-receiver.test.ts`
- Test backoff progression: verify delay sequence
- Test backoff cap: verify doesn't exceed 5 minutes
- Test reset after success: verify counter resets to 0
- Mock connection failures and measure delays

---

## Phase 3: CLI Integration

### T022 Import WebhookSetupService in CLI command
**File**: `packages/generacy/src/cli/commands/orchestrator.ts`
- Add dynamic import: `const { WebhookSetupService } = await import('@generacy-ai/orchestrator')`
- Place in `setupLabelMonitor()` function after monitor service creation (after line 286)

### T023 Add webhook setup logic to setupLabelMonitor
**File**: `packages/generacy/src/cli/commands/orchestrator.ts`
- After monitor service creation, add conditional block: `if (useSmee)`
- Instantiate `WebhookSetupService` with `monitorLogger`
- Call `webhookSetup.ensureWebhooks(smeeChannelUrl, repositories)`
- Wrap in try/catch for graceful error handling
- Log summary at `info` level with aggregate counts
- Log errors at `warn` level with fallback message

### T024 Verify startup ordering
**File**: `packages/generacy/src/cli/commands/orchestrator.ts`
- Ensure webhook setup runs:
  - ✓ After monitor service creation
  - ✓ Before Smee receiver start (before line 157-161)
- Blocking execution (await the promise)
- No artificial timeout added

### T025 Update log statements for clarity
**File**: `packages/generacy/src/cli/commands/orchestrator.ts`
- Add log before webhook setup: "Configuring GitHub webhooks..."
- Success log: "Webhook auto-configuration complete" with summary fields
- Failure log: "Webhook auto-configuration failed (falling back to polling)"
- Use structured logging: `{ total, created, skipped, reactivated, failed }`

---

## Phase 4: Documentation and Verification

### T026 [P] Add JSDoc to WebhookSetupService
**File**: `packages/orchestrator/src/services/webhook-setup-service.ts`
- Comprehensive JSDoc for `ensureWebhooks()`:
  - Purpose and behavior
  - Parameter descriptions
  - Return value structure
  - Error handling strategy
  - Graceful degradation notes
- JSDoc for helper methods (if public)

### T027 [P] Verify exports in package index
**File**: `packages/orchestrator/src/services/index.ts`
- Verify `WebhookSetupService` exported
- Verify `WebhookSetupSummary` type exported
- Verify `WebhookSetupResult` type exported

### T028 [P] Verify type exports
**File**: `packages/orchestrator/src/types/index.ts`
- Verify `GitHubWebhook` interface exported
- Check no conflicts with existing types

---

## Phase 5: Integration Testing

### T029 Manual test: Create new webhooks
**Environment**: Local development with real GitHub repo
- Set `SMEE_CHANNEL_URL` env var
- Set `MONITORED_REPOS` to test repo without webhook
- Start CLI: `pnpm exec generacy orchestrator --label-monitor`
- Verify log: "Webhook auto-configuration complete" with `created: 1`
- Check GitHub repo settings: webhook exists, points to Smee URL, events include "issues"
- Verify orchestrator continues startup successfully

### T030 Manual test: Skip existing webhooks
**Environment**: Local development with webhook already configured
- Use same test repo from T029
- Restart CLI
- Verify log: `created: 0, skipped: 1`
- Verify no duplicate webhooks created in GitHub settings

### T031 Manual test: Reactivate inactive webhooks
**Environment**: Local development
- Manually disable webhook in GitHub repo settings
- Restart CLI
- Verify log: `reactivated: 1`
- Check GitHub: webhook is active again
- Verify events include "issues"

### T032 Manual test: Insufficient permissions
**Environment**: Local development with limited token
- Use GitHub token without `admin:repo_hook` scope
- Restart CLI
- Verify log: `failed: 1` with "Insufficient permissions" warning
- Verify orchestrator continues startup (doesn't crash)
- Verify polling works as fallback

### T033 Manual test: Non-Smee URL warning
**Environment**: Local development
- Set `SMEE_CHANNEL_URL=https://webhook.site/test`
- Restart CLI
- Verify log: warning about non-smee.io URL
- Verify webhook creation proceeds anyway
- Verify orchestrator starts successfully

### T034 Manual test: Event mismatch warning
**Environment**: Local development
- Manually create webhook with events: `["push"]`
- Set webhook URL to match Smee channel
- Restart CLI
- Verify log: warning about event mismatch (`[push]` vs expected `[issues]`)
- Verify webhook not modified
- Verify orchestrator starts successfully

### T035 Manual test: Smee exponential backoff
**Environment**: Local development with Smee unreachable
- Set invalid `SMEE_CHANNEL_URL` (to trigger reconnect failures)
- Start CLI
- Monitor logs for backoff progression: 5s → 10s → 20s → 40s
- Verify log frequency decreases over time
- Verify orchestrator remains responsive (polling continues)

### T036 End-to-end test: Label detection latency
**Environment**: Local development with Smee running
- Complete setup from T029 (webhook auto-configured)
- Create test issue in monitored repo
- Add label (e.g., `completed:clarification`)
- Measure time from label add to orchestrator detection
- Target: < 5 seconds (vs previous 15 minutes)
- Verify event processed correctly

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (Core Service) must complete before Phase 3 (CLI Integration)
- Phase 2 (Smee Backoff) can run in parallel with Phase 1
- Phase 3 (CLI Integration) depends on Phase 1
- Phase 4 (Documentation) can run in parallel with Phase 2-3
- Phase 5 (Integration Testing) depends on all implementation phases (1-4)

**Parallel opportunities within phases**:
- **Phase 1**: T010 (types), T011 (exports) can run parallel with T001-T009 (implementation)
- **Phase 1**: T012-T016 (unit tests) can run in parallel once implementation is complete
- **Phase 2**: Entire phase can run in parallel with Phase 1
- **Phase 4**: All tasks (T026-T028) can run in parallel

**Critical path**:
T001 → T002 → T003 → T004 → T005 → T006 → T007 → T008 → T009 → T022 → T023 → T024 → T025 → T029 → T036

**Estimated timeline**:
- Phase 1: 4-6 hours (core implementation + tests)
- Phase 2: 1-2 hours (backoff logic)
- Phase 3: 1-2 hours (CLI integration)
- Phase 4: 30 minutes (documentation)
- Phase 5: 2-3 hours (manual testing)
- **Total: ~10-14 hours** (includes testing time)

---

## Success Criteria Checklist

**Functional Requirements**:
- [ ] FR-001: Verify existing webhooks on startup (T007)
- [ ] FR-002: Create missing webhooks (T004, T006)
- [ ] FR-003: Reactivate inactive webhooks (T005, T006)
- [ ] FR-004: Graceful permission errors (T008)
- [ ] FR-005: Log structured results (T008, T025)
- [ ] FR-006: Warn on event mismatch (T006, T008)
- [ ] FR-007: Warn on non-Smee URLs (T009)
- [ ] FR-008: Exponential backoff (T017-T019)

**Non-Functional Requirements**:
- [ ] NFR-001: Startup time < 3s for 10 repos (T029)
- [ ] NFR-002: Error isolation - failures don't block startup (T008, T023)
- [ ] NFR-003: Log clarity with structured fields (T008, T025)
- [ ] NFR-004: Test coverage for all paths (T012-T016, T021)

**Integration Test Coverage**:
- [ ] New webhook creation (T029)
- [ ] Existing webhook skip (T030)
- [ ] Inactive webhook reactivation (T031)
- [ ] Permission errors gracefully handled (T032)
- [ ] Non-Smee URL warning (T033)
- [ ] Event mismatch warning (T034)
- [ ] Exponential backoff behavior (T035)
- [ ] End-to-end label detection < 5s (T036)

---

*Generated on 2026-02-24 from spec.md and plan.md*
