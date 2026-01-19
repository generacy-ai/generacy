/**
 * Message queue for offline recipient message storage.
 */

import type { MessageEnvelope } from '../types/messages.js';
import type { RedisStore } from './redis-store.js';
import { isMessageExpired } from '../types/messages.js';

/** Events emitted by the MessageQueue */
export interface MessageQueueEvents {
  'message:enqueued': (type: 'agency' | 'humancy', recipientId: string, message: MessageEnvelope) => void;
  'message:delivered': (type: 'agency' | 'humancy', recipientId: string, message: MessageEnvelope) => void;
  'message:expired': (type: 'agency' | 'humancy', recipientId: string, message: MessageEnvelope) => void;
  'message:failed': (type: 'agency' | 'humancy', recipientId: string, message: MessageEnvelope, error: Error) => void;
}

type EventListener<K extends keyof MessageQueueEvents> = MessageQueueEvents[K];

/** Delivery function type */
export type DeliveryFunction = (message: MessageEnvelope) => Promise<void>;

/**
 * Message queue for handling offline message storage and delivery.
 */
export class MessageQueue {
  private store: RedisStore;
  private listeners = new Map<keyof MessageQueueEvents, Set<EventListener<keyof MessageQueueEvents>>>();

  constructor(store: RedisStore) {
    this.store = store;
  }

  /**
   * Enqueue a message for an offline recipient.
   */
  async enqueue(
    type: 'agency' | 'humancy',
    recipientId: string,
    message: MessageEnvelope
  ): Promise<void> {
    // Don't enqueue already expired messages
    if (isMessageExpired(message)) {
      this.emit('message:expired', type, recipientId, message);
      return;
    }

    // Increment attempt count
    const messageWithAttempt = {
      ...message,
      meta: {
        ...message.meta,
        attempts: (message.meta.attempts ?? 0) + 1,
      },
    };

    await this.store.enqueueMessage(type, recipientId, messageWithAttempt);
    this.emit('message:enqueued', type, recipientId, messageWithAttempt);
  }

  /**
   * Deliver all queued messages to a recipient.
   *
   * @param type - Recipient type
   * @param recipientId - Recipient ID
   * @param deliverFn - Function to deliver each message
   * @returns Number of messages successfully delivered
   */
  async deliverQueued(
    type: 'agency' | 'humancy',
    recipientId: string,
    deliverFn: DeliveryFunction
  ): Promise<{
    delivered: number;
    failed: number;
    expired: number;
  }> {
    const results = {
      delivered: 0,
      failed: 0,
      expired: 0,
    };

    // Get all queued messages
    const entries = await this.store.dequeueMessages(type, recipientId);

    if (entries.length === 0) {
      return results;
    }

    const toAcknowledge: string[] = [];

    for (const { streamId, message } of entries) {
      // Check expiration
      if (isMessageExpired(message)) {
        this.emit('message:expired', type, recipientId, message);
        toAcknowledge.push(streamId);
        results.expired++;
        continue;
      }

      try {
        await deliverFn(message);
        this.emit('message:delivered', type, recipientId, message);
        toAcknowledge.push(streamId);
        results.delivered++;
      } catch (error) {
        this.emit(
          'message:failed',
          type,
          recipientId,
          message,
          error instanceof Error ? error : new Error(String(error))
        );
        results.failed++;
        // Don't acknowledge failed messages - they'll be retried
      }
    }

    // Acknowledge successfully delivered and expired messages
    if (toAcknowledge.length > 0) {
      await this.store.acknowledgeMessages(type, recipientId, toAcknowledge);
    }

    return results;
  }

  /**
   * Get the number of queued messages for a recipient.
   */
  async getQueueLength(type: 'agency' | 'humancy', recipientId: string): Promise<number> {
    return this.store.getQueueLength(type, recipientId);
  }

  /**
   * Peek at queued messages without removing them.
   */
  async peek(
    type: 'agency' | 'humancy',
    recipientId: string,
    count: number = 10
  ): Promise<MessageEnvelope[]> {
    const entries = await this.store.dequeueMessages(type, recipientId, count);
    return entries.map(e => e.message);
  }

  // ============ Event Emitter ============

  /** Add event listener */
  on<K extends keyof MessageQueueEvents>(
    event: K,
    listener: MessageQueueEvents[K]
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as EventListener<keyof MessageQueueEvents>);
  }

  /** Remove event listener */
  off<K extends keyof MessageQueueEvents>(
    event: K,
    listener: MessageQueueEvents[K]
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(listener as EventListener<keyof MessageQueueEvents>);
    }
  }

  /** Emit event */
  private emit<K extends keyof MessageQueueEvents>(
    event: K,
    ...args: Parameters<MessageQueueEvents[K]>
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      for (const listener of eventListeners) {
        (listener as (...args: unknown[]) => void)(...args);
      }
    }
  }
}
