# Tasks: Orchestrator GitHub Monitors Credential Resolution

**Input**: Design documents from `/specs/620-summary/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Token Provider Infrastructure (workflow-engine)

- [X] T001 [US2] Update `GitHubClientFactory` type in `packages/workflow-engine/src/actions/github/client/interface.ts` — add optional `tokenProvider?: () => Promise<string | undefined>` parameter
- [X] T002 [US2] Modify `GhCliGitHubClient` in `packages/workflow-engine/src/actions/github/client/gh-cli.ts` — add `tokenProvider` constructor parameter, add private `resolveTokenEnv()` method, inject `{ GH_TOKEN }` env in each `gh` CLI method (`listOpenPullRequests`, `listIssuesWithLabel`, etc.) via `executeCommand` options
- [X] T003 [US2] Update `createGitHubClient` factory in `packages/workflow-engine/src/actions/github/client/index.ts` — thread `tokenProvider` parameter through to `GhCliGitHubClient` constructor

## Phase 2: Wizard Credentials Token Provider (orchestrator)

- [X] T004 [US1] Create `packages/orchestrator/src/services/wizard-creds-token-provider.ts` — implement `createWizardCredsTokenProvider(envFilePath, logger)` returning `() => Promise<string | undefined>`. Stat-based cache invalidation (re-read on `mtime` change). Custom env file parser for `KEY=VALUE` format. State-transition logging (warn on start-failing, info on resumed).

## Phase 3: Wire Orchestrator Consumers

- [X] T005 [US1] Update `PrFeedbackMonitorService` in `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` — accept `tokenProvider` in constructor, pass to `createClient()` / `GitHubClientFactory` calls
- [X] T006 [P] [US1] Update `LabelMonitorService` in `packages/orchestrator/src/services/label-monitor-service.ts` — same pattern as T005
- [X] T007 [P] [US1] Update `LabelSyncService` in `packages/orchestrator/src/services/label-sync-service.ts` — same pattern as T005
- [X] T008 [US1] Update `WebhookSetupService` in `packages/orchestrator/src/services/webhook-setup-service.ts` — accept `tokenProvider` in constructor, resolve token before each `executeCommand('gh', ...)` call, pass `GH_TOKEN` in env option
- [X] T009 [US1] Update `server.ts` wiring in `packages/orchestrator/src/server.ts` — create wizard-creds token provider instance, pass to `PrFeedbackMonitorService`, `LabelMonitorService`, `LabelSyncService`, `WebhookSetupService` constructors

## Phase 4: Worker Process Callsites

- [X] T010 [P] [US2] Update `packages/orchestrator/src/worker/claude-cli-worker.ts` — pass `undefined` for `tokenProvider` at `createGitHubClient` / `GitHubClientFactory` callsite
- [X] T011 [P] [US2] Update `packages/orchestrator/src/worker/pr-feedback-handler.ts` — pass `undefined` for `tokenProvider` at callsite

## Phase 5: Tests & Verification

- [X] T012 [P] [US1] Unit tests for `wizard-creds-token-provider.ts` — test cases: file missing returns undefined, file malformed returns undefined, `GH_TOKEN` absent returns undefined, happy path returns token, stat-based cache (no re-read when mtime unchanged), state-transition logging (warn once on failure, info once on recovery)
- [X] T013 [P] [US2] Unit tests for `GhCliGitHubClient` token injection — test cases: token provider set results in `GH_TOKEN` in spawn env, undefined provider does not set env, provider returning undefined does not set env
- [X] T014 [US1] Verification grep: confirm no orchestrator-process `gh` invocation relies on ambient auth (SC-001)

## Dependencies & Execution Order

1. **T001 → T002 → T003** (sequential): Interface change, then implementation, then factory update
2. **T004** can start after T001 (needs type only, not implementation)
3. **T005–T009** depend on T002–T004 (need both the updated client and the token provider)
4. **T005** first, then **T006, T007** in parallel (same pattern), then **T008** (different pattern), then **T009** (wiring)
5. **T010, T011** in parallel, depend on T003 (factory signature change)
6. **T012, T013** in parallel, depend on T004 and T002 respectively
7. **T014** last — verification after all changes are in place

**Parallel opportunities**: T006+T007 (identical pattern), T010+T011 (independent files), T012+T013 (independent test suites)
