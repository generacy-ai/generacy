# Data Model: Queue Tree View

## Core Entities

### QueueItem

Represents a single workflow execution in the queue.

```typescript
interface QueueItem {
  /** Unique queue item ID */
  id: string;

  /** Workflow ID */
  workflowId: string;

  /** Workflow display name */
  workflowName: string;

  /** Current execution status */
  status: QueueStatus;

  /** Execution priority */
  priority: QueuePriority;

  /** Repository in owner/repo format */
  repository?: string;

  /** Assigned user ID */
  assigneeId?: string;

  /** ISO 8601 timestamp when added to queue */
  queuedAt: string;

  /** ISO 8601 timestamp when execution started */
  startedAt?: string;

  /** ISO 8601 timestamp when execution completed */
  completedAt?: string;

  /** Error message if status is 'failed' */
  error?: string;
}
```

### QueueStatus

Enumeration of possible queue item states.

```typescript
type QueueStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
```

| Status | Description | Can Transition To |
|--------|-------------|-------------------|
| `pending` | Waiting to start | running, cancelled |
| `running` | Currently executing | completed, failed, cancelled |
| `completed` | Finished successfully | (terminal) |
| `failed` | Finished with error | (terminal, can retry) |
| `cancelled` | Manually stopped | (terminal) |

### QueuePriority

Priority levels for queue ordering.

```typescript
type QueuePriority = 'low' | 'normal' | 'high' | 'urgent';
```

| Priority | Description | Icon |
|----------|-------------|------|
| `low` | Deferred execution | arrow-down |
| `normal` | Standard priority | dash |
| `high` | Elevated priority | arrow-up |
| `urgent` | Immediate execution | flame |

## View Models

### QueueExplorerItem

Union type for all displayable tree items.

```typescript
type QueueExplorerItem =
  | QueueTreeItem
  | QueueFilterGroupItem
  | QueueEmptyItem
  | QueueLoadingItem
  | QueueErrorItem;
```

### QueueFilterOptions

API filter parameters for queue queries.

```typescript
interface QueueFilterOptions {
  /** Filter by status (single or multiple) */
  status?: QueueStatus | QueueStatus[];

  /** Filter by repository (owner/repo) */
  repository?: string;

  /** Filter by assignee user ID */
  assigneeId?: string;

  /** Page number (1-indexed) */
  page?: number;

  /** Items per page */
  pageSize?: number;
}
```

### QueueViewMode

Available display modes for the tree view.

```typescript
type QueueViewMode = 'flat' | 'byStatus' | 'byRepository' | 'byAssignee';
```

| Mode | Description |
|------|-------------|
| `flat` | All items in a single list |
| `byStatus` | Grouped under status headers |
| `byRepository` | Grouped by repository |
| `byAssignee` | Grouped by assigned user |

## API Response Types

### QueueListResponse

Paginated queue list response.

```typescript
interface QueueListResponse {
  /** Array of queue items */
  items: QueueItem[];

  /** Total count matching filters */
  total: number;

  /** Current page (1-indexed) */
  page: number;

  /** Items per page */
  pageSize: number;
}
```

## Validation Schemas

All types have corresponding Zod schemas for runtime validation:

```typescript
const QueueItemSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  repository: z.string().optional(),
  assigneeId: z.string().optional(),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});

const QueueListResponseSchema = z.object({
  items: z.array(QueueItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
```

## Relationships

```
QueueItem
    ├── status: QueueStatus
    ├── priority: QueuePriority
    └── (references) repository, assigneeId

QueueTreeProvider
    ├── manages: QueueItem[]
    ├── renders: QueueExplorerItem[]
    └── filters: QueueFilterOptions
```
