/**
 * Humancy connection wrapper implementation.
 */

import type { HumancyConnection, HumancyType } from '../types/connections.js';
import type { MessageEnvelope, MessageHandler } from '../types/messages.js';

/** Options for creating a humancy connection */
export interface HumancyConnectionOptions {
  /** Unique humancy identifier */
  id: string;

  /** Humancy type (vscode or cloud) */
  type: HumancyType;

  /** Function to send messages (transport-agnostic) */
  sendFn: (message: MessageEnvelope) => Promise<void>;

  /** Function to close the connection */
  closeFn?: () => Promise<void>;
}

/**
 * Creates a HumancyConnection wrapper around a transport.
 * This allows different transport implementations (WebSocket, HTTP, etc.)
 * to be used with the same interface.
 */
export function createHumancyConnection(options: HumancyConnectionOptions): HumancyConnection {
  const { id, type, sendFn, closeFn } = options;

  const messageHandlers: MessageHandler[] = [];
  const disconnectHandlers: (() => void)[] = [];
  let closed = false;

  const connection: HumancyConnection = {
    connectionType: 'humancy',
    id,
    type,

    async send(message: MessageEnvelope): Promise<void> {
      if (closed) {
        throw new Error(`Cannot send to closed humancy connection: ${id}`);
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
 * Creates a mock humancy connection for testing purposes.
 */
export function createMockHumancyConnection(
  id: string,
  type: HumancyType = 'vscode'
): {
  connection: HumancyConnection;
  receivedMessages: MessageEnvelope[];
  triggerMessage: (message: MessageEnvelope) => void;
  triggerDisconnect: () => void;
} {
  const receivedMessages: MessageEnvelope[] = [];
  const messageHandlers: MessageHandler[] = [];
  const disconnectHandlers: (() => void)[] = [];
  let closed = false;

  const connection: HumancyConnection = {
    connectionType: 'humancy',
    id,
    type,

    async send(message: MessageEnvelope): Promise<void> {
      if (closed) {
        throw new Error(`Cannot send to closed humancy connection: ${id}`);
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
