/**
 * Redis persistence adapter for message storage.
 */

import { Redis } from 'ioredis';
import type { RedisConfig } from '../types/config.js';
import type { MessageEnvelope } from '../types/messages.js';
import type { ConnectionStatus } from '../types/connections.js';

/** Redis key prefixes */
export const REDIS_KEYS = {
  CONNECTION_AGENCY: 'connections:agency:',
  CONNECTION_HUMANCY: 'connections:humancy:',
  QUEUE_AGENCY: 'queue:agency:',
  QUEUE_HUMANCY: 'queue:humancy:',
  DLQ_MESSAGES: 'dlq:messages',
  DLQ_ENTRY: 'dlq:entry:',
  CORRELATION: 'correlation:',
  CHANNEL: 'channels:',
  TTL_MESSAGE: 'ttl:message:',
} as const;

/** Connection state stored in Redis */
export interface StoredConnection {
  id: string;
  type: 'agency' | 'humancy';
  subtype?: 'vscode' | 'cloud';
  status: ConnectionStatus;
  registeredAt: number;
  lastSeenAt: number;
}

/**
 * Redis store adapter for message router persistence.
 */
export class RedisStore {
  private client: Redis;
  private subscriber?: Redis;
  private isConnected = false;

  constructor(config: RedisConfig) {
    this.client = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db,
      lazyConnect: true,
    });
  }

  /** Connect to Redis */
  async connect(): Promise<void> {
    if (this.isConnected) return;
    await this.client.connect();
    this.isConnected = true;
  }

  /** Disconnect from Redis */
  async disconnect(): Promise<void> {
    if (!this.isConnected) return;
    await this.client.quit();
    if (this.subscriber) {
      await this.subscriber.quit();
    }
    this.isConnected = false;
  }

  /** Get the Redis client (for advanced operations) */
  getClient(): Redis {
    return this.client;
  }

  // ============ Connection Storage ============

  /** Store connection state */
  async storeConnection(
    type: 'agency' | 'humancy',
    connection: StoredConnection,
    ttlSeconds?: number
  ): Promise<void> {
    const key = type === 'agency'
      ? `${REDIS_KEYS.CONNECTION_AGENCY}${connection.id}`
      : `${REDIS_KEYS.CONNECTION_HUMANCY}${connection.id}`;

    const data = JSON.stringify(connection);

    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, data);
    } else {
      await this.client.set(key, data);
    }
  }

  /** Get connection state */
  async getConnection(type: 'agency' | 'humancy', id: string): Promise<StoredConnection | null> {
    const key = type === 'agency'
      ? `${REDIS_KEYS.CONNECTION_AGENCY}${id}`
      : `${REDIS_KEYS.CONNECTION_HUMANCY}${id}`;

    const data = await this.client.get(key);
    if (!data) return null;

    return JSON.parse(data) as StoredConnection;
  }

  /** Delete connection state */
  async deleteConnection(type: 'agency' | 'humancy', id: string): Promise<void> {
    const key = type === 'agency'
      ? `${REDIS_KEYS.CONNECTION_AGENCY}${id}`
      : `${REDIS_KEYS.CONNECTION_HUMANCY}${id}`;

    await this.client.del(key);
  }

  /** Get all connections of a type */
  async getAllConnections(type: 'agency' | 'humancy'): Promise<StoredConnection[]> {
    const prefix = type === 'agency'
      ? REDIS_KEYS.CONNECTION_AGENCY
      : REDIS_KEYS.CONNECTION_HUMANCY;

    const keys = await this.client.keys(`${prefix}*`);
    if (keys.length === 0) return [];

    const values = await this.client.mget(...keys);
    return values
      .filter((v): v is string => v !== null)
      .map(v => JSON.parse(v) as StoredConnection);
  }

  // ============ Message Queue ============

  /** Enqueue message for offline recipient using Redis Stream */
  async enqueueMessage(
    type: 'agency' | 'humancy',
    recipientId: string,
    message: MessageEnvelope
  ): Promise<string> {
    const streamKey = type === 'agency'
      ? `${REDIS_KEYS.QUEUE_AGENCY}${recipientId}`
      : `${REDIS_KEYS.QUEUE_HUMANCY}${recipientId}`;

    // Use XADD to add to stream
    const messageId = await this.client.xadd(
      streamKey,
      '*', // Auto-generate ID
      'data', JSON.stringify(message)
    );

    // Set TTL on the message for expiration
    if (message.meta.ttl) {
      const ttlKey = `${REDIS_KEYS.TTL_MESSAGE}${message.id}`;
      await this.client.setex(ttlKey, Math.ceil(message.meta.ttl / 1000), '1');
    }

    return messageId ?? '';
  }

  /** Dequeue messages for a recipient (consume from stream) */
  async dequeueMessages(
    type: 'agency' | 'humancy',
    recipientId: string,
    count: number = 100
  ): Promise<Array<{ streamId: string; message: MessageEnvelope }>> {
    const streamKey = type === 'agency'
      ? `${REDIS_KEYS.QUEUE_AGENCY}${recipientId}`
      : `${REDIS_KEYS.QUEUE_HUMANCY}${recipientId}`;

    // Read from beginning of stream
    const result = await this.client.xrange(streamKey, '-', '+', 'COUNT', count);
    if (!result || result.length === 0) return [];

    const messages: Array<{ streamId: string; message: MessageEnvelope }> = [];

    for (const [streamId, fields] of result) {
      if (!fields || fields.length < 2) continue;

      // Fields is ['data', 'json_string']
      const dataIndex = fields.indexOf('data');
      if (dataIndex === -1 || dataIndex + 1 >= fields.length) continue;

      const data = fields[dataIndex + 1];
      if (!data) continue;

      try {
        const message = JSON.parse(data) as MessageEnvelope;

        // Check if message has expired
        const ttlKey = `${REDIS_KEYS.TTL_MESSAGE}${message.id}`;
        const ttlExists = await this.client.exists(ttlKey);

        // If TTL key doesn't exist and message had TTL, it's expired
        if (message.meta.ttl && !ttlExists) {
          // Skip expired message
          continue;
        }

        messages.push({ streamId: streamId ?? '', message });
      } catch {
        // Skip malformed messages
      }
    }

    return messages;
  }

  /** Acknowledge messages (remove from stream after successful delivery) */
  async acknowledgeMessages(
    type: 'agency' | 'humancy',
    recipientId: string,
    streamIds: string[]
  ): Promise<number> {
    if (streamIds.length === 0) return 0;

    const streamKey = type === 'agency'
      ? `${REDIS_KEYS.QUEUE_AGENCY}${recipientId}`
      : `${REDIS_KEYS.QUEUE_HUMANCY}${recipientId}`;

    // Delete acknowledged entries from stream
    const deleted = await this.client.xdel(streamKey, ...streamIds);
    return deleted;
  }

  /** Get queue length */
  async getQueueLength(type: 'agency' | 'humancy', recipientId: string): Promise<number> {
    const streamKey = type === 'agency'
      ? `${REDIS_KEYS.QUEUE_AGENCY}${recipientId}`
      : `${REDIS_KEYS.QUEUE_HUMANCY}${recipientId}`;

    const length = await this.client.xlen(streamKey);
    return length;
  }

  // ============ Pub/Sub ============

  /** Subscribe to a channel */
  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    if (!this.subscriber) {
      this.subscriber = this.client.duplicate();
      await this.subscriber.connect();
    }

    await this.subscriber.subscribe(channel);
    this.subscriber.on('message', (ch, msg) => {
      if (ch === channel) {
        callback(msg);
      }
    });
  }

  /** Publish to a channel */
  async publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  /** Unsubscribe from a channel */
  async unsubscribe(channel: string): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.unsubscribe(channel);
    }
  }

  // ============ Generic Operations ============

  /** Set a key with optional TTL */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  /** Get a key */
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /** Delete a key */
  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  /** Check if key exists */
  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  /** Set key expiration */
  async expire(key: string, seconds: number): Promise<void> {
    await this.client.expire(key, seconds);
  }
}
