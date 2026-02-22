# Data Models: Agent Orchestration UI Components

**Feature**: 161-summary-add-ui-components

## New Types (Extension Side)

All types go in `packages/generacy-extension/src/api/types.ts`, following the existing pattern of paired TypeScript interfaces + Zod schemas.

### Agent Types

```typescript
// ============================================================================
// Agent Types
// ============================================================================

/**
 * Agent connection status (matches orchestrator's AgentConnectionStatusSchema)
 */
export type AgentConnectionStatus = 'connected' | 'idle' | 'busy' | 'disconnected';

/**
 * Agent type (matches orchestrator's AgentTypeSchema)
 */
export type AgentType = 'claude' | 'gpt4' | 'custom';

/**
 * UI-facing agent display status (groups backend statuses for user clarity)
 * - available = connected + idle (both mean "ready for work")
 * - busy = busy (actively working on a workflow)
 * - offline = disconnected (not reachable)
 */
export type AgentDisplayStatus = 'available' | 'busy' | 'offline';

/**
 * Connected agent details
 */
export interface Agent {
  /** Unique agent identifier */
  id: string;
  /** Human-readable agent name */
  name: string;
  /** Agent type/model */
  type: AgentType;
  /** Current connection status */
  status: AgentConnectionStatus;
  /** Agent capabilities (e.g., 'streaming', 'mcp_tools') */
  capabilities: string[];
  /** Last heartbeat timestamp (ISO 8601) */
  lastSeen: string;
  /** Additional metadata */
  metadata: AgentMetadata;
}

/**
 * Agent metadata
 */
export interface AgentMetadata {
  /** Agent version */
  version?: string;
  /** Platform (e.g., 'linux', 'darwin') */
  platform?: string;
  /** Currently assigned workflow ID (set when busy) */
  workflowId?: string;
}

/**
 * Zod schema for agent metadata
 */
export const AgentMetadataSchema = z.object({
  version: z.string().optional(),
  platform: z.string().optional(),
  workflowId: z.string().uuid().optional(),
});

/**
 * Zod schema for agent
 */
export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['claude', 'gpt4', 'custom']),
  status: z.enum(['connected', 'idle', 'busy', 'disconnected']),
  capabilities: z.array(z.string()),
  lastSeen: z.string().datetime(),
  metadata: AgentMetadataSchema,
});

/**
 * Agent list response (uses existing PaginatedResponse pattern)
 */
export interface AgentListResponse {
  items: Agent[];
  total: number;
}

/**
 * Zod schema for agent list response
 */
export const AgentListResponseSchema = z.object({
  items: z.array(AgentSchema),
  total: z.number().int().nonnegative(),
});

/**
 * Agent statistics summary
 */
export interface AgentStats {
  /** Total registered agents */
  total: number;
  /** Agents in 'connected' or 'idle' status */
  available: number;
  /** Agents in 'busy' status */
  busy: number;
  /** Agents in 'disconnected' status */
  offline: number;
}

/**
 * Zod schema for agent stats
 */
export const AgentStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  busy: z.number().int().nonnegative(),
  offline: z.number().int().nonnegative(),
});
```

### Activity Feed Types

```typescript
// ============================================================================
// Activity Feed Types
// ============================================================================

/**
 * Activity event types (subset of SSE event types relevant to the feed)
 */
export type ActivityEventType =
  | 'workflow:started'
  | 'workflow:completed'
  | 'workflow:failed'
  | 'workflow:cancelled'
  | 'workflow:paused'
  | 'workflow:resumed'
  | 'agent:connected'
  | 'agent:disconnected'
  | 'queue:item:added'
  | 'queue:item:removed';

/**
 * Activity feed event
 */
export interface ActivityEvent {
  /** Unique event identifier */
  id: string;
  /** Event type */
  type: ActivityEventType;
  /** Human-readable event message */
  message: string;
  /** Event timestamp (ISO 8601) */
  timestamp: string;
  /** Additional context (workflow ID, agent ID, etc.) */
  metadata?: Record<string, unknown>;
}

/**
 * Zod schema for activity event
 */
export const ActivityEventSchema = z.object({
  id: z.string(),
  type: z.enum([
    'workflow:started', 'workflow:completed', 'workflow:failed',
    'workflow:cancelled', 'workflow:paused', 'workflow:resumed',
    'agent:connected', 'agent:disconnected',
    'queue:item:added', 'queue:item:removed',
  ]),
  message: z.string(),
  timestamp: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Activity feed response
 */
export interface ActivityFeedResponse {
  /** Activity events (reverse chronological) */
  events: ActivityEvent[];
  /** Whether there are more events available */
  hasMore: boolean;
}

/**
 * Zod schema for activity feed response
 */
export const ActivityFeedResponseSchema = z.object({
  events: z.array(ActivityEventSchema),
  hasMore: z.boolean(),
});
```

