# Tasks: Filter Issue Monitoring by Assignee

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Config & Identity Resolution

### T001 [US2] Add `clusterGithubUsername` to config schema
**File**: `packages/orchestrator/src/config/schema.ts`
- Add `clusterGithubUsername: z.string().optional()` to `MonitorConfigSchema`
- Type `MonitorConfig` auto-updates via `z.infer`

### T002 [P] [US2] Read `CLUSTER_GITHUB_USERNAME` env var in config loader
**File**: `packages/orchestrator/src/config/loader.ts`
- Add env var read for `CLUSTER_GITHUB_USERNAME` in `loadFromEnv()`
- Map to `config.monitor.clusterGithubUsername`
- Follow existing pattern (e.g., `WEBHOOK_SECRET` block)

### T003 [P] [US2, US3, US4] Create identity resolution utility
**File**: `packages/orchestrator/src/services/identity.ts` (**NEW**)
- Implement `resolveClusterIdentity(configUsername, logger)` returning `Promise<string | undefined>`
  - Check `configUsername` first (from env var via config)
  - Fall back to `gh api /user --jq .login` with 10s timeout
  - Return `undefined` if both fail (backward-compatible)
  - Log resolved username at `info` level with source
  - Classify and log errors from `gh` (ENOENT, auth, timeout, other)
- Implement `filterByAssignee(issues, clusterGithubUsername, logger)` returning `Issue[]`
  - When `clusterGithubUsername` is `undefined`, return all issues (no-op)
  - Skip unassigned issues with `warn`-level log
  - Warn on multiple assignees but still include the issue
  - Log filtered-out issues at `debug` level with issue number, assignees, and reason

### T004 [US2] Export identity utilities from services index
**File**: `packages/orchestrator/src/services/index.ts`
- Add `export { resolveClusterIdentity, filterByAssignee } from './identity.js';`

---

## Phase 2: Update Monitor Services

### T005 [US1] Add assignee filtering to LabelMonitorService
**File**: `packages/orchestrator/src/services/label-monitor-service.ts`
- Add `import { filterByAssignee } from './identity.js';`
- Add `clusterGithubUsername?: string` as 7th constructor parameter
- Store as `private readonly clusterGithubUsername: string | undefined`
- In `pollRepo()`, after each `client.listIssuesWithLabel()` call, apply `filterByAssignee()` before the processing loop
- Apply to both `KNOWN_PROCESS_LABELS` and `KNOWN_COMPLETED_LABELS` iteration paths

### T006 [P] [US1] Add assignee filtering to PrFeedbackMonitorService
**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
- Add `clusterGithubUsername?: string` as 7th constructor parameter
- Store as `private readonly clusterGithubUsername: string | undefined`
- In `processPrReviewEvent()`, after `PrLinker.linkPrToIssue()` resolves `issueNumber` and before unresolved threads check:
  - If `clusterGithubUsername` is set, fetch issue via `client.getIssue(owner, repo, issueNumber)`
  - Check `issue.assignees.includes(clusterGithubUsername)`
  - Skip with `debug` log if not assigned; warn if no assignees; warn if multiple assignees

### T007 [P] [US1] Add `assignees` field to `GitHubWebhookPayload.issue` type
**File**: `packages/orchestrator/src/types/monitor.ts`
- Add `assignees: Array<{ login: string }>` to the `issue` object in `GitHubWebhookPayload`

---

## Phase 3: Update Webhook Handlers

### T008 [US1] Add assignee check to label webhook handler
**File**: `packages/orchestrator/src/routes/webhooks.ts`
- Add `clusterGithubUsername?: string` to `WebhookRouteOptions` interface
- After repo whitelist check and before `parseLabelEvent()`:
  - If `clusterGithubUsername` is set, extract `payload.issue.assignees` (with `?? []` fallback)
  - Return `{ status: 'ignored', reason: 'issue has no assignees' }` for unassigned issues
  - Return `{ status: 'ignored', reason: 'not assigned to this cluster' }` for wrong assignee
  - Log skipped issues at appropriate levels (warn for unassigned, debug for wrong assignee)

### T009 [P] [US1] Add assignee support to PR webhook handler
**File**: `packages/orchestrator/src/routes/pr-webhooks.ts`
- Add `clusterGithubUsername?: string` to `PrWebhookRouteOptions` interface
- No route-level filtering needed (handled in `PrFeedbackMonitorService.processPrReviewEvent()` from T006)
- Pass-through for interface consistency

---

## Phase 4: Wire Up in Server & CLI

### T010 [US1, US2, US3, US4] Wire identity resolution into server.ts
**File**: `packages/orchestrator/src/server.ts`
- Add `import { resolveClusterIdentity } from './services/identity.js';`
- After Fastify instantiation and config loading, call `resolveClusterIdentity(config.monitor.clusterGithubUsername, server.log)`
- Pass resolved `clusterGithubUsername` to `LabelMonitorService` constructor (7th arg)
- Pass resolved `clusterGithubUsername` to `PrFeedbackMonitorService` constructor (7th arg)
- Pass resolved `clusterGithubUsername` to `setupWebhookRoutes()` options
- Pass resolved `clusterGithubUsername` to `setupPrWebhookRoutes()` options

