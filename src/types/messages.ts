/**
 * Message types and envelope definitions for the message router.
 */

/** Message types determining routing rules */
export type MessageType =
  | 'decision_request'    // Agency -> Humancy
  | 'decision_response'   // Humancy -> Agency
  | 'mode_command'        // Router -> Agency
  | 'workflow_event'      // Router -> Humancy
  | 'channel_message';    // Plugin-defined routing

/** Endpoint types in the routing system */
export type EndpointType = 'agency' | 'humancy' | 'router';

/** Message endpoint identification */
export interface MessageEndpoint {
  type: EndpointType;
  id: string;
}

/** Message metadata */
export interface MessageMeta {
  /** Unix timestamp (ms) when message was created */
  timestamp: number;

  /** Time-to-live in milliseconds (default: 3600000 = 1 hour) */
  ttl?: number;

  /** Delivery priority (future use) */
  priority?: number;

  /** Number of delivery attempts */
  attempts?: number;
}

/** The universal wrapper for all routed messages */
export interface MessageEnvelope {
  /** Unique message identifier (UUID v4) */
  id: string;

  /** Correlation ID for request/response pairing */
  correlationId?: string;

  /** Message type determining routing rule */
  type: MessageType;

  /** Optional channel for plugin-defined routing */
  channel?: string;

  /** Message origin */
  source: MessageEndpoint;

  /** Explicit destination (optional for broadcast) */
  destination?: MessageEndpoint;

  /** Message-specific payload */
  payload: unknown;

  /** Metadata */
  meta: MessageMeta;
}

/** Handler function for processing messages */
export type MessageHandler = (message: MessageEnvelope) => void | Promise<void>;

/** Default TTL in milliseconds (1 hour) */
export const DEFAULT_TTL = 3600000;

/** Creates a new message envelope with defaults */
export function createMessageEnvelope(
  params: Omit<MessageEnvelope, 'meta'> & { meta?: Partial<MessageMeta> }
): MessageEnvelope {
  return {
    ...params,
    meta: {
      timestamp: Date.now(),
      ttl: DEFAULT_TTL,
      attempts: 0,
      ...params.meta,
    },
  };
}

/** Checks if a message has expired based on its TTL */
export function isMessageExpired(message: MessageEnvelope): boolean {
  const ttl = message.meta.ttl ?? DEFAULT_TTL;
  return Date.now() > message.meta.timestamp + ttl;
}
