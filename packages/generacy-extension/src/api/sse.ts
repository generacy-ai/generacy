/**
 * SSE (Server-Sent Events) Subscription Manager for real-time orchestrator updates.
 *
 * Provides a centralized, singleton EventSource connection that any view can subscribe to.
 * Supports channel-based routing (workflows, queue, agents), auto-reconnect with exponential
 * backoff, and Last-Event-ID replay on reconnection.
 *
 * Since VS Code extensions run in a Node.js environment where the browser EventSource API
 * is not available, this implementation uses Node.js `http`/`https` for SSE connections
 * with manual event stream parsing.
 */
import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { getLogger } from '../utils/logger';
import type { SSEChannel, SSEEvent } from './types';
import { SSEEventSchema } from './types';

// ============================================================================
// Types
// ============================================================================

/** Callback for SSE event handling */
export type SSEEventHandler = (event: SSEEvent) => void;

/** Connection state of the SSE manager */
export type SSEConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** All supported SSE channels */
const ALL_CHANNELS: SSEChannel[] = ['workflows', 'queue', 'agents', 'jobs'];

// ============================================================================
// Constants
// ============================================================================

/** Initial reconnect delay in milliseconds */
const INITIAL_RECONNECT_DELAY = 1000;

/** Maximum reconnect delay in milliseconds */
const MAX_RECONNECT_DELAY = 30000;

/** Reconnect multiplier for exponential backoff */
const RECONNECT_MULTIPLIER = 2;

// ============================================================================
// SSE Subscription Manager
// ============================================================================

/**
 * Centralized SSE client that maintains a single connection to the orchestrator's
 * events endpoint and dispatches events to channel-based subscribers.
 *
 * Supports two endpoint modes:
 * - **Org-scoped** (cloud): `/api/orgs/{orgId}/orchestrator/events?channels=...`
 * - **Local** (no orgId): `/events?channels=...`
 *
 * Usage:
 * ```typescript
 * const manager = SSESubscriptionManager.getInstance();
 *
 * // Cloud mode (org-scoped)
 * manager.connect('https://api.generacy.ai', 'auth-token', 'org-123');
 *
 * // Local orchestrator mode
 * manager.connect('http://localhost:3100', 'auth-token');
 *
 * const disposable = manager.subscribe('queue', (event) => {
 *   console.log('Queue event:', event);
 * });
 *
 * // Later: disposable.dispose() to unsubscribe
 * // manager.disconnect() to close connection
 * ```
 */
export class SSESubscriptionManager implements vscode.Disposable {
  private static instance: SSESubscriptionManager | undefined;

  private subscribers: Map<SSEChannel, Set<SSEEventHandler>> = new Map();
  private currentRequest: http.ClientRequest | null = null;
  private connectionState: SSEConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEventId: string | undefined;
  private baseUrl: string | undefined;
  private authToken: string | undefined;
  private orgId: string | undefined;
  private disposed = false;

  private readonly _onDidChangeConnectionState = new vscode.EventEmitter<SSEConnectionState>();

  /**
   * Fires when the connection state changes.
   * Views can listen to this to update connection indicators.
   */
  public readonly onDidChangeConnectionState = this._onDidChangeConnectionState.event;

  private constructor() {
    for (const channel of ALL_CHANNELS) {
      this.subscribers.set(channel, new Set());
    }
  }

  /**
   * Get the singleton SSESubscriptionManager instance.
   */
  public static getInstance(): SSESubscriptionManager {
    if (!SSESubscriptionManager.instance) {
      SSESubscriptionManager.instance = new SSESubscriptionManager();
    }
    return SSESubscriptionManager.instance;
  }

  /**
   * Reset the singleton instance (for testing).
   */
  public static resetInstance(): void {
    SSESubscriptionManager.instance?.dispose();
    SSESubscriptionManager.instance = undefined;
  }

  // ==========================================================================
  // Connection Lifecycle
  // ==========================================================================

  /**
   * Open an SSE connection to the orchestrator's events endpoint.
   * If already connected, disconnects first before reconnecting.
   *
   * When `orgId` is provided, connects to the org-scoped endpoint:
   *   `{baseUrl}/api/orgs/{orgId}/orchestrator/events?channels=...`
   * Otherwise falls back to the local orchestrator endpoint:
   *   `{baseUrl}/events?channels=...`
   *
   * @param baseUrl - Orchestrator base URL (e.g., 'http://localhost:3100')
   * @param authToken - Authentication token for the connection
   * @param orgId - Organization ID for org-scoped SSE (optional, omit for local orchestrator)
   */
  public connect(baseUrl: string, authToken: string, orgId?: string): void {
    if (this.disposed) {
      return;
    }

    // Store for reconnection
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.authToken = authToken;
    this.orgId = orgId;

    // Disconnect existing connection first
    this.closeConnection();
    this.reconnectAttempts = 0;

    this.openConnection();
  }

