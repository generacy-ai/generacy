/**
 * Channel message handler for routing channel messages.
 */

import type { MessageEnvelope } from '../types/messages.js';
import type { ChannelContext, ChannelHandler as Handler } from '../types/channels.js';
import { ChannelNotFoundError } from '../types/channels.js';
import { createMessageEnvelope } from '../types/messages.js';
import type { ChannelRegistry } from './channel-registry.js';
import { v4 as uuid } from 'uuid';

/** Events emitted by the ChannelMessageHandler */
export interface ChannelMessageHandlerEvents {
  'message:handled': (message: MessageEnvelope, channel: string) => void;
  'message:forwarded': (message: MessageEnvelope, fromChannel: string, toChannel: string) => void;
  'message:replied': (originalMessage: MessageEnvelope, reply: MessageEnvelope) => void;
  'message:error': (message: MessageEnvelope, channel: string, error: Error) => void;
}

type EventListener<K extends keyof ChannelMessageHandlerEvents> = ChannelMessageHandlerEvents[K];

/** Options for the channel message handler */
export interface ChannelMessageHandlerOptions {
  /** Function to route reply messages */
  routeReply?: (message: MessageEnvelope) => Promise<void>;

  /** Function to route forwarded messages */
  routeForward?: (message: MessageEnvelope) => Promise<void>;
}

/**
 * Handles routing of channel messages to their registered handlers.
 */
export class ChannelMessageHandler {
  private registry: ChannelRegistry;
  private options: ChannelMessageHandlerOptions;
  private listeners = new Map<keyof ChannelMessageHandlerEvents, Set<EventListener<keyof ChannelMessageHandlerEvents>>>();

  constructor(registry: ChannelRegistry, options: ChannelMessageHandlerOptions = {}) {
    this.registry = registry;
    this.options = options;
  }

  /**
   * Handle a channel message.
   * Routes the message to the registered channel handler.
   */
  async handle(message: MessageEnvelope): Promise<void> {
    if (!message.channel) {
      throw new Error('Message has no channel');
    }

    const channel = this.registry.get(message.channel);
    if (!channel) {
      throw new ChannelNotFoundError(message.channel);
    }

    // Create context for the handler
    const context = this.createContext(message);

    try {
      await channel.handler(message, context);
      this.emit('message:handled', message, message.channel);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('message:error', message, message.channel, err);
      throw err;
    }
  }

  /**
   * Creates a channel context for a message.
   */
  private createContext(message: MessageEnvelope): ChannelContext {
    return {
      message,

      reply: async (payload: unknown): Promise<void> => {
        const replyMessage = createMessageEnvelope({
          id: uuid(),
          correlationId: message.correlationId ?? message.id,
          type: 'channel_message',
          channel: message.channel,
          source: message.destination ?? { type: 'router', id: 'channel-handler' },
          destination: message.source,
          payload,
        });

        if (this.options.routeReply) {
          await this.options.routeReply(replyMessage);
          this.emit('message:replied', message, replyMessage);
        }
      },

      forward: async (channel: string, payload: unknown): Promise<void> => {
        const forwardedMessage = createMessageEnvelope({
          id: uuid(),
          correlationId: message.correlationId ?? message.id,
          type: 'channel_message',
          channel,
          source: message.source,
          payload,
        });

        if (this.options.routeForward) {
          await this.options.routeForward(forwardedMessage);
          this.emit('message:forwarded', message, message.channel!, channel);
        }
      },
    };
  }

  /**
   * Get the channel registry.
   */
  getRegistry(): ChannelRegistry {
    return this.registry;
  }

  // ============ Event Emitter ============

  /** Add event listener */
  on<K extends keyof ChannelMessageHandlerEvents>(
    event: K,
    listener: ChannelMessageHandlerEvents[K]
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as EventListener<keyof ChannelMessageHandlerEvents>);
  }

  /** Remove event listener */
  off<K extends keyof ChannelMessageHandlerEvents>(
    event: K,
    listener: ChannelMessageHandlerEvents[K]
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(listener as EventListener<keyof ChannelMessageHandlerEvents>);
    }
  }

  /** Emit event */
  private emit<K extends keyof ChannelMessageHandlerEvents>(
    event: K,
    ...args: Parameters<ChannelMessageHandlerEvents[K]>
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      for (const listener of eventListeners) {
        (listener as (...args: unknown[]) => void)(...args);
      }
    }
  }
}
