import type {
  SSEEvent,
  SSEEventType,
  WorkflowEventType,
  WorkflowEventData,
  SSEChannel,
  WorkflowSSEEvent,
  QueueSSEEvent,
  AgentSSEEvent,
  ErrorSSEEvent,
  ConnectedSSEEvent,
} from '../types/sse.js';
import type { DecisionQueueItem, DecisionResponse, ConnectedAgent } from '../types/api.js';
import { ErrorTypes } from '../types/problem-details.js';

/**
 * Generate a unique event ID
 * Format: {timestamp}_{connectionId}_{sequence}
 */
export function generateEventId(connectionId: string, sequence: number): string {
  return `${Date.now()}_${connectionId}_${sequence}`;
}

/**
 * Create an event ID generator for a connection
 */
export function createEventIdGenerator(connectionId: string): () => string {
  let sequence = 0;
  return () => generateEventId(connectionId, ++sequence);
}

/**
 * Format SSE event for transmission
 * Produces the SSE text format:
 *   event: <type>
 *   id: <id>
 *   data: <json>
 *
 */
export function formatSSEEvent<T>(event: SSEEvent<T>): string {
  const lines: string[] = [];

  // Event type
  lines.push(`event: ${event.event}`);

  // Event ID
  lines.push(`id: ${event.id}`);

  // Data - handle multi-line JSON by splitting and prefixing each line
  const jsonData = JSON.stringify(event.data);
  const dataLines = jsonData.split('\n');
  for (const line of dataLines) {
    lines.push(`data: ${line}`);
  }

  // SSE requires double newline to end event
  lines.push('');
  lines.push('');

  return lines.join('\n');
}

/**
 * Format heartbeat comment
 * SSE comments start with ':' and are used for keep-alive
 */
export function formatHeartbeat(): string {
  return `: heartbeat ${new Date().toISOString()}\n\n`;
}

/**
 * Create a workflow event
 */
export function createWorkflowEvent(
  eventType: WorkflowEventType,
  data: WorkflowEventData,
  connectionId: string,
  sequence: number
): WorkflowSSEEvent {
  return {
    event: eventType,
    id: generateEventId(connectionId, sequence),
    data,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a queue update event
 */
export function createQueueEvent(
  action: 'added' | 'removed' | 'updated',
  items: DecisionQueueItem[],
  queueSize: number,
  connectionId: string,
  sequence: number,
  response?: DecisionResponse
): QueueSSEEvent {
  const event: QueueSSEEvent['event'] =
    action === 'added'
      ? 'queue:item:added'
      : action === 'removed'
        ? 'queue:item:removed'
        : 'queue:updated';

  return {
    event,
    id: generateEventId(connectionId, sequence),
    data: {
      action,
      items,
      item: items[0],
      queueSize,
      ...(response && { response }),
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create an agent status event
 */
export function createAgentEvent(
  status: 'connected' | 'disconnected' | 'busy' | 'idle',
  agent: ConnectedAgent,
  connectionId: string,
  sequence: number
): AgentSSEEvent {
  const event: AgentSSEEvent['event'] =
    status === 'connected'
      ? 'agent:connected'
      : status === 'disconnected'
        ? 'agent:disconnected'
        : 'agent:status';

  return {
    event,
    id: generateEventId(connectionId, sequence),
    data: {
      agentId: agent.id,
      status,
      capabilities: agent.capabilities,
      agent,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create an error event
 */
export function createErrorEvent(
  title: string,
  detail: string,
  status: number,
  connectionId: string,
  sequence: number,
  traceId?: string
): ErrorSSEEvent {
  const errorType =
    status === 401
      ? ErrorTypes.UNAUTHORIZED
      : status === 403
        ? ErrorTypes.FORBIDDEN
        : status === 404
          ? ErrorTypes.NOT_FOUND
          : ErrorTypes.INTERNAL;

  return {
    event: 'error',
    id: generateEventId(connectionId, sequence),
    data: {
      type: errorType,
      title,
      status,
      detail,
      traceId,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a connected confirmation event
 */
export function createConnectedEvent(
  connectionId: string,
  channels: SSEChannel[],
  sequence: number
): ConnectedSSEEvent {
  return {
    event: 'connected',
    id: generateEventId(connectionId, sequence),
    data: {
      connectionId,
      channels,
      timestamp: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a generic SSE event
 */
export function createSSEEvent<T>(
  eventType: SSEEventType,
  data: T,
  connectionId: string,
  sequence: number
): SSEEvent<T> {
  return {
    event: eventType,
    id: generateEventId(connectionId, sequence),
    data,
    timestamp: new Date().toISOString(),
  };
}