  /**
   * Close the SSE connection and clear all reconnect timers.
   * Does not clear subscribers — they remain registered for reconnection.
   */
  public disconnect(): void {
    this.closeConnection();
    this.clearReconnectTimer();
    this.baseUrl = undefined;
    this.authToken = undefined;
    this.orgId = undefined;
    this.lastEventId = undefined;
    this.reconnectAttempts = 0;
    this.setConnectionState('disconnected');
  }

  // ==========================================================================
  // Subscription
  // ==========================================================================

  /**
   * Subscribe to events on a specific channel.
   * Returns a Disposable that removes the subscription when disposed.
   *
   * @param channel - The SSE channel to subscribe to
   * @param handler - Callback invoked for each event on the channel
   * @returns A Disposable for cleanup
   */
  public subscribe(channel: SSEChannel, handler: SSEEventHandler): vscode.Disposable {
    const handlers = this.subscribers.get(channel);
    if (!handlers) {
      throw new Error(`Unknown SSE channel: ${channel}`);
    }

    handlers.add(handler);

    return new vscode.Disposable(() => {
      handlers.delete(handler);
    });
  }

  // ==========================================================================
  // State
  // ==========================================================================

  /**
   * Whether the SSE connection is currently active and receiving events.
   */
  public isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  /**
   * Get the current connection state.
   */
  public getConnectionState(): SSEConnectionState {
    return this.connectionState;
  }

  // ==========================================================================
  // Disposable
  // ==========================================================================

  /**
   * Dispose of all resources: close connection, clear timers, remove subscribers.
   */
  public dispose(): void {
    this.disposed = true;
    this.closeConnection();
    this.clearReconnectTimer();
    this.subscribers.clear();
    this._onDidChangeConnectionState.dispose();
  }

  // ==========================================================================
  // Private: Connection Management
  // ==========================================================================

  private openConnection(): void {
    if (!this.baseUrl || !this.authToken || this.disposed) {
      return;
    }

    const logger = getLogger();
    this.setConnectionState('connecting');

    const channelsParam = ALL_CHANNELS.join(',');
    const eventsPath = this.orgId
      ? `/api/orgs/${this.orgId}/orchestrator/events`
      : '/events';
    const urlString = `${this.baseUrl}${eventsPath}?channels=${channelsParam}`;
    const url = new URL(urlString);

    const requestModule = url.protocol === 'https:' ? https : http;

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      Authorization: `Bearer ${this.authToken}`,
    };

    if (this.lastEventId) {
      headers['Last-Event-ID'] = this.lastEventId;
    }

