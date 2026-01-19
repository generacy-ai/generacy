/**
 * Dead Letter Queue for failed message handling.
 */

import type { MessageEnvelope } from '../types/messages.js';
import type { RetryConfig } from '../types/config.js';
import { DEFAULT_RETRY_CONFIG } from '../types/config.js';
import { calculateRetryDelay } from '../utils/retry.js';
import type { RedisStore } from './redis-store.js';
import { REDIS_KEYS } from './redis-store.js';

/** Dead letter entry status */
export type DeadLetterStatus = 'pending_retry' | 'max_retries_exceeded' | 'manually_resolved';

/** Dead letter queue entry */
export interface DeadLetterEntry {
  /** Original message */
  message: MessageEnvelope;

  /** Why the message failed */
  error: string;

  /** Failure timestamp */
  failedAt: number;

  /** Number of delivery attempts */
  attempts: number;

  /** Last attempt timestamp */
  lastAttemptAt: number;

  /** Current status */
  status: DeadLetterStatus;

  /** Target recipient type */
  recipientType: 'agency' | 'humancy';

  /** Target recipient ID */
  recipientId: string;

  /** Next retry timestamp (if pending_retry) */
  nextRetryAt?: number;
}

/** Events emitted by the DeadLetterQueue */
export interface DeadLetterQueueEvents {
  'entry:added': (entry: DeadLetterEntry) => void;
  'entry:retried': (entry: DeadLetterEntry) => void;
  'entry:resolved': (entry: DeadLetterEntry) => void;
  'entry:exceeded': (entry: DeadLetterEntry) => void;
}

type EventListener<K extends keyof DeadLetterQueueEvents> = DeadLetterQueueEvents[K];

/**
 * Dead Letter Queue for handling failed messages with exponential backoff retry.
 */
export class DeadLetterQueue {
  private store: RedisStore;
  private retryConfig: RetryConfig;
  private listeners = new Map<keyof DeadLetterQueueEvents, Set<EventListener<keyof DeadLetterQueueEvents>>>();
  private retryInterval?: ReturnType<typeof setInterval>;

  constructor(store: RedisStore, retryConfig: Partial<RetryConfig> = {}) {
    this.store = store;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  }

  /**
   * Add a failed message to the dead letter queue.
   */
  async add(
    message: MessageEnvelope,
    error: Error,
    recipientType: 'agency' | 'humancy',
    recipientId: string
  ): Promise<void> {
    const attempts = (message.meta.attempts ?? 0) + 1;
    const now = Date.now();

    let status: DeadLetterStatus;
    let nextRetryAt: number | undefined;

    if (attempts >= this.retryConfig.maxAttempts) {
      status = 'max_retries_exceeded';
    } else {
      status = 'pending_retry';
      const delay = calculateRetryDelay(attempts - 1, this.retryConfig);
      nextRetryAt = now + delay;
    }

    const entry: DeadLetterEntry = {
      message,
      error: error.message,
      failedAt: now,
      attempts,
      lastAttemptAt: now,
      status,
      recipientType,
      recipientId,
      nextRetryAt,
    };

    // Store in Redis
    await this.store.set(
      `${REDIS_KEYS.DLQ_ENTRY}${message.id}`,
      JSON.stringify(entry)
    );

    // Add to stream for ordered processing
    await this.store.getClient().xadd(
      REDIS_KEYS.DLQ_MESSAGES,
      '*',
      'messageId', message.id
    );

    if (status === 'max_retries_exceeded') {
      this.emit('entry:exceeded', entry);
    } else {
      this.emit('entry:added', entry);
    }
  }

  /**
   * Get a dead letter entry by message ID.
   */
  async get(messageId: string): Promise<DeadLetterEntry | null> {
    const data = await this.store.get(`${REDIS_KEYS.DLQ_ENTRY}${messageId}`);
    if (!data) return null;
    return JSON.parse(data) as DeadLetterEntry;
  }

  /**
   * Get all entries ready for retry.
   */
  async getReadyForRetry(): Promise<DeadLetterEntry[]> {
    const entries = await this.list('pending_retry');
    const now = Date.now();
    return entries.filter(e => e.nextRetryAt && e.nextRetryAt <= now);
  }

  /**
   * Get entries that have exceeded max retries.
   */
  async getExceeded(): Promise<DeadLetterEntry[]> {
    return this.list('max_retries_exceeded');
  }

  /**
   * List all entries with optional status filter.
   */
  async list(status?: DeadLetterStatus): Promise<DeadLetterEntry[]> {
    // Get all message IDs from stream
    const result = await this.store.getClient().xrange(REDIS_KEYS.DLQ_MESSAGES, '-', '+');
    const entries: DeadLetterEntry[] = [];

    for (const [, fields] of result) {
      if (!fields) continue;

      const messageIdIndex = fields.indexOf('messageId');
      if (messageIdIndex === -1 || messageIdIndex + 1 >= fields.length) continue;

      const messageId = fields[messageIdIndex + 1];
      if (!messageId) continue;

      const entry = await this.get(messageId);
      if (entry && (!status || entry.status === status)) {
        entries.push(entry);
      }
    }

    return entries;
  }