### T011 [P] [US1, US3] Wire identity resolution into CLI orchestrator command
**File**: `packages/generacy/src/cli/commands/orchestrator.ts`
- Import `resolveClusterIdentity` from `@generacy-ai/orchestrator`
- In `setupLabelMonitor()`, resolve identity before `LabelMonitorService` construction
- Pass `clusterGithubUsername` as 7th constructor argument

---

## Phase 5: Tests

### T012 [US2, US3, US4] Write unit tests for identity resolution
**File**: `packages/orchestrator/src/services/__tests__/identity.test.ts` (**NEW**)
- Mock `node:child_process` `execFile` via `vi.mock()`
- Test `resolveClusterIdentity`:
  - Returns config username when set (no `gh` call made)
  - Falls back to `gh api /user` when config username not set
  - Returns `undefined` when both fail
  - Logs appropriate warnings for ENOENT, auth failure, timeout, generic errors
  - Logs info with source='config' or source='gh-api'
- Test `filterByAssignee`:
  - Returns all issues when `clusterGithubUsername` is `undefined` (backward compat)
  - Returns only assigned issues when username is set
  - Returns empty array when no issues match
  - Skips unassigned issues (no assignees) with warn log
  - Warns on multiple assignees but still includes the issue
  - Logs skipped issues at debug level with issue number and assignees

### T013 [P] [US1] Extend LabelMonitorService tests for assignee filtering
**File**: `packages/orchestrator/tests/unit/services/label-monitor-service.test.ts`
- Add test group for assignee filtering in `pollRepo()`:
  - With `clusterGithubUsername: undefined`, all issues are processed (backward compat)
  - With username set, only assigned issues are processed
  - Filtering applies to both `KNOWN_PROCESS_LABELS` and `KNOWN_COMPLETED_LABELS` loops
  - Unassigned issues are skipped with warning
- Follow existing test patterns: `createMockLogger()`, `createMockGitHubClient()`, etc.

### T014 [P] [US1] Extend PrFeedbackMonitorService tests for assignee filtering
**File**: `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts`
- Add test group for assignee check in `processPrReviewEvent()`:
  - With `clusterGithubUsername: undefined`, all PR events are processed (backward compat)
  - With username set, skips PR events whose linked issue is not assigned
  - With username set, processes PR events whose linked issue is assigned
  - Calls `client.getIssue()` only when `clusterGithubUsername` is set
  - Warning logged for multiple assignees
- Follow existing test patterns: `createMockLogger()`, `createMockGitHubClient()`, etc.

### T015 [P] [US1] Extend webhook handler tests for assignee filtering
**Files**:
- `packages/orchestrator/src/routes/__tests__/webhooks.test.ts` (**NEW** — no existing label webhook test file)
- `packages/orchestrator/src/routes/__tests__/pr-webhooks.test.ts` (extend existing)
- Label webhook tests:
  - Returns `ignored` with reason for unassigned issues when username set
  - Returns `ignored` with reason for issues assigned to other users
  - Processes issues assigned to cluster username
  - Processes all issues when no username configured (backward compat)
  - Handles missing `assignees` field in payload gracefully (via `?? []`)
- PR webhook tests:
  - Verify `clusterGithubUsername` is accepted in options (interface compat)
  - Actual filtering tested in T014 (service-level)

---

## Phase 6: Verification & Cleanup

### T016 [US1] TypeScript compilation check
- Run `cd packages/orchestrator && pnpm tsc --noEmit`
- Fix any type errors

### T017 [US1] Run all orchestrator tests
- Run `cd packages/orchestrator && pnpm test`
- Fix any failures

### T018 [US1] Verify exports are correct
- Confirm `resolveClusterIdentity` and `filterByAssignee` are exported from `packages/orchestrator/src/services/index.ts`
- Confirm they're accessible from the package's main entry point if needed by CLI (T011)

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 must complete before Phase 2 (services depend on config schema + identity utility)
- Phase 2 (T005, T007) must complete before Phase 3 (webhook handlers reference updated types and services)
- Phase 3 must complete before Phase 4 (server wiring passes options to routes)
- Phase 5 (tests) can begin for any component once its implementation task is done
- Phase 6 runs after all implementation and tests

**Parallel opportunities within phases**:
- Phase 1: T002, T003 can run in parallel (different files, no dependency). T004 depends on T003
- Phase 2: T005, T006, T007 can all run in parallel (different files)
- Phase 3: T008, T009 can run in parallel (different files)
- Phase 4: T010, T011 can run in parallel (different packages)
- Phase 5: T012, T013, T014, T015 can all run in parallel (different test files)

**Critical path**:
T001 → T003 → T004 → T005 → T008 → T010 → T016 → T017
