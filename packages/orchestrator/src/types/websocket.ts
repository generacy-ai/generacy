import { z } from 'zod';
import type { DecisionQueueItem, ConnectedAgent } from './api.js';
import type { ProblemDetails } from './problem-details.js';

// ============================================================================
// Channel Types
// ============================================================================

export const ChannelSchema = z.enum(['workflows', 'queue', 'agents']);
export type Channel = z.infer<typeof ChannelSchema>;

// ============================================================================
// Client → Server Messages
// ============================================================================

export const SubscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  channels: z.array(ChannelSchema).min(1),
  filters: z
    .object({
      workflowId: z.string().uuid().optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
});
export type SubscribeMessage = z.infer<typeof SubscribeMessageSchema>;

export const UnsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  channels: z.array(ChannelSchema).min(1),
});
export type UnsubscribeMessage = z.infer<typeof UnsubscribeMessageSchema>;

export const PingMessageSchema = z.object({
  type: z.literal('ping'),
});
export type PingMessage = z.infer<typeof PingMessageSchema>;

export const ClientMessageSchema = z.discriminatedUnion('type', [
  SubscribeMessageSchema,
  UnsubscribeMessageSchema,
  PingMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ============================================================================
// Server → Client Messages
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

export interface WorkflowEventMessage {
  type: 'workflow_event';
  payload: {
    event: WorkflowEventType;
    workflowId: string;
    stepId?: string;
    data: Record<string, unknown>;
    timestamp: string;
  };
}

export interface QueueUpdateMessage {
  type: 'queue_update';
  payload: DecisionQueueItem[];
}

export interface AgentStatusMessage {
  type: 'agent_status';
  payload: ConnectedAgent;
}

export interface PongMessage {
  type: 'pong';
  timestamp: string;
}

export interface ErrorMessage {
  type: 'error';
  payload: ProblemDetails;
}

export type ServerMessage =
  | WorkflowEventMessage
  | QueueUpdateMessage
  | AgentStatusMessage
  | PongMessage
  | ErrorMessage;

// ============================================================================
// Subscription Types
// ============================================================================

export interface SubscriptionFilters {
  workflowId?: string;
  tags?: string[];
}

export interface ClientSubscription {
  channels: Set<Channel>;
  filters: SubscriptionFilters;
}
