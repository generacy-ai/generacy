# Implementation Plan: Queue Tree View

**Feature**: Queue Tree View for VS Code extension cloud mode
**Branch**: `062-tg-017-queue-tree`
**Status**: Complete

## Summary

This feature implements a VS Code Tree View for visualizing the workflow queue in cloud mode. Users can view queued workflows, filter by status/repository/assignee, and see real-time status updates via API polling.

## Technical Context

| Technology | Version | Purpose |
|------------|---------|---------|
| TypeScript | 5.x | Primary language |
| VS Code API | ^1.85.0 | Extension platform |
| Zod | ^3.22 | Runtime type validation |

## Implementation Architecture

### Module Structure

```
packages/generacy-extension/src/
├── views/cloud/queue/
│   ├── provider.ts      # QueueTreeProvider - tree data provider
│   ├── tree-item.ts     # Tree item classes with icons/tooltips
│   └── index.ts         # Module exports
├── api/
│   ├── endpoints/
│   │   └── queue.ts     # Queue API client
│   └── types.ts         # QueueItem, QueueStatus types
└── constants.ts         # View IDs, context values
```

### Core Components

#### 1. QueueTreeProvider (`provider.ts`)
- Implements `vscode.TreeDataProvider<QueueExplorerItem>`
- Features:
  - **API Polling**: Configurable interval (default 30s), auto-pause when view hidden
  - **View Modes**: flat, byStatus, byRepository, byAssignee
  - **Filtering**: Status, repository, assignee filters with API params
  - **Change Detection**: Compares queue data to minimize refreshes
  - **Auth Integration**: Starts/stops polling based on auth state

#### 2. Tree Item Classes (`tree-item.ts`)
- `QueueTreeItem` - Individual queue entries with:
  - Status icons (clock, sync~spin, check, error, circle-slash)
  - Color-coded by status (yellow=pending, blue=running, green=completed, red=failed)
  - Time-relative descriptions ("queued 5m ago", "running for 2m")
  - Rich markdown tooltips
- `QueueFilterGroupItem` - Collapsible group headers for filtering
- `QueueEmptyItem`, `QueueLoadingItem`, `QueueErrorItem` - State indicators

#### 3. Queue API (`endpoints/queue.ts`)
- `getQueue(filters)` - Fetch queue with optional filters
- `getQueueItem(id)` - Single item retrieval
- `cancelQueueItem(id)` - Cancel pending/running item
- `retryQueueItem(id)` - Retry failed item
- `updatePriority(id, priority)` - Change item priority

### Data Model

```typescript
interface QueueItem {
  id: string;
  workflowId: string;
  workflowName: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  repository?: string;
  assigneeId?: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}
```

## VS Code Integration

### Commands Registered
- `generacy.queue.refresh` - Manual refresh
- `generacy.queue.viewFlat` - Flat view mode
- `generacy.queue.viewByStatus` - Group by status
- `generacy.queue.viewByRepository` - Group by repository
- `generacy.queue.viewByAssignee` - Group by assignee
- `generacy.queue.filterByStatus` - Quick pick filter
- `generacy.queue.clearFilters` - Clear all filters

### View Registration
- View ID: `generacy.queue` (defined in `constants.ts`)
- Container: Cloud sidebar panel
- Features: Collapse all, single selection

## Key Decisions

1. **Polling vs WebSocket**: Chose polling for simplicity and reliability; WebSocket can be added later if needed
2. **Change Detection**: Compare key fields (status, priority, timestamps) to avoid unnecessary tree refreshes
3. **Visibility-based Polling**: Pause when view is hidden to reduce API load
4. **Grouped Views**: Support multiple grouping strategies via view modes rather than persistent groups

## Dependencies

- `../../../utils/logger` - Logging utility
- `../../../api/auth` - Authentication service
- `../../../api/client` - API client
- `../../../api/types` - Type definitions and Zod schemas

## Testing Strategy

Test files located in `packages/generacy-extension/src/views/cloud/queue/__tests__/`:
- `provider.test.ts` - Provider lifecycle, polling, filtering
- `tree-item.test.ts` - Item rendering, icons, tooltips

## Files Modified

| File | Change Type | Description |
|------|-------------|-------------|
| `views/cloud/queue/provider.ts` | Created | Tree data provider |
| `views/cloud/queue/tree-item.ts` | Created | Tree item classes |
| `views/cloud/queue/index.ts` | Created | Module exports |
| `api/endpoints/queue.ts` | Created | Queue API client |
| `api/types.ts` | Modified | Added queue types |
| `constants.ts` | Modified | Added view ID |
