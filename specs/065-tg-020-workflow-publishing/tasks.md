# Tasks: Workflow Publishing

**Input**: Design documents from `/specs/065-tg-020-workflow-publishing/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Implementation Complete (Tests Pending - Phase 7)

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: API Foundation

- [X] T001 Create API type definitions in `src/api/types/workflows.ts`
  - Define Zod schemas: `WorkflowVersionSchema`, `PublishedWorkflowSchema`, `PublishWorkflowRequestSchema`, `PublishWorkflowResponseSchema`
  - Export TypeScript types from schemas
  - Add constants: `MAX_WORKFLOW_SIZE`, `SYNC_STATUS_CACHE_TTL`

- [X] T002 [P] Implement API endpoint functions in `src/api/endpoints/workflows.ts`
  - `publishWorkflow()` - POST /workflows/publish
  - `getPublishedWorkflow()` - GET /workflows/:name
  - `getWorkflowVersions()` - GET /workflows/:name/versions
  - `getWorkflowVersion()` - GET /workflows/:name/versions/:version
  - Use `ApiClient.postValidated()` and `ApiClient.getValidated()` with Zod schemas

- [X] T003 [P] Create sync status types and utilities in `src/views/cloud/publish/types.ts`
  - Define `SyncStatus` type ('synced' | 'ahead' | 'behind' | 'conflict' | 'not-published' | 'unknown')
  - Define `WorkflowSyncStatus` interface
  - Export constants: `SYNC_STATUS_ICONS`, `SYNC_STATUS_COLORS`

## Phase 2: Core Publishing Logic

- [X] T004 Implement workflow validation utility in `src/views/cloud/publish/validation.ts`
  - Read YAML file content
  - Parse YAML with error handling
  - Validate workflow structure (name, phases, steps)
  - Return validation result with specific error messages

- [X] T005 Create sync status cache in `src/views/cloud/publish/cache.ts`
  - Implement `SyncStatusCache` class with Map-based storage
  - Add `get()` method with TTL checking (5-minute cache)
  - Add `set()` method to store status with timestamp
  - Add `invalidate()` method for single workflow
  - Add `invalidateAll()` method for manual refresh

- [X] T006 Implement sync status determination in `src/views/cloud/publish/status.ts`
  - Create `determineSyncStatus()` function
  - Fetch cloud workflow details if exists
  - Compare local content with cloud version content
  - Compare modification timestamps
  - Return appropriate `SyncStatus`

- [X] T007 Create publish workflow command handler in `src/views/cloud/publish/sync.ts`
  - Implement `publishWorkflowCommand()` function
  - Get active workflow file from editor
  - Validate workflow YAML
  - Check authentication status
  - Fetch cloud version if exists
  - Show diff if cloud version exists (call `showWorkflowDiff()`)
  - Prompt for changelog with `vscode.window.showInputBox()`
  - Show confirmation QuickPick with "Publish Now", "Review Diff", "Cancel"
  - Call `publishWorkflow()` API endpoint
  - Show progress notification with `vscode.window.withProgress()`
  - Invalidate sync status cache
  - Show success message with version number

## Phase 3: Diff Comparison View

- [X] T008 Create cloud workflow content provider in `src/views/cloud/publish/provider.ts`
  - Implement `CloudWorkflowContentProvider` class
  - Implement `provideTextDocumentContent()` method
  - Parse URI to extract workflow name and version
  - Fetch version content from API
  - Return content as string
  - Handle errors with clear messages

- [X] T009 Implement diff comparison view in `src/views/cloud/publish/compare.ts`
  - Create `showWorkflowDiff()` function
  - Register `CloudWorkflowContentProvider` with 'generacy-cloud' scheme
  - Create cloud URI: `generacy-cloud://workflow/:name/:version`
  - Create local file URI
  - Execute `vscode.diff` command with both URIs
  - Set title: "{workflowName}: Cloud ↔ Local"

## Phase 4: Version History & Rollback

- [X] T010 Create version history panel in `src/views/cloud/publish/version.ts`
  - Implement `showVersionHistoryCommand()` function
  - Get active workflow name from editor
  - Fetch versions with `getWorkflowVersions()` API
  - Create QuickPick items with version details:
    - Label: "$(tag) Version {version} {tag?}"
    - Description: formatted timestamp
    - Detail: changelog or "No changelog"
  - Add buttons: View, Compare, Rollback
  - Handle button click events
  - Sort versions descending (newest first)

- [X] T011 Implement rollback functionality in `src/views/cloud/publish/version.ts`
  - Create `rollbackWorkflowCommand()` function
  - Show confirmation dialog with version details
  - Fetch target version content with `getWorkflowVersion()`
  - Publish as new version with auto-generated changelog: "Rolled back to version X"
  - Prompt user to update local file (optional)
  - Show success message
  - Invalidate sync status cache

## Phase 5: Sync Status Indicators

- [X] T012 Create file decoration provider in `src/views/cloud/publish/decorations.ts`
  - Implement `WorkflowSyncDecorationProvider` class
  - Implement `provideFileDecoration()` method
  - Check if file is workflow (.yaml in .generacy/ directory)
  - Get sync status from cache
  - Return `FileDecoration` with badge, color, tooltip
  - Map `SyncStatus` to icons and colors using constants

