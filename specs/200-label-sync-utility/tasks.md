# Tasks: Label Sync Utility for Watched Repositories

**Input**: Design documents from `/specs/200-label-sync-utility/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1=startup sync, US2=new repo sync, US3=idempotent)

## Phase 1: Setup & Shared Module

- [X] T001 [P] [US1] Extract label definitions to shared module — Create `packages/workflow-engine/src/actions/github/label-definitions.ts` with `LabelDefinition` interface and `WORKFLOW_LABELS` array. Add missing labels: `process:speckit-feature`, `process:speckit-bugfix`, `epic-child`. Export from `packages/workflow-engine/src/index.ts`.
- [X] T002 [P] [US1] Update sync-labels action to use shared module — Modify `packages/workflow-engine/src/actions/github/sync-labels.ts` to import `WORKFLOW_LABELS` and `LabelDefinition` from `label-definitions.ts` instead of defining them inline. Remove the local `LabelConfig` interface and `WORKFLOW_LABELS` constant.
- [X] T003 [P] [US1] Add repository configuration schema — Extend `packages/orchestrator/src/config/schema.ts` with `RepositoryConfigSchema` (owner, repo fields) and add `repositories` array to `OrchestratorConfigSchema` with default `[]`. Support `ORCHESTRATOR_REPOSITORIES` env var parsing in config loader.

## Phase 2: Core Implementation

- [X] T004 [US1] Create LabelSyncService — Create `packages/orchestrator/src/services/label-sync-service.ts` implementing: constructor with logger and GitHubClient factory, `syncRepo(owner, repo)` method that lists existing labels and diffs against `WORKFLOW_LABELS`, `syncAll(repos)` method that iterates repos sequentially with per-repo error handling. Return typed `RepoSyncResult` and `SyncAllResult`.
- [X] T005 [US3] Add synced-repo tracking — In `LabelSyncService`, maintain a `Set<string>` of `owner/repo` keys already synced in the current session. `syncAll` skips repos already in the set. Add `resetTracking()` and `forceSync(owner, repo)` methods.
- [X] T006 [US1] Export LabelSyncService — Update `packages/orchestrator/src/services/index.ts` and `packages/orchestrator/src/index.ts` to export `LabelSyncService` and result types.

## Phase 3: Integration

- [X] T007 [US1] Integrate label sync into server startup — Modify `packages/orchestrator/src/server.ts` `createServer()`: after config loading and before route registration, if `config.repositories` is non-empty, instantiate `LabelSyncService` and call `syncAll()`. Log results summary. Sync failures log warnings but do not prevent server startup.
- [X] T008 [US2] Add syncNewRepo convenience method — In `LabelSyncService`, add `syncNewRepo(owner, repo)` that checks if the repo is already tracked, and if not, runs `syncRepo` and adds it to the tracked set. This supports the "new repo added" use case without re-syncing everything.

## Phase 4: Tests

- [X] T009 [P] [US3] Unit tests for label sync logic — Create `packages/orchestrator/tests/services/label-sync-service.test.ts` with mock `GitHubClient`. Test cases: creates missing labels, updates labels with wrong color/description, skips matching labels, never deletes labels.
- [X] T010 [P] [US1] Unit tests for multi-repo and error handling — In the same test file, add tests: continues sync when one repo fails, returns correct counts in `SyncAllResult`, handles empty repository list gracefully.
- [X] T011 [P] [US3] Unit tests for sync tracking — In the same test file, add tests: skips already-synced repos, `forceSync` bypasses tracking, `resetTracking` clears the set.
- [X] T012 [P] [US1] Unit tests for config schema — Add tests for `RepositoryConfigSchema` validation: valid owner/repo, rejects empty strings, default empty array, env var parsing.

## Dependencies & Execution Order

**Phase 1** (Setup): T001, T002, T003 can all run in parallel — they modify different packages/files.
- T001 and T002 both touch workflow-engine but different files (new module vs existing action)
- T003 touches orchestrator config independently

**Phase 2** (Core): T004 depends on T001 (needs `WORKFLOW_LABELS` export) and T003 (needs config types). T005 depends on T004. T006 depends on T004.

**Phase 3** (Integration): T007 depends on T004 and T003. T008 depends on T005.

**Phase 4** (Tests): T009-T012 can run in parallel. All depend on T004 (service must exist). T012 depends on T003 (config schema must exist).

```
T001 ──┐
T002   ├──→ T004 → T005 → T008
T003 ──┘      │      │
              │      └──→ T006
              └──→ T007
              └──→ T009, T010, T011, T012 (parallel)
```
