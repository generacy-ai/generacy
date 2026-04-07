import type { EventMessage } from './messages.js';

/**
 * EventEmitter-style interface for pushing events to the cloud via the relay.
 *
 * In library mode, the orchestrator calls `pushEvent(channel, event)` directly
 * on the ClusterRelay instance. This module defines the event construction helper.
 *
 * SSE subscription for standalone mode is deferred to issue 2.2.
 */

/**
 * Create an EventMessage for sending over the relay.
 */
export function createEventMessage(channel: string, event: unknown): EventMessage {
  return {
    type: 'event',
    channel,
    event,
  };
}

/**
 * SSE subscription interface (deferred to 2.2).
 * When implemented, this will connect to the orchestrator's /events SSE endpoint
 * and forward events through the relay WebSocket.
 */
export interface SSESubscriptionOptions {
  orchestratorUrl: string;
  orchestratorApiKey?: string;
  channels: string[];
}