- [X] T013 Register decoration provider in extension in `src/views/cloud/publish/sync.ts`
  - Create decoration provider instance
  - Register with `vscode.window.registerFileDecorationProvider()`
  - Set up file watcher for .generacy/**/*.yaml files
  - Invalidate cache on file save events
  - Fire `onDidChangeFileDecorations` event after cache invalidation

## Phase 6: Command Registration & Module Exports

- [X] T014 Create publish module index in `src/views/cloud/publish/index.ts`
  - Export all public functions and types
  - Export command handlers
  - Export provider classes

- [X] T015 Register commands in extension activation in `src/extension.ts`
  - Register `generacy.publishWorkflow` command
  - Register `generacy.viewVersionHistory` command
  - Register `generacy.compareWithCloud` command
  - Register `generacy.rollbackWorkflow` command
  - Register `generacy.refreshSyncStatus` command
  - Add all registrations to `context.subscriptions`

- [X] T016 Update package.json with command contributions
  - Add command definitions to `contributes.commands`
  - Add activation events: `onCommand:generacy.publishWorkflow`, etc.
  - Add configuration settings:
    - `generacy.publish.autoSync`
    - `generacy.publish.confirmBeforePublish`
    - `generacy.publish.requireChangelog`
    - `generacy.publish.syncStatusCacheTTL`

## Phase 7: Testing

- [ ] T017 [P] Create unit tests for API functions in `src/api/endpoints/__tests__/workflows.test.ts`
  - Test `publishWorkflow()` success case
  - Test `publishWorkflow()` with validation errors
  - Test `getPublishedWorkflow()` success and not found cases
  - Test `getWorkflowVersions()` with empty and populated lists
  - Test `getWorkflowVersion()` success and not found cases
  - Mock `ApiClient` methods

- [ ] T018 [P] Create unit tests for sync status in `src/views/cloud/publish/__tests__/status.test.ts`
  - Test `determineSyncStatus()` for 'not-published' case
  - Test `determineSyncStatus()` for 'synced' case (content matches)
  - Test `determineSyncStatus()` for 'ahead' case (local modified after cloud)
  - Test `determineSyncStatus()` for 'behind' case (cloud newer than local)
  - Mock API calls

- [ ] T019 [P] Create unit tests for cache in `src/views/cloud/publish/__tests__/cache.test.ts`
  - Test cache hit within TTL
  - Test cache miss after TTL expiration
  - Test `invalidate()` removes specific entry
  - Test `invalidateAll()` clears entire cache

- [ ] T020 [P] Create unit tests for validation in `src/views/cloud/publish/__tests__/validation.test.ts`
  - Test valid YAML workflow parsing
  - Test invalid YAML with parse errors
  - Test missing required fields
  - Test workflow size exceeding MAX_WORKFLOW_SIZE

- [ ] T021 Create integration test for publish flow in `src/views/cloud/publish/__tests__/sync.test.ts`
  - Test complete publish workflow end-to-end
  - Mock VS Code API (showInputBox, showQuickPick, window.withProgress)
  - Mock ApiClient responses
  - Verify command execution flow
  - Verify cache invalidation after publish

- [ ] T022 [manual] Manual testing checklist
  - Test publish new workflow (no cloud version)
  - Test publish update to existing workflow with diff view
  - Test publish with changelog
  - Test publish without changelog (verify warning)
  - Test version history display with multiple versions
  - Test rollback creates new version with correct content
  - Test sync status indicators show correct badges
  - Test file decoration updates after publish
  - Test diff view displays correctly with cloud vs local
  - Test error handling: authentication failure, network errors, validation errors

## Dependencies & Execution Order

**Phase 1** (API Foundation): All tasks can run in parallel after T001
- T001 must complete first (defines types used by T002 and T003)
- T002 and T003 can run in parallel

**Phase 2** (Core Publishing): Sequential dependencies
- T004 (validation) is independent
- T005 (cache) is independent
- T006 (status) depends on T001, T003, T005
- T007 (publish command) depends on T001, T002, T004, T006

**Phase 3** (Diff View): Depends on T001, T002
- T008 and T009 must be sequential (T009 uses T008)

**Phase 4** (Version History): Depends on T001, T002, T008
- T010 and T011 can share the same file, T011 extends T010

**Phase 5** (Sync Status Indicators): Depends on T003, T005, T006
- T012 and T013 are sequential (T013 registers T012)

**Phase 6** (Integration): Depends on all previous phases
- T014, T015, T016 are sequential

**Phase 7** (Testing): Parallel execution possible
- T017-T020 can all run in parallel (independent test files)
- T021 runs after T017-T020 (integration test)
- T022 is manual testing (run after all implementation complete)

**Parallel Opportunities**:
- Phase 1: T002 [P] and T003 [P] after T001
- Phase 7: T017 [P], T018 [P], T019 [P], T020 [P] can all run simultaneously