### Agent Log Types

```typescript
// ============================================================================
// Agent Log Types
// ============================================================================

/**
 * Agent log entry
 */
export interface AgentLogEntry {
  /** Log timestamp (ISO 8601) */
  timestamp: string;
  /** Log level */
  level: 'debug' | 'info' | 'warn' | 'error';
  /** Log message */
  message: string;
  /** Source (e.g., workflow step name) */
  source?: string;
}

/**
 * Zod schema for agent log entry
 */
export const AgentLogEntrySchema = z.object({
  timestamp: z.string().datetime(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  source: z.string().optional(),
});

/**
 * Agent logs response
 */
export interface AgentLogsResponse {
  /** Log entries (chronological order) */
  lines: AgentLogEntry[];
  /** Total available log lines */
  total: number;
  /** Whether there are more logs available */
  hasMore: boolean;
}

/**
 * Zod schema for agent logs response
 */
export const AgentLogsResponseSchema = z.object({
  lines: z.array(AgentLogEntrySchema),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
```

### Queue Stats Types

```typescript
// ============================================================================
// Queue Stats Types
// ============================================================================

/**
 * Queue statistics summary
 */
export interface QueueStats {
  /** Total items in queue */
  total: number;
  /** Count by status */
  byStatus: {
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
  /** Count by priority */
  byPriority: {
    low: number;
    normal: number;
    high: number;
    urgent: number;
  };
}

/**
 * Zod schema for queue stats
 */
export const QueueStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  byStatus: z.object({
    pending: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
  byPriority: z.object({
    low: z.number().int().nonnegative(),
    normal: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    urgent: z.number().int().nonnegative(),
  }),
});
```

### SSE Client Types (Extension Side)

```typescript
// ============================================================================
// SSE Client Types (for extension-side SSE subscription manager)
// ============================================================================

/**
 * SSE channel (matches orchestrator's SSEChannelSchema)
 */
export type SSEChannel = 'workflows' | 'queue' | 'agents';

/**
 * SSE event type (matches orchestrator's SSEEventTypeSchema)
 */
export type SSEEventType =
  | 'workflow:started' | 'workflow:completed' | 'workflow:failed'
  | 'workflow:paused' | 'workflow:resumed' | 'workflow:cancelled'
  | 'step:started' | 'step:completed' | 'step:failed'
  | 'decision:requested' | 'decision:resolved'
  | 'queue:updated' | 'queue:item:added' | 'queue:item:removed'
  | 'agent:connected' | 'agent:disconnected' | 'agent:status'
  | 'error' | 'connected';

/**
 * Generic SSE event received by the extension
 */
export interface SSEClientEvent<T = unknown> {
  /** Event type */
  event: SSEEventType;
  /** Unique event ID (for reconnection) */
  id: string;
  /** Event data payload */
  data: T;
  /** Event timestamp */
  timestamp: string;
}

/**
 * SSE connection state
 */
export type SSEConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
```

## Status Mapping Logic

```typescript
/**
 * Map backend agent status to UI display status.
 * Per Q3 answer: Available = connected + idle, Busy = busy, Offline = disconnected
 */
export function toDisplayStatus(status: AgentConnectionStatus): AgentDisplayStatus {
  switch (status) {
    case 'connected':
    case 'idle':
      return 'available';
    case 'busy':
      return 'busy';
    case 'disconnected':
      return 'offline';
  }
}

/**
 * Display status metadata for UI rendering
 */
export const DISPLAY_STATUS_META: Record<AgentDisplayStatus, {
  label: string;
  icon: string;
  color: string;
  sortOrder: number;
}> = {
  available: { label: 'Available', icon: '$(check)', color: '#5cb85c', sortOrder: 0 },
  busy: { label: 'Busy', icon: '$(sync~spin)', color: '#5bc0de', sortOrder: 1 },
  offline: { label: 'Offline', icon: '$(circle-slash)', color: '#777', sortOrder: 2 },
};
```

## Relationship to Existing Types

| Extension Type | Orchestrator Source Type | Notes |
|---------------|------------------------|-------|
| `Agent` | `ConnectedAgent` (api.ts:155-168) | Direct mirror with same fields |
| `AgentConnectionStatus` | `AgentConnectionStatusSchema` (api.ts:152) | Same enum values |
| `AgentType` | `AgentTypeSchema` (api.ts:149) | Same enum values |
| `SSEEventType` | `SSEEventTypeSchema` (sse.ts:31-55) | Same enum values |
| `SSEChannel` | `SSEChannelSchema` (sse.ts:9) | Same enum values |
| `QueueItem` | Already exists in extension | No changes needed |
| `QueuePriority` | Already exists in extension | No changes needed |
| `QueueStatus` | Already exists in extension | No changes needed |
