import type {
  SSEChannel,
  SSEFilters,
  SSEEvent,
  WorkflowSSEEvent,
  SSEStreamConfig,
} from '../types/sse.js';
import { DEFAULT_SSE_CONFIG } from '../types/sse.js';
import { SSEStream } from './stream.js';

/**
 * Buffered event for replay on reconnection
 */
interface BufferedEvent {
  event: SSEEvent<unknown>;
  timestamp: number;
  channel: SSEChannel;
}

/**
 * SSE Subscription Manager
 * Manages SSE connections, channel subscriptions, and event broadcasting
 */
export class SSESubscriptionManager {
  private connections: Map<string, SSEStream> = new Map();
  private channelSubscribers: Map<SSEChannel, Set<string>> = new Map();
  private userConnections: Map<string, Set<string>> = new Map();
  private eventBuffer: BufferedEvent[] = [];
  private config: SSEStreamConfig;

  constructor(config: Partial<SSEStreamConfig> = {}) {
    this.config = { ...DEFAULT_SSE_CONFIG, ...config };

    // Initialize channel sets
    this.channelSubscribers.set('workflows', new Set());
    this.channelSubscribers.set('queue', new Set());
    this.channelSubscribers.set('agents', new Set());
  }

  /**
   * Add a new SSE connection
   */
  addConnection(stream: SSEStream): boolean {
    const connectionId = stream.id;
    const userId = stream.userId;

    // Check per-user connection limit
    const userConns = this.userConnections.get(userId) || new Set();
    if (userConns.size >= this.config.maxConnectionsPerClient) {
      return false;
    }

    // Store connection
    this.connections.set(connectionId, stream);

    // Track per-user
    userConns.add(connectionId);
    this.userConnections.set(userId, userConns);

    // Subscribe to channels
    for (const channel of stream.channels) {
      this.channelSubscribers.get(channel)?.add(connectionId);
    }

    return true;
  }

  /**
   * Remove an SSE connection
   */
  removeConnection(connectionId: string): void {
    const stream = this.connections.get(connectionId);
    if (!stream) return;

    // Remove from channel sets
    for (const channel of stream.channels) {
      this.channelSubscribers.get(channel)?.delete(connectionId);
    }

    // Remove from user tracking
    const userConns = this.userConnections.get(stream.userId);
    if (userConns) {
      userConns.delete(connectionId);
      if (userConns.size === 0) {
        this.userConnections.delete(stream.userId);
      }
    }

    // Close stream and remove
    stream.close();
    this.connections.delete(connectionId);
  }

  /**
   * Get connection by ID
   */
  getConnection(connectionId: string): SSEStream | undefined {
    return this.connections.get(connectionId);
  }

  /**
   * Get all connections for a user
   */
  getUserConnections(userId: string): SSEStream[] {
    const connectionIds = this.userConnections.get(userId);
    if (!connectionIds) return [];

    return Array.from(connectionIds)
      .map((id) => this.connections.get(id))
      .filter((stream): stream is SSEStream => stream !== undefined);
  }

  /**
   * Get subscribers for a channel
   */
  getChannelSubscribers(channel: SSEChannel): SSEStream[] {
    const connectionIds = this.channelSubscribers.get(channel) || new Set();
    return Array.from(connectionIds)
      .map((id) => this.connections.get(id))
      .filter((stream): stream is SSEStream => stream !== undefined && !stream.isClosed);
  }

  /**
   * Broadcast event to all subscribers of a channel
   */
  broadcast<T>(channel: SSEChannel, event: SSEEvent<T>): number {
    const subscribers = this.getChannelSubscribers(channel);
    let sentCount = 0;

    for (const stream of subscribers) {
      if (stream.send(event)) {
        sentCount++;
      } else {
        // Connection closed, remove it
        this.removeConnection(stream.id);
      }
    }

    // Buffer event for reconnection replay
    this.bufferEvent(event, channel);

    return sentCount;
  }

  /**
   * Broadcast event with filter matching
   */
  broadcastFiltered<T>(
    channel: SSEChannel,
    event: SSEEvent<T>,
    matcher: (filters: SSEFilters) => boolean
  ): number {
    const subscribers = this.getChannelSubscribers(channel);
    let sentCount = 0;

    for (const stream of subscribers) {
      // Apply filter matching
      if (!matcher(stream.filters)) {
        continue;
      }

      if (stream.send(event)) {
        sentCount++;
      } else {
        this.removeConnection(stream.id);
      }
    }

    // Buffer event for reconnection replay
    this.bufferEvent(event, channel);

    return sentCount;
  }

