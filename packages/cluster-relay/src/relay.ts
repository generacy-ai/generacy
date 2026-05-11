import WebSocket from 'ws';
import type { RelayConfig } from './config.js';
import { RelayConfigSchema } from './config.js';
import type { RelayMessage, ClusterMetadata, Activation } from './messages.js';
import { parseRelayMessage } from './messages.js';
import { collectMetadata } from './metadata.js';
import { handleApiRequest } from './proxy.js';
import { sortRoutes } from './dispatcher.js';
import type { RouteEntry } from './config.js';

export type RelayState = 'disconnected' | 'connecting' | 'authenticating' | 'connected' | 'disconnecting';

export interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Options accepted by ClusterRelayClient (orchestrator-facing API). */
export interface ClusterRelayClientOptions {
  /** API key for cloud authentication (GENERACY_API_KEY) */
  apiKey: string;
  /** Cloud relay WebSocket URL (set via GENERACY_RELAY_URL env var) */
  cloudUrl?: string;
  /** Base reconnect delay in ms (default: 5000) */
  baseReconnectDelayMs?: number;
  /** URL of the local orchestrator API (default: http://localhost:3000) */
  orchestratorUrl?: string;
  /** API key for authenticating relay-proxied requests to the orchestrator */
  orchestratorApiKey?: string;
  /** Path-prefix routes for dispatching API requests to unix sockets or HTTP targets */
  routes?: RouteEntry[];
}

type EventMap = {
  message: (msg: RelayMessage) => void;
  connected: () => void;
  disconnected: (reason: string) => void;
  error: (error: Error) => void;
};

const defaultLogger: Logger = {
  info(...args: unknown[]) {
    if (typeof args[0] === 'string') console.log(`[relay] ${args[0]}`);
    else console.log(`[relay]`, args[0], args[1]);
  },
  warn(...args: unknown[]) {
    if (typeof args[0] === 'string') console.warn(`[relay] ${args[0]}`);
    else console.warn(`[relay]`, args[0], args[1]);
  },
  error(...args: unknown[]) {
    if (typeof args[0] === 'string') console.error(`[relay] ${args[0]}`);
    else console.error(`[relay]`, args[0], args[1]);
  },
};

export class ClusterRelay {
  private _state: RelayState = 'disconnected';
  private ws: WebSocket | null = null;
  private readonly config: RelayConfig;
  private readonly logger: Logger;
  private readonly messageHandlers: Array<(message: RelayMessage) => void> = [];
  private readonly eventHandlers: Map<string, Set<(...args: unknown[]) => void>> = new Map();
  private running = false;
  private abortController: AbortController | null = null;
  private reconnectAttempt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongReceived = true;
  private metadataOverride: Partial<ClusterMetadata> | null = null;

  /**
   * Accept either a full RelayConfig or a ClusterRelayClientOptions (orchestrator API).
   * ClusterRelayClientOptions uses `cloudUrl` instead of `relayUrl`.
   */
  constructor(config: RelayConfig | ClusterRelayClientOptions, logger?: Logger) {
    if ('relayUrl' in config) {
      this.config = {
        ...config,
        routes: sortRoutes(config.routes ?? []),
      } as RelayConfig;
    } else {
      const opts = config as ClusterRelayClientOptions;
      this.config = RelayConfigSchema.parse({
        apiKey: opts.apiKey,
        relayUrl: opts.cloudUrl,
        baseReconnectDelayMs: opts.baseReconnectDelayMs,
        orchestratorUrl: opts.orchestratorUrl,
        orchestratorApiKey: opts.orchestratorApiKey,
        routes: opts.routes,
      });
    }
    this.logger = logger ?? defaultLogger;
  }

  /** Whether the relay is currently connected (orchestrator-facing API). */
  get isConnected(): boolean {
    return this._state === 'connected';
  }

