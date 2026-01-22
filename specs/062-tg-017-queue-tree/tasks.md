# Tasks: Queue Tree View

**Input**: Design documents from `/specs/062-tg-017-queue-tree/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: API Layer

- [x] T001 [US1] Create queue types in `packages/generacy-extension/src/api/types.ts`
  - QueueItem, QueueStatus, QueuePriority interfaces
  - QueueListResponse type
  - Zod schemas for runtime validation

- [x] T002 [US1] Implement queue API client in `packages/generacy-extension/src/api/endpoints/queue.ts`
  - getQueue(filters) - Fetch queue with optional filters
  - getQueueItem(id) - Single item retrieval
  - cancelQueueItem(id) - Cancel pending/running item
  - retryQueueItem(id) - Retry failed item
  - updatePriority(id, priority) - Change item priority

## Phase 2: Tree Item Classes

- [x] T003 [P] [US1] Create QueueTreeItem class in `packages/generacy-extension/src/views/cloud/queue/tree-item.ts`
  - Status icon mapping (clock, sync~spin, check, error, circle-slash)
  - Color-coded icons using ThemeColor
  - Time-relative descriptions
  - Rich markdown tooltips

- [x] T004 [P] [US1] Create filter group items in `packages/generacy-extension/src/views/cloud/queue/tree-item.ts`
  - QueueFilterGroupItem for status/repo/assignee groups
  - QueueEmptyItem for empty state
  - QueueLoadingItem for loading state
  - QueueErrorItem with retry command

- [x] T005 [P] [US1] Add type guards and exports in `packages/generacy-extension/src/views/cloud/queue/tree-item.ts`
  - isQueueTreeItem type guard
  - isQueueFilterGroupItem type guard
  - QueueExplorerItem union type

## Phase 3: Tree Provider

- [x] T006 [US1] Implement QueueTreeProvider in `packages/generacy-extension/src/views/cloud/queue/provider.ts`
  - TreeDataProvider interface implementation
  - getTreeItem, getChildren, getParent methods
  - onDidChangeTreeData event emitter

- [x] T007 [US1] Add polling functionality in `packages/generacy-extension/src/views/cloud/queue/provider.ts`
  - startPolling/stopPolling methods
  - pausePolling/resumePolling for visibility
  - Configurable polling interval
  - Change detection to minimize refreshes

- [x] T008 [US2] Implement view modes in `packages/generacy-extension/src/views/cloud/queue/provider.ts`
  - flat mode - all items in single list
  - byStatus mode - grouped by status
  - byRepository mode - grouped by repository
  - byAssignee mode - grouped by assignee

- [x] T009 [US3] Implement filtering in `packages/generacy-extension/src/views/cloud/queue/provider.ts`
  - setStatusFilter method
  - setRepositoryFilter method
  - setAssigneeFilter method
  - clearFilters method

## Phase 4: VS Code Integration

- [x] T010 [US1] Add view ID constant in `packages/generacy-extension/src/constants.ts`
  - Add 'queue' to VIEWS object
  - Add 'queueItem' to TREE_ITEM_CONTEXT

- [x] T011 [US1] Create factory function in `packages/generacy-extension/src/views/cloud/queue/provider.ts`
  - createQueueTreeProvider function
  - Register tree view with VS Code
  - Register commands for refresh, view modes, filtering
  - Handle visibility changes

- [x] T012 [US1] Create module exports in `packages/generacy-extension/src/views/cloud/queue/index.ts`
  - Export provider and factory
  - Export tree item classes
  - Export type guards and types

## Phase 5: Testing

- [x] T013 [P] [US1] Write provider tests in `packages/generacy-extension/src/views/cloud/queue/__tests__/provider.test.ts`
  - Initialization tests
  - getChildren tests for all modes
  - Polling tests
  - Filter tests
  - Change detection tests

- [x] T014 [P] [US1] Write tree item tests in `packages/generacy-extension/src/views/cloud/queue/__tests__/tree-item.test.ts`
  - QueueTreeItem tests (icons, context, description, tooltip)
  - QueueFilterGroupItem tests
  - Placeholder item tests (empty, loading, error)
  - Type guard tests

## Dependencies & Execution Order

**Sequential dependencies**:
- Phase 1 (API) must complete before Phase 3 (Provider)
- Phase 2 (Tree Items) must complete before Phase 3 (Provider)
- Phase 3 (Provider) must complete before Phase 4 (Integration)

**Parallel opportunities**:
- T003, T004, T005 can run in parallel (same file but independent sections)
- T013, T014 can run in parallel (separate test files)

**Completed**: All 14 tasks completed. Implementation verified with comprehensive test coverage.