  /**
   * Broadcast workflow event with filter matching
   */
  broadcastWorkflowEvent(event: WorkflowSSEEvent): number {
    return this.broadcastFiltered('workflows', event, (filters) => {
      // No filters = receive all
      if (!filters.workflowId && (!filters.tags || filters.tags.length === 0)) {
        return true;
      }

      // Match workflow ID
      if (filters.workflowId && filters.workflowId !== event.data.workflowId) {
        return false;
      }

      // Tags would need to be in the message payload - for now, pass if workflow matches
      return true;
    });
  }

  /**
   * Send event to a specific connection
   */
  send<T>(connectionId: string, event: SSEEvent<T>): boolean {
    const stream = this.connections.get(connectionId);
    if (!stream || stream.isClosed) {
      if (stream) {
        this.removeConnection(connectionId);
      }
      return false;
    }

    return stream.send(event);
  }

  /**
   * Buffer event for reconnection replay
   */
  private bufferEvent<T>(event: SSEEvent<T>, channel: SSEChannel): void {
    const now = Date.now();

    // Add to buffer
    this.eventBuffer.push({
      event: event as SSEEvent<unknown>,
      timestamp: now,
      channel,
    });

    // Trim buffer by size
    while (this.eventBuffer.length > this.config.eventBufferSize) {
      this.eventBuffer.shift();
    }

    // Trim buffer by age
    const cutoff = now - this.config.eventRetentionMs;
    while (this.eventBuffer.length > 0) {
      const oldest = this.eventBuffer[0];
      if (oldest && oldest.timestamp < cutoff) {
        this.eventBuffer.shift();
      } else {
        break;
      }
    }
  }

  /**
   * Get missed events since last event ID for reconnection
   */
  getMissedEvents(
    lastEventId: string,
    channels: SSEChannel[]
  ): SSEEvent<unknown>[] {
    // Parse the last event ID to get timestamp
    const parts = lastEventId.split('_');
    if (parts.length < 1) return [];

    const firstPart = parts[0];
    if (!firstPart) return [];

    const lastTimestamp = parseInt(firstPart, 10);
    if (isNaN(lastTimestamp)) return [];

    // Find events after the last received
    return this.eventBuffer
      .filter((buffered) => {
        // Must be after last event
        if (buffered.timestamp <= lastTimestamp) return false;

        // Must be in subscribed channels
        if (!channels.includes(buffered.channel)) return false;

        return true;
      })
      .map((buffered) => buffered.event);
  }

  /**
   * Replay missed events to a connection
   */
  replayMissedEvents(stream: SSEStream): number {
    const lastEventId = stream.lastEventId;
    if (!lastEventId) return 0;

    const missedEvents = this.getMissedEvents(lastEventId, stream.channels);
    let replayedCount = 0;

    for (const event of missedEvents) {
      if (stream.send(event)) {
        replayedCount++;
      } else {
        break;
      }
    }

    return replayedCount;
  }

  /**
   * Get total connection count
   */
  getTotalConnections(): number {
    return this.connections.size;
  }

  /**
   * Get connection count per channel
   */
  getChannelCounts(): Record<SSEChannel, number> {
    return {
      workflows: this.channelSubscribers.get('workflows')?.size || 0,
      queue: this.channelSubscribers.get('queue')?.size || 0,
      agents: this.channelSubscribers.get('agents')?.size || 0,
    };
  }

  /**
   * Get connection count per user
   */
  getUserCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [userId, connections] of this.userConnections) {
      counts.set(userId, connections.size);
    }
    return counts;
  }

  /**
   * Close all connections
   */
  closeAll(): void {
    for (const stream of this.connections.values()) {
      stream.close();
    }
    this.connections.clear();
    this.userConnections.clear();
    this.channelSubscribers.get('workflows')?.clear();
    this.channelSubscribers.get('queue')?.clear();
    this.channelSubscribers.get('agents')?.clear();
    this.eventBuffer = [];
  }

  /**
   * Clear all (for testing)
   */
  clear(): void {
    this.closeAll();
  }
}

// Singleton instance
let subscriptionManager: SSESubscriptionManager | null = null;

/**
 * Get the SSE subscription manager instance
 */
export function getSSESubscriptionManager(): SSESubscriptionManager {
  if (!subscriptionManager) {
    subscriptionManager = new SSESubscriptionManager();
  }
  return subscriptionManager;
}

/**
 * Reset SSE subscription manager (for testing)
 */
export function resetSSESubscriptionManager(): void {
  subscriptionManager?.clear();
  subscriptionManager = null;
}
