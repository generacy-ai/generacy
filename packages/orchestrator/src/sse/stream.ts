import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import type {
  SSEConnection,
  SSEConnectionOptions,
  SSEStreamConfig,
  SSEChannel,
  SSEFilters,
  SSEEvent,
} from '../types/sse.js';
import { DEFAULT_SSE_CONFIG, parseChannels, parseEventId } from '../types/sse.js';
import { formatSSEEvent, formatHeartbeat, createConnectedEvent } from './events.js';

/**
 * SSE Stream Manager
 * Manages individual SSE connections with heartbeat and event delivery
 */
export class SSEStream {
  private connection: SSEConnection;
  private config: SSEStreamConfig;
  private closed: boolean = false;

  constructor(
    response: ServerResponse,
    request: FastifyRequest,
    userId: string,
    options: SSEConnectionOptions = {},
    config: Partial<SSEStreamConfig> = {}
  ) {
    this.config = { ...DEFAULT_SSE_CONFIG, ...config };

    const connectionId = `conn_${randomUUID().slice(0, 8)}`;
    const channels = options.channels || parseChannels();

    this.connection = {
      id: connectionId,
      response,
      request: request.raw,
      userId,
      subscription: {
        channels: new Set(channels),
        filters: options.filters || {},
        lastEventId: options.lastEventId,
      },
      connectedAt: new Date(),
      sequenceCounter: 0,
    };
  }

  /**
   * Get connection ID
   */
  get id(): string {
    return this.connection.id;
  }

  /**
   * Get user ID
   */
  get userId(): string {
    return this.connection.userId;
  }

  /**
   * Get subscribed channels
   */
  get channels(): SSEChannel[] {
    return Array.from(this.connection.subscription.channels);
  }

  /**
   * Get subscription filters
   */
  get filters(): SSEFilters {
    return this.connection.subscription.filters;
  }

  /**
   * Check if connection is closed
   */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Get last event ID
   */
  get lastEventId(): string | undefined {
    return this.connection.subscription.lastEventId;
  }

  /**
   * Get next sequence number
   */
  private nextSequence(): number {
    return ++this.connection.sequenceCounter;
  }

  /**
   * Start the SSE stream
   * Sets up headers, sends initial connected event, and starts heartbeat
   */
  start(): void {
    if (this.closed) return;

    const res = this.connection.response;

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Prevent compression which can buffer events
    res.setHeader('Content-Encoding', 'identity');

    // Send initial connected event
    const connectedEvent = createConnectedEvent(
      this.connection.id,
      this.channels,
      this.nextSequence()
    );
    this.sendRaw(formatSSEEvent(connectedEvent));

    // Start heartbeat
    this.startHeartbeat();
  }

  /**
   * Send an SSE event
   */
  send<T>(event: SSEEvent<T>): boolean {
    if (this.closed) return false;
    return this.sendRaw(formatSSEEvent(event));
  }

  /**
   * Send raw SSE data
   */
  private sendRaw(data: string): boolean {
    if (this.closed) return false;

    try {
      const res = this.connection.response;
      if (res.writableEnded) {
        this.closed = true;
        return false;
      }
      res.write(data);
      return true;
    } catch {
      this.closed = true;
      return false;
    }
  }

  /**
   * Send heartbeat
   */
  sendHeartbeat(): boolean {
    return this.sendRaw(formatHeartbeat());
  }

  /**
   * Start heartbeat timer
   */
  private startHeartbeat(): void {
    if (this.connection.heartbeatTimer) {
      clearInterval(this.connection.heartbeatTimer);
    }

    this.connection.heartbeatTimer = setInterval(() => {
      if (!this.sendHeartbeat()) {
        this.close();
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * Stop heartbeat timer
   */
  private stopHeartbeat(): void {
    if (this.connection.heartbeatTimer) {
      clearInterval(this.connection.heartbeatTimer);
      this.connection.heartbeatTimer = undefined;
    }
  }

  /**
   * Check if connection is subscribed to a channel
   */
  isSubscribedTo(channel: SSEChannel): boolean {
    return this.connection.subscription.channels.has(channel);
  }

  /**
   * Check if event matches subscription filters
   */
  matchesFilters(workflowId?: string, tags?: string[]): boolean {
    const filters = this.connection.subscription.filters;

    // No filters = receive all
    if (!filters.workflowId && (!filters.tags || filters.tags.length === 0)) {
      return true;
    }

    // Match workflow ID if filter is set
    if (filters.workflowId && workflowId !== filters.workflowId) {
      return false;
    }

    // Match tags if filter is set
    if (filters.tags && filters.tags.length > 0 && tags) {
      const hasMatchingTag = filters.tags.some((tag) => tags.includes(tag));
      if (!hasMatchingTag) {
        return false;
      }
    }

    return true;
  }

  /**
   * Update subscription channels
   */
  updateChannels(channels: SSEChannel[]): void {
    this.connection.subscription.channels = new Set(channels);
  }

  /**
   * Update subscription filters
   */
  updateFilters(filters: SSEFilters): void {
    this.connection.subscription.filters = { ...this.connection.subscription.filters, ...filters };
  }

  /**
   * Close the connection
   */
  close(): void {
    if (this.closed) return;

    this.closed = true;
    this.stopHeartbeat();

    try {
      if (!this.connection.response.writableEnded) {
        this.connection.response.end();
      }
    } catch {
      // Ignore errors during close
    }
  }

  /**
   * Get connection info for logging
   */
  getInfo(): {
    id: string;
    userId: string;
    channels: SSEChannel[];
    connectedAt: Date;
    filters: SSEFilters;
  } {
    return {
      id: this.connection.id,
      userId: this.connection.userId,
      channels: this.channels,
      connectedAt: this.connection.connectedAt,
      filters: this.connection.subscription.filters,
    };
  }
}

/**
 * Create SSE response and return stream manager
 */
export function createSSEStream(
  reply: FastifyReply,
  request: FastifyRequest,
  userId: string,
  options: SSEConnectionOptions = {},
  config: Partial<SSEStreamConfig> = {}
): SSEStream {
  // Access raw response - mark reply as sent to prevent Fastify from handling it
  const response = reply.raw;

  // Create stream manager
  const stream = new SSEStream(response, request, userId, options, config);

  return stream;
}

/**
 * Parse Last-Event-ID header for reconnection support
 */
export function parseLastEventId(
  request: FastifyRequest
): { timestamp: number; connectionId: string; sequence: number } | null {
  const lastEventId = request.headers['last-event-id'];
  if (!lastEventId || typeof lastEventId !== 'string') {
    return null;
  }

  return parseEventId(lastEventId);
}
