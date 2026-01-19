/**
 * Routing rules for different message types.
 */

import type { MessageEnvelope, MessageType } from '../types/messages.js';

/** Target types for routing */
export type RouteTarget = 'agency' | 'humancy' | 'channel' | 'broadcast_humancy' | 'broadcast_agency';

/** Routing decision */
export interface RoutingDecision {
  /** Target type */
  target: RouteTarget;

  /** Specific target ID (if not broadcast) */
  targetId?: string;

  /** Whether to wait for response */
  expectsResponse: boolean;
}

/**
 * Routing rules by message type:
 * 1. decision_request: Agency -> all Humancy (broadcast)
 * 2. decision_response: Humancy -> specific Agency (via correlation)
 * 3. mode_command: Router -> specific Agency
 * 4. workflow_event: Router -> all Humancy (broadcast)
 * 5. channel_message: Route via channel handler
 */
export function determineRoute(message: MessageEnvelope): RoutingDecision {
  switch (message.type) {
    case 'decision_request':
      // Agency sends decision request -> broadcast to all Humancy
      return {
        target: 'broadcast_humancy',
        expectsResponse: true,
      };

    case 'decision_response':
      // Humancy responds -> route to specific Agency via correlation
      if (!message.destination) {
        throw new RoutingError(
          'decision_response requires destination (Agency ID)',
          message
        );
      }
      return {
        target: 'agency',
        targetId: message.destination.id,
        expectsResponse: false,
      };

    case 'mode_command':
      // Router sends mode command -> specific Agency
      if (!message.destination) {
        throw new RoutingError(
          'mode_command requires destination (Agency ID)',
          message
        );
      }
      return {
        target: 'agency',
        targetId: message.destination.id,
        expectsResponse: false,
      };

    case 'workflow_event':
      // Router sends workflow event -> broadcast to all Humancy
      return {
        target: 'broadcast_humancy',
        expectsResponse: false,
      };

    case 'channel_message':
      // Route via channel handler
      if (!message.channel) {
        throw new RoutingError(
          'channel_message requires channel field',
          message
        );
      }
      return {
        target: 'channel',
        targetId: message.channel,
        expectsResponse: false, // Channel handler may override
      };

    default:
      throw new RoutingError(
        `Unknown message type: ${message.type}`,
        message
      );
  }
}

/** Error thrown when routing fails */
export class RoutingError extends Error {
  constructor(
    message: string,
    public readonly envelope: MessageEnvelope
  ) {
    super(message);
    this.name = 'RoutingError';
  }
}

/** Error thrown when destination is not found */
export class DestinationNotFoundError extends Error {
  constructor(
    type: 'agency' | 'humancy' | 'channel',
    id: string
  ) {
    super(`${type} "${id}" not found`);
    this.name = 'DestinationNotFoundError';
  }
}

/** Error thrown when no recipients are available */
export class NoRecipientsError extends Error {
  constructor(target: RouteTarget) {
    super(`No recipients available for ${target}`);
    this.name = 'NoRecipientsError';
  }
}

/** Validates that a message has required fields for its type */
export function validateMessageForRouting(message: MessageEnvelope): void {
  if (!message.id) {
    throw new RoutingError('Message must have an id', message);
  }

  if (!message.type) {
    throw new RoutingError('Message must have a type', message);
  }

  if (!message.source) {
    throw new RoutingError('Message must have a source', message);
  }

  // Additional type-specific validation
  switch (message.type) {
    case 'decision_response':
      if (!message.correlationId) {
        throw new RoutingError(
          'decision_response requires correlationId',
          message
        );
      }
      break;

    case 'channel_message':
      if (!message.channel) {
        throw new RoutingError(
          'channel_message requires channel field',
          message
        );
      }
      break;
  }
}

/** Checks if a message type expects a response */
export function expectsResponse(type: MessageType): boolean {
  return type === 'decision_request';
}

/** Gets the source type constraint for a message type */
export function getSourceTypeConstraint(
  type: MessageType
): 'agency' | 'humancy' | 'router' | null {
  switch (type) {
    case 'decision_request':
      return 'agency';
    case 'decision_response':
      return 'humancy';
    case 'mode_command':
    case 'workflow_event':
      return 'router';
    case 'channel_message':
      return null; // Any source allowed
    default:
      return null;
  }
}