  /** Register an event handler (orchestrator-facing EventEmitter API). */
  on<K extends keyof EventMap>(event: K, handler: EventMap[K]): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler as (...args: unknown[]) => void);
    // Also register message handlers in the legacy array for backward compat
    if (event === 'message') {
      this.messageHandlers.push(handler as EventMap['message']);
    }
  }

  /** Remove an event handler (orchestrator-facing EventEmitter API). */
  off(event: string, handler: (...args: unknown[]) => void): void {
    this.eventHandlers.get(event)?.delete(handler);
    if (event === 'message') {
      const idx = this.messageHandlers.indexOf(handler as (msg: RelayMessage) => void);
      if (idx !== -1) this.messageHandlers.splice(idx, 1);
    }
  }

  private emit<K extends keyof EventMap>(event: K, ...args: Parameters<EventMap[K]>): void {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        (handler as (...a: unknown[]) => void)(...(args as unknown[]));
      } catch (err) {
        this.logger.error({ err: String(err) }, `Event handler error for '${event}'`);
      }
    }
  }

  get state(): RelayState {
    return this._state;
  }

  /**
   * Establish WebSocket connection with automatic reconnection.
   */
  async connect(): Promise<void> {
    if (this.running) {
      this.logger.warn('Relay already running');
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    this.logger.info({ relayUrl: this.config.relayUrl }, 'Starting cluster relay');

    while (this.running && !signal.aborted) {
      let sleepMs = this.reconnectDelayMs;
      try {
        await this.connectOnce(signal);
        // Reset backoff on successful connection
        this.reconnectAttempt = 0;
        sleepMs = this.reconnectDelayMs;
      } catch (error) {
        if (signal.aborted) break;
        sleepMs = this.reconnectDelayMs;
        this.logger.warn(
          { err: String(error), reconnectMs: sleepMs, attempt: this.reconnectAttempt },
          'Relay connection lost, reconnecting...',
        );
        this.reconnectAttempt++;
      }

      if (this.running && !signal.aborted) {
        await this.sleep(sleepMs, signal);
      }
    }

    this.running = false;
    this._state = 'disconnected';
    this.logger.info('Cluster relay stopped');
  }

  /**
   * Gracefully disconnect.
   */
  async disconnect(): Promise<void> {
    if (!this.running) return;

    this._state = 'disconnecting';
    this.running = false;
    this.stopHeartbeat();

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
        ws.close(1000, 'Client disconnect');
        // Force close after 3 seconds
        setTimeout(() => resolve(), 3000);
      });
    }

    this._state = 'disconnected';
  }

  /**
   * Send a message over the WebSocket.
   */
  send(message: RelayMessage): void {
    if (this._state !== 'connected' || !this.ws) {
      this.logger.warn('Cannot send message: not connected');
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Register a handler for incoming messages.
   */
  onMessage(handler: (message: RelayMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Push an event to the cloud (library mode).
   */
  pushEvent(channel: string, event: unknown): void {
    this.send({ type: 'event', channel, event });
  }

  /**
   * Override metadata for library mode.
   */
  setMetadata(metadata: Partial<ClusterMetadata>): void {
    this.metadataOverride = metadata;
  }

  /**
   * Establish a single WebSocket connection, authenticate, and process messages.
   * Resolves when the connection closes normally, throws on error.
   */
  private async connectOnce(signal: AbortSignal): Promise<void> {
    this._state = 'connecting';

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.config.relayUrl, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      });

      const onAbort = () => {
        ws.close(1000, 'Aborted');
      };
      signal.addEventListener('abort', onAbort, { once: true });

      // Capture HTTP error response body for better diagnostics
      ws.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          this.logger.error(
            { statusCode: res.statusCode, body: body.trim() },
            `Relay connection rejected (HTTP ${res.statusCode})`
          );
          reject(new Error(`HTTP ${res.statusCode}: ${body.trim() || res.statusMessage}`));
        });
      });

      ws.on('open', () => {
        this._state = 'authenticating';
        this.ws = ws;
        this.logger.info('WebSocket connected, sending handshake');
        this.sendHandshake();
      });

      ws.on('message', (data: WebSocket.Data) => {
        const raw = data.toString();
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          this.logger.warn('Received non-JSON message, skipping');
          return;
        }

        const message = parseRelayMessage(parsed);
        if (!message) {
          this.logger.warn({ raw: parsed }, 'Invalid relay message, skipping');
          return;
        }

        // Handle handshake acknowledgment (transition to connected)
        if (this._state === 'authenticating' && message.type === 'heartbeat') {
          // Server acknowledges connection via heartbeat
          this._state = 'connected';
          this.logger.info('Relay authenticated and connected');
          this.startHeartbeat();
          this.emit('connected');
        }

        // If we receive any valid message while authenticating, consider us connected
        if (this._state === 'authenticating') {
          this._state = 'connected';
          this.logger.info('Relay connected');
          this.startHeartbeat();
          this.emit('connected');
        }

        // Handle api_request by proxying to orchestrator
        if (message.type === 'api_request') {
          handleApiRequest(message, this.config).then(
            (response) => this.send(response),
            (err) => this.logger.error({ err: String(err) }, 'Proxy error'),
          );
          return;
        }

        // Dispatch to registered handlers
        for (const handler of this.messageHandlers) {
          try {
            handler(message);
          } catch (err) {
            this.logger.error({ err: String(err) }, 'Message handler error');
          }
        }
      });

      ws.on('pong', () => {
        this.pongReceived = true;
      });

      ws.on('close', (code, reason) => {
        signal.removeEventListener('abort', onAbort);
        this.stopHeartbeat();
        this.ws = null;
        this._state = 'disconnected';
        const reasonStr = reason.toString() || 'connection closed';
        this.logger.info({ code, reason: reasonStr }, 'WebSocket closed');
        this.emit('disconnected', reasonStr);
        resolve();
      });

      ws.on('error', (err) => {
        signal.removeEventListener('abort', onAbort);
        this.stopHeartbeat();
        this.ws = null;
        this._state = 'disconnected';
        this.emit('error', err);
        reject(err);
      });
    });
  }

  /**
   * Send handshake with cluster metadata.
   */
  private async sendHandshake(): Promise<void> {
    try {
      const collected = await collectMetadata(this.config);
      const metadata: ClusterMetadata = { ...collected, ...this.metadataOverride };
      const handshake: RelayMessage & { activation?: Activation } = { type: 'handshake', metadata };
      if (this.config.activationCode) {
        handshake.activation = {
          code: this.config.activationCode,
          ...(this.config.clusterApiKeyId ? { clusterApiKeyId: this.config.clusterApiKeyId } : {}),
        };
      }
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(handshake));
      }
    } catch (err) {
      this.logger.error({ err: String(err) }, 'Failed to collect metadata for handshake');
    }
  }

  /**
   * Start the heartbeat interval.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pongReceived = true;

    this.heartbeatTimer = setInterval(() => {
      if (!this.pongReceived) {
        this.logger.warn('Heartbeat timeout — no pong received, reconnecting');
        this.ws?.terminate();
        return;
      }

      this.pongReceived = false;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        this.send({ type: 'heartbeat' });
      }
    }, this.config.heartbeatIntervalMs);
  }

  /**
   * Stop the heartbeat interval.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Calculate exponential backoff delay.
   */
  private get reconnectDelayMs(): number {
    const delay = this.config.baseReconnectDelayMs * Math.pow(2, this.reconnectAttempt);
    return Math.min(delay, this.config.maxReconnectDelayMs);
  }

  /**
   * Cancellable sleep.
   */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
