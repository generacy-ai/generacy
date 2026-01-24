import { z } from 'zod';
import type { ServerResponse, IncomingMessage } from 'http';
import type { DecisionQueueItem, ConnectedAgent } from './api.js';

// ============================================================================
// Channel Types (shared with WebSocket, will be sole source after migration)
// ============================================================================

export const SSEChannelSchema = z.enum(['workflows', 'queue', 'agents']);
export type SSEChannel = z.infer<typeof SSEChannelSchema>;

// ============================================================================
// SSE Event Types
// ============================================================================

export const WorkflowEventTypeSchema = z.enum([
  'workflow:started',
  'workflow:completed',
  'workflow:failed',
  'workflow:paused',
  'workflow:resumed',
  'workflow:cancelled',
  'step:started',
  'step:completed',
  'step:failed',
  'decision:requested',
  'decision:resolved',
]);
export type WorkflowEventType = z.infer<typeof WorkflowEventTypeSchema>;

export const SSEEventTypeSchema = z.enum([
  // Workflow events
  'workflow:started',
  'workflow:completed',
  'workflow:failed',
  'workflow:paused',
  'workflow:resumed',
  'workflow:cancelled',
  'step:started',
  'step:completed',
  'step:failed',
  'decision:requested',
  'decision:resolved',
  // Queue events
  'queue:updated',
  'queue:item:added',
  'queue:item:removed',
  // Agent events
  'agent:connected',
  'agent:disconnected',
  'agent:status',
  // System events
  'error',
  'connected',
]);
export type SSEEventType = z.infer<typeof SSEEventTypeSchema>;

// ============================================================================
// SSE Event Interfaces
// ============================================================================

/**
 * Base SSE event structure
 */
export interface SSEEvent<T = unknown> {
  /** Event type (maps to SSE 'event:' field) */
  event: SSEEventType;
  /** Unique event ID (maps to SSE 'id:' field) */
  id: string;
  /** Event payload (serialized to SSE 'data:' field) */
  data: T;
  /** Event timestamp */
  timestamp: string;
}

/**
 * Workflow event data payload
 */
export interface WorkflowEventData {
  workflowId: string;
  stepId?: string;
  progress?: number;
  status?: string;
  error?: {
    type: string;
    message: string;
  };
  metadata?: Record<string, unknown>;
}

/**
 * Workflow-specific SSE event
 */
export interface WorkflowSSEEvent extends SSEEvent<WorkflowEventData> {
  event: WorkflowEventType;
}

/**
 * Queue event data payload
 */
export interface QueueEventData {
  action: 'added' | 'removed' | 'updated';
  item?: DecisionQueueItem;
  items?: DecisionQueueItem[];
  queueSize: number;
}

/**
 * Queue update SSE event
 */
export interface QueueSSEEvent extends SSEEvent<QueueEventData> {
  event: 'queue:updated' | 'queue:item:added' | 'queue:item:removed';
}

/**
 * Agent event data payload
 */
export interface AgentEventData {
  agentId: string;
  status: 'connected' | 'disconnected' | 'busy' | 'idle';
  capabilities?: string[];
  metadata?: Record<string, unknown>;
  agent?: ConnectedAgent;
}

/**
 * Agent status SSE event
 */
export interface AgentSSEEvent extends SSEEvent<AgentEventData> {
  event: 'agent:connected' | 'agent:disconnected' | 'agent:status';
}

/**
 * Error event data payload
 */
export interface ErrorEventData {
  type: string;
  title: string;
  status: number;
  detail?: string;
  traceId?: string;
}

/**
 * Error SSE event
 */
export interface ErrorSSEEvent extends SSEEvent<ErrorEventData> {
  event: 'error';
}

/**
 * Connected event data payload
 */
export interface ConnectedEventData {
  connectionId: string;
  channels: SSEChannel[];
  timestamp: string;
}

/**
 * Connection confirmation SSE event
 */
export interface ConnectedSSEEvent extends SSEEvent<ConnectedEventData> {
  event: 'connected';
}

/**
 * Union of all SSE event types
 */