  /**
   * Mark an entry as ready for retry (reset next retry time to now).
   */
  async markForRetry(messageId: string): Promise<boolean> {
    const entry = await this.get(messageId);
    if (!entry || entry.status === 'manually_resolved') {
      return false;
    }

    entry.status = 'pending_retry';
    entry.nextRetryAt = Date.now();

    await this.store.set(
      `${REDIS_KEYS.DLQ_ENTRY}${messageId}`,
      JSON.stringify(entry)
    );

    return true;
  }

  /**
   * Mark an entry as manually resolved.
   */
  async resolve(messageId: string): Promise<boolean> {
    const entry = await this.get(messageId);
    if (!entry) {
      return false;
    }

    entry.status = 'manually_resolved';

    await this.store.set(
      `${REDIS_KEYS.DLQ_ENTRY}${messageId}`,
      JSON.stringify(entry)
    );

    // Remove from stream
    const result = await this.store.getClient().xrange(REDIS_KEYS.DLQ_MESSAGES, '-', '+');
    for (const [streamId, fields] of result) {
      if (!fields) continue;
      const idx = fields.indexOf('messageId');
      if (idx !== -1 && fields[idx + 1] === messageId) {
        await this.store.getClient().xdel(REDIS_KEYS.DLQ_MESSAGES, streamId ?? '');
        break;
      }
    }

    this.emit('entry:resolved', entry);
    return true;
  }

  /**
   * Delete an entry permanently.
   */
  async delete(messageId: string): Promise<boolean> {
    const exists = await this.store.exists(`${REDIS_KEYS.DLQ_ENTRY}${messageId}`);
    if (!exists) {
      return false;
    }

    await this.store.del(`${REDIS_KEYS.DLQ_ENTRY}${messageId}`);

    // Remove from stream
    const result = await this.store.getClient().xrange(REDIS_KEYS.DLQ_MESSAGES, '-', '+');
    for (const [streamId, fields] of result) {
      if (!fields) continue;
      const idx = fields.indexOf('messageId');
      if (idx !== -1 && fields[idx + 1] === messageId) {
        await this.store.getClient().xdel(REDIS_KEYS.DLQ_MESSAGES, streamId ?? '');
        break;
      }
    }

    return true;
  }

  /**
   * Process a retry for an entry.
   * Updates the entry with new attempt info.
   */
  async recordRetryAttempt(
    messageId: string,
    success: boolean,
    error?: Error
  ): Promise<void> {
    const entry = await this.get(messageId);
    if (!entry) return;

    const now = Date.now();
    entry.attempts++;
    entry.lastAttemptAt = now;

    if (success) {
      entry.status = 'manually_resolved';
      await this.store.set(
        `${REDIS_KEYS.DLQ_ENTRY}${messageId}`,
        JSON.stringify(entry)
      );
      await this.delete(messageId);
      this.emit('entry:resolved', entry);
    } else {
      if (entry.attempts >= this.retryConfig.maxAttempts) {
        entry.status = 'max_retries_exceeded';
        entry.nextRetryAt = undefined;
        this.emit('entry:exceeded', entry);
      } else {
        entry.status = 'pending_retry';
        const delay = calculateRetryDelay(entry.attempts - 1, this.retryConfig);
        entry.nextRetryAt = now + delay;
      }

      if (error) {
        entry.error = error.message;
      }

      await this.store.set(
        `${REDIS_KEYS.DLQ_ENTRY}${messageId}`,
        JSON.stringify(entry)
      );
    }
  }

  /**
   * Get statistics about the dead letter queue.
   */
  async getStats(): Promise<{
    total: number;
    pendingRetry: number;
    exceeded: number;
    resolved: number;
  }> {
    const entries = await this.list();
    return {
      total: entries.length,
      pendingRetry: entries.filter(e => e.status === 'pending_retry').length,
      exceeded: entries.filter(e => e.status === 'max_retries_exceeded').length,
      resolved: entries.filter(e => e.status === 'manually_resolved').length,
    };
  }

  /**
   * Start automatic retry processing.
   */
  startRetryProcessor(
    deliverFn: (entry: DeadLetterEntry) => Promise<void>,
    intervalMs: number = 5000
  ): void {
    this.stopRetryProcessor();

    this.retryInterval = setInterval(async () => {
      const ready = await this.getReadyForRetry();

      for (const entry of ready) {
        try {
          await deliverFn(entry);
          await this.recordRetryAttempt(entry.message.id, true);
        } catch (error) {
          await this.recordRetryAttempt(
            entry.message.id,
            false,
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
    }, intervalMs);
  }

  /**
   * Stop automatic retry processing.
   */
  stopRetryProcessor(): void {
    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = undefined;
    }
  }

  // ============ Event Emitter ============

  /** Add event listener */
  on<K extends keyof DeadLetterQueueEvents>(
    event: K,
    listener: DeadLetterQueueEvents[K]
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as EventListener<keyof DeadLetterQueueEvents>);
  }

  /** Remove event listener */
  off<K extends keyof DeadLetterQueueEvents>(
    event: K,
    listener: DeadLetterQueueEvents[K]
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(listener as EventListener<keyof DeadLetterQueueEvents>);
    }
  }

  /** Emit event */
  private emit<K extends keyof DeadLetterQueueEvents>(
    event: K,
    ...args: Parameters<DeadLetterQueueEvents[K]>
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      for (const listener of eventListeners) {
        (listener as (...args: unknown[]) => void)(...args);
      }
    }
  }
}
