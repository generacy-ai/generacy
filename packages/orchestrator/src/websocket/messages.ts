import {
  ClientMessageSchema,
  type ClientMessage,
  type ServerMessage,
  type WorkflowEventMessage,
  type QueueUpdateMessage,
  type AgentStatusMessage,
  type PongMessage,
  type ErrorMessage,
} from '../types/index.js';
import { ErrorTypes, createProblemDetails } from '../types/index.js';

/**
 * Parse and validate incoming WebSocket message
 */
export function parseClientMessage(data: unknown): ClientMessage | null {
  try {
    if (typeof data === 'string') {
      const parsed = JSON.parse(data);
      return ClientMessageSchema.parse(parsed);
    }
    return ClientMessageSchema.parse(data);
  } catch {
    return null;
  }
}

/**
 * Serialize server message for WebSocket
 */
export function serializeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

/**
 * Create a pong message
 */
export function createPongMessage(): PongMessage {
  return {
    type: 'pong',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create an error message
 */
export function createErrorMessage(
  title: string,
  detail: string,
  status: number = 400,
  traceId?: string
): ErrorMessage {
  return {
    type: 'error',
    payload: createProblemDetails(
      status === 401 ? ErrorTypes.UNAUTHORIZED : ErrorTypes.VALIDATION_ERROR,
      title,
      status,
      { detail, traceId }
    ),
  };
}

/**
 * Create a workflow event message
 */
export function createWorkflowEventMessage(
  event: WorkflowEventMessage['payload']['event'],
  workflowId: string,
  data: Record<string, unknown> = {},
  stepId?: string
): WorkflowEventMessage {
  return {
    type: 'workflow_event',
    payload: {
      event,
      workflowId,
      stepId,
      data,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Create a queue update message
 */
export function createQueueUpdateMessage(
  items: QueueUpdateMessage['payload']
): QueueUpdateMessage {
  return {
    type: 'queue_update',
    payload: items,
  };
}

/**
 * Create an agent status message
 */
export function createAgentStatusMessage(
  agent: AgentStatusMessage['payload']
): AgentStatusMessage {
  return {
    type: 'agent_status',
    payload: agent,
  };
}