export type AnySSEEvent =
  | WorkflowSSEEvent
  | QueueSSEEvent
  | AgentSSEEvent
  | ErrorSSEEvent
  | ConnectedSSEEvent;

// ============================================================================
// Subscription Types
// ============================================================================

/**
 * Subscription filter options
 */
export interface SSEFilters {
  /** Filter to specific workflow */
  workflowId?: string;
  /** Filter by tags */
  tags?: string[];
}

/**
 * SSE client subscription
 */
export interface SSESubscription {
  /** Subscribed channels */
  channels: Set<SSEChannel>;
  /** Active filters */
  filters: SSEFilters;
  /** Last event ID received (for reconnection) */
  lastEventId?: string;
}

// ============================================================================
// Connection Types
// ============================================================================

/**
 * Active SSE connection
 */
export interface SSEConnection {
  /** Unique connection identifier */
  id: string;
  /** Node.js response stream */
  response: ServerResponse;
  /** Original request (for correlation ID) */
  request: IncomingMessage;
  /** Client's user ID (from auth) */
  userId: string;
  /** Subscription configuration */
  subscription: SSESubscription;
  /** Connection established timestamp */
  connectedAt: Date;
  /** Heartbeat timer reference */
  heartbeatTimer?: NodeJS.Timeout;
  /** Event sequence counter */
  sequenceCounter: number;
}

/**
 * SSE connection options
 */
export interface SSEConnectionOptions {
  /** Channels to subscribe to */
  channels?: SSEChannel[];
  /** Filter options */
  filters?: SSEFilters;
  /** Resume from last event ID */
  lastEventId?: string;
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * SSE stream configuration
 */
export interface SSEStreamConfig {
  /** Heartbeat interval in milliseconds (default: 30000) */
  heartbeatInterval: number;
  /** Maximum connections per client (default: 3) */
  maxConnectionsPerClient: number;
  /** Buffer size for missed events (default: 100) */
  eventBufferSize: number;
  /** Event retention duration in ms (default: 60000) */
  eventRetentionMs: number;
}

/**
 * Default SSE configuration
 */
export const DEFAULT_SSE_CONFIG: SSEStreamConfig = {
  heartbeatInterval: 30000,
  maxConnectionsPerClient: 3,
  eventBufferSize: 100,
  eventRetentionMs: 60000,
};

// ============================================================================
// Query Parameter Validation
// ============================================================================

/**
 * SSE filters validation schema
 */
export const SSEFiltersSchema = z
  .object({
    workflowId: z.string().uuid().optional(),
    tags: z.array(z.string()).optional(),
  })
  .optional();

/**
 * Query parameters for SSE endpoints
 */
export const SSEQuerySchema = z.object({
  channels: z.string().optional(), // comma-separated
  workflowId: z.string().uuid().optional(),
});
export type SSEQuery = z.infer<typeof SSEQuerySchema>;

/**
 * Parse channels from query string
 */
export function parseChannels(channelsParam?: string): SSEChannel[] {
  if (!channelsParam) {
    return ['workflows', 'queue', 'agents']; // default: all
  }
  const channels = channelsParam.split(',').map((c) => c.trim());
  return channels.filter((c) => SSEChannelSchema.safeParse(c).success) as SSEChannel[];
}

// ============================================================================
// Event ID Utilities
// ============================================================================

/**
 * Event ID structure
 * Format: {timestamp}_{connectionId}_{sequence}
 * Example: 1706123456789_conn_abc123_42
 */
export interface EventIdComponents {
  timestamp: number;
  connectionId: string;
  sequence: number;
}

/**
 * Parse event ID components
 */
export function parseEventId(id: string): EventIdComponents | null {
  const parts = id.split('_');
  if (parts.length < 3) return null;

  const firstPart = parts[0];
  const lastPart = parts[parts.length - 1];
  if (!firstPart || !lastPart) return null;

  const timestamp = parseInt(firstPart, 10);
  const connectionId = parts.slice(1, -1).join('_');
  const sequence = parseInt(lastPart, 10);

  if (isNaN(timestamp) || isNaN(sequence)) return null;

  return { timestamp, connectionId, sequence };
}
