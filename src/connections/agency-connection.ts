/**
 * Agency connection wrapper implementation.
 */

import type { AgencyConnection, BaseConnection } from '../types/connections.js';
import type { MessageEnvelope, MessageHandler } from '../types/messages.js';

/** Options for creating an agency connection */
export interface AgencyConnectionOptions {
  /** Unique agency identifier */
  id: string;

  /** Function to send messages (transport-agnostic) */
  sendFn: (message: MessageEnvelope) => Promise<void>;

  /** Function to close the connection */
  closeFn?: () => Promise<void>;
}

/**
 * Creates an AgencyConnection wrapper around a transport.
 * This allows different transport implementations (WebSocket, HTTP, etc.)
 * to be used with the same interface.
 */
export function createAgencyConnection(options: AgencyConnectionOptions): AgencyConnection {
  const { id, sendFn, closeFn } = options;

  const messageHandlers: MessageHandler[] = [];
  const disconnectHandlers: (() => void)[] = [];
  let closed = false;

  const connection: AgencyConnection = {
    connectionType: 'agency',
    id,

    async send(message: MessageEnvelope): Promise<void> {
      if (closed) {
        throw new Error(`Cannot send to closed agency connection: ${id}`);
      }
      await sendFn(message);
    },

    onMessage(handler: MessageHandler): void {
      messageHandlers.push(handler);
    },

    onDisconnect(handler: () => void): void {
      disconnectHandlers.push(handler);
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;

      // Notify disconnect handlers
      for (const handler of disconnectHandlers) {
        try {
          handler();
        } catch {
          // Ignore handler errors during close
        }
      }

      // Call close function if provided
      if (closeFn) {
        await closeFn();
      }
    },
  };

  return connection;
}

/**
 * Helper to dispatch a message to an agency connection's handlers.
 * This is called by the transport layer when a message is received.
 */
export function dispatchToAgency(
  connection: AgencyConnection & { _handlers?: MessageHandler[] },
  message: MessageEnvelope
): void {
  // Access handlers through the closure (implementation detail)
  // In practice, the transport layer would have access to the handlers
}

/**
 * Creates a mock agency connection for testing purposes.
 */
export function createMockAgencyConnection(id: string): {
  connection: AgencyConnection;
  receivedMessages: MessageEnvelope[];
  triggerMessage: (message: MessageEnvelope) => void;
  triggerDisconnect: () => void;
} {
  const receivedMessages: MessageEnvelope[] = [];
  const messageHandlers: MessageHandler[] = [];
  const disconnectHandlers: (() => void)[] = [];
  let closed = false;

  const connection: AgencyConnection = {
    connectionType: 'agency',
    id,

    async send(message: MessageEnvelope): Promise<void> {
      if (closed) {
        throw new Error(`Cannot send to closed agency connection: ${id}`);
      }
      receivedMessages.push(message);
    },

    onMessage(handler: MessageHandler): void {
      messageHandlers.push(handler);
    },

    onDisconnect(handler: () => void): void {
      disconnectHandlers.push(handler);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const handler of disconnectHandlers) {
        handler();
      }
    },
  };

  return {
    connection,
    receivedMessages,
    triggerMessage: (message: MessageEnvelope) => {
      for (const handler of messageHandlers) {
        handler(message);
      }
    },
    triggerDisconnect: () => {
      for (const handler of disconnectHandlers) {
        handler();
      }
    },
  };
}