    const requestOptions: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers,
    };

    try {
      const req = requestModule.request(requestOptions, (res) => {
        if (res.statusCode !== 200) {
          logger.error(`SSE connection failed with status ${res.statusCode}`);
          res.destroy();
          this.setConnectionState('error');
          this.scheduleReconnect();
          return;
        }

        this.setConnectionState('connected');
        this.reconnectAttempts = 0;
        logger.info('SSE connection established');

        res.setEncoding('utf8');

        let buffer = '';

        res.on('data', (chunk: string) => {
          buffer += chunk;
          buffer = this.processBuffer(buffer);
        });

        res.on('end', () => {
          logger.info('SSE connection closed by server');
          this.currentRequest = null;
          if (!this.disposed) {
            this.setConnectionState('disconnected');
            this.scheduleReconnect();
          }
        });

        res.on('error', (error) => {
          logger.error('SSE response error', error);
          this.currentRequest = null;
          if (!this.disposed) {
            this.setConnectionState('error');
            this.scheduleReconnect();
          }
        });
      });

      req.on('error', (error) => {
        logger.error('SSE request error', error);
        this.currentRequest = null;
        if (!this.disposed) {
          this.setConnectionState('error');
          this.scheduleReconnect();
        }
      });

      // No body to send for SSE GET request
      req.end();
      this.currentRequest = req;
    } catch (error) {
      logger.error('Failed to create SSE connection', error instanceof Error ? error : undefined);
      this.setConnectionState('error');
      this.scheduleReconnect();
    }
  }

  private closeConnection(): void {
    if (this.currentRequest) {
      this.currentRequest.destroy();
      this.currentRequest = null;
    }
  }

  // ==========================================================================
  // Private: SSE Event Stream Parsing
  // ==========================================================================

  /**
   * Process the SSE buffer, extracting complete events separated by double newlines.
   * Returns the remaining incomplete buffer.
   */
  private processBuffer(buffer: string): string {
    const logger = getLogger();

    // SSE events are separated by double newlines
    const parts = buffer.split('\n\n');

    // The last part may be incomplete — keep it in the buffer
    const remaining = parts.pop() ?? '';

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const rawEvent = this.parseSSEBlock(trimmed);
        if (rawEvent) {
          this.dispatchEvent(rawEvent);
        }
      } catch (error) {
        logger.warn('Failed to parse SSE event', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return remaining;
  }

  /**
   * Parse a single SSE event block into field values.
   * SSE format:
   *   id: <id>
   *   event: <event-type>
   *   data: <json-payload>
   */
  private parseSSEBlock(block: string): SSEEvent | null {
    const lines = block.split('\n');

    let id: string | undefined;
    let eventType: string | undefined;
    const dataLines: string[] = [];

    for (const line of lines) {
      // Skip comments
      if (line.startsWith(':')) {
        continue;
      }

      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) {
        continue;
      }

      const field = line.substring(0, colonIndex).trim();
      // SSE spec: if there's a space after the colon, strip it
      let value = line.substring(colonIndex + 1);
      if (value.startsWith(' ')) {
        value = value.substring(1);
      }

      switch (field) {
        case 'id':
          id = value;
          break;
        case 'event':
          eventType = value;
          break;
        case 'data':
          dataLines.push(value);
          break;
      }
    }

    // Must have at least data to constitute a valid event
    if (dataLines.length === 0) {
      return null;
    }

    // Track last event ID for reconnection replay
    if (id) {
      this.lastEventId = id;
    }

    const dataStr = dataLines.join('\n');

    try {
      const parsed = JSON.parse(dataStr);

      // The orchestrator sends structured events with channel + event type in the payload.
      // Validate against the SSEEvent schema.
      const result = SSEEventSchema.safeParse(parsed);
      if (result.success) {
        return result.data as SSEEvent;
      }

      // Fallback: if the data doesn't match the full schema but has required fields,
      // construct an SSEEvent from the SSE-level fields + parsed data
      return {
        id: id ?? '',
        event: eventType ?? 'message',
        channel: parsed.channel ?? this.inferChannel(eventType ?? ''),
        data: parsed.data ?? parsed,
        timestamp: parsed.timestamp ?? new Date().toISOString(),
      } as SSEEvent;
    } catch {
      // Data is not JSON — skip
      return null;
    }
  }

  /**
   * Infer the SSE channel from the event type string.
   * Event types follow the pattern "channel:action" (e.g., "queue:item:added").
   */
  private inferChannel(eventType: string): SSEChannel {
    if (eventType.startsWith('workflow')) {
      return 'workflows';
    }
    if (eventType.startsWith('queue')) {
      return 'queue';
    }
    if (eventType.startsWith('agent')) {
      return 'agents';
    }
    if (eventType.startsWith('job')) {
      return 'jobs';
    }
    // Default to workflows for unknown event types
    return 'workflows';
  }

  // ==========================================================================
  // Private: Event Dispatching
  // ==========================================================================

  /**
   * Dispatch a parsed SSE event to all subscribers on the matching channel.
   */
  private dispatchEvent(event: SSEEvent): void {
    const logger = getLogger();
    const handlers = this.subscribers.get(event.channel);

    if (!handlers || handlers.size === 0) {
      return;
    }

    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        logger.error(
          `Error in SSE event handler for channel '${event.channel}'`,
          error instanceof Error ? error : undefined,
        );
      }
    }
  }

  // ==========================================================================
  // Private: Reconnection
  // ==========================================================================

  /**
   * Schedule a reconnection attempt with exponential backoff.
   * Delays: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...
   */
  private scheduleReconnect(): void {
    if (this.disposed || !this.baseUrl || !this.authToken) {
      return;
    }

    this.clearReconnectTimer();

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY * Math.pow(RECONNECT_MULTIPLIER, this.reconnectAttempts),
      MAX_RECONNECT_DELAY,
    );

    const logger = getLogger();
    logger.debug(`SSE reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      this.openConnection();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ==========================================================================
  // Private: State Management
  // ==========================================================================

  private setConnectionState(state: SSEConnectionState): void {
    if (this.connectionState !== state) {
      this.connectionState = state;
      this._onDidChangeConnectionState.fire(state);
    }
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

/**
 * Get the singleton SSE Subscription Manager instance.
 */
export function getSSEManager(): SSESubscriptionManager {
  return SSESubscriptionManager.getInstance();
}
