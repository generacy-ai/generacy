/**
 * RelayBridge: Orchestrator ↔ Cloud Relay integration.
 *
 * Bridges the local orchestrator with the cloud relay service by:
 * 1. Routing incoming API requests via Fastify inject()
 * 2. Forwarding SSE events through the relay client
 * 3. Reporting cluster metadata periodically
 *
 * Follows the SmeeWebhookReceiver lifecycle pattern (start/stop with running flag).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import type { FastifyInstance } from 'fastify';
import type { SSESubscriptionManager } from '../sse/subscriptions.js';
import type {
  ClusterRelayClient,
  RelayMessage,
  RelayApiRequest,
  ClusterMetadataPayload,
  GitRemoteInfo,
  RelayBridgeOptions,
} from '../types/relay.js';
import type { SSEChannel, SSEEvent } from '../types/sse.js';
import type { ConversationManager } from '../conversation/conversation-manager.js';
import { ConversationRelayInputSchema } from '../conversation/types.js';
import type { ConversationOutputEvent } from '../conversation/types.js';

export class RelayBridge {
  private readonly client: ClusterRelayClient;
  private readonly server: FastifyInstance;
  private readonly sseManager: SSESubscriptionManager;
  private readonly logger: RelayBridgeOptions['logger'];
  private readonly config: RelayBridgeOptions['config'];
  private conversationManager: ConversationManager | null = null;

  private running = false;
  private metadataTimer: NodeJS.Timeout | null = null;
  private originalBroadcast: SSESubscriptionManager['broadcast'] | null = null;

  private readonly messageHandler: (msg: RelayMessage) => void;
  private readonly connectedHandler: () => void;
  private readonly disconnectedHandler: (reason: string) => void;
  private readonly errorHandler: (error: Error) => void;

  constructor(options: RelayBridgeOptions) {
    this.client = options.client;
    this.server = options.server;
    this.sseManager = options.sseManager;
    this.logger = options.logger;
    this.config = options.config;

    // Bind handlers once so they can be removed with off()
    this.messageHandler = (msg: RelayMessage) => this.handleMessage(msg);
    this.connectedHandler = () => this.handleConnected();
    this.disconnectedHandler = (reason: string) => this.handleDisconnected(reason);
    this.errorHandler = (error: Error) => this.handleError(error);
  }

  /**
   * Start the relay bridge: connect client, register handlers, set up forwarding.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('Relay bridge already running');
      return;
    }

    this.running = true;

    // Register event handlers before connecting
    this.client.on('message', this.messageHandler);
    this.client.on('connected', this.connectedHandler);
    this.client.on('disconnected', this.disconnectedHandler);
    this.client.on('error', this.errorHandler);

    try {
      await this.client.connect();
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Relay connection failed, continuing in local-only mode',
      );
    }
  }

  /**
   * Stop the relay bridge: disconnect client, remove forwarding, clear timers.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    // Clear metadata timer
    this.clearMetadataTimer();

    // Restore original broadcast method
    this.removeEventForwarding();

    // Remove event handlers
    this.client.off('message', this.messageHandler as (...args: unknown[]) => void);
    this.client.off('connected', this.connectedHandler as (...args: unknown[]) => void);
    this.client.off('disconnected', this.disconnectedHandler as (...args: unknown[]) => void);
    this.client.off('error', this.errorHandler as (...args: unknown[]) => void);

    try {
      await this.client.disconnect();
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Error during relay disconnect',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Job Event Emission
  // ---------------------------------------------------------------------------

  /**
   * Emit a job lifecycle event through the relay WebSocket.
   * Fire-and-forget — no-ops when disconnected, never throws.
   */
  emitJobEvent(event: string, data: Record<string, unknown>): void {
    try {
      if (!this.client.isConnected) return;
      this.client.send({
        type: 'event' as const,
        event,
        data,
        timestamp: new Date().toISOString(),
      } as RelayMessage);
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), event },
        'Failed to emit job event (non-fatal)',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  private handleConnected(): void {
    this.logger.info('Relay connected to cloud');

    // Set up event forwarding
    this.setupEventForwarding();

    // Send metadata immediately on connect
    this.sendMetadata();

    // Start periodic metadata timer
    this.startMetadataTimer();
  }

  private handleDisconnected(reason: string): void {
    this.logger.warn({ reason }, 'Relay disconnected from cloud');

    // Remove event forwarding while disconnected
    this.removeEventForwarding();

    // Clear metadata timer
    this.clearMetadataTimer();
  }

  private handleError(error: Error): void {
    this.logger.error(
      { err: error.message },
      'Relay client error',
    );
  }

  /**
   * Wire a ConversationManager to receive incoming conversation messages
   * and forward output events through the relay.
   */
  setConversationManager(manager: ConversationManager): void {
    this.conversationManager = manager;

    // Forward conversation output events through the relay
    manager.setOutputCallback((conversationId: string, event: ConversationOutputEvent) => {
      this.sendConversationOutput(conversationId, event);
    });
  }

  private handleMessage(msg: RelayMessage): void {
    try {
      if (msg.type === 'api_request') {
        this.handleApiRequest(msg);
      } else if (msg.type === 'conversation') {
        this.handleConversationMessage(msg as RelayMessage & { type: 'conversation'; conversationId: string; data: unknown });
      }
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Error handling relay message',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // API Request Routing
  // ---------------------------------------------------------------------------

  private handleApiRequest(request: RelayApiRequest): void {
    // Use Fastify inject() for zero-overhead internal routing
    this.server
      .inject({
        method: request.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
        url: request.url,
        headers: request.headers,
        payload: request.body as string | Record<string, unknown> | undefined,
      })
      .then((response) => {
        try {
          // Parse response headers into a plain record
          const headers: Record<string, string> = {};
          const rawHeaders = response.headers;
          for (const [key, value] of Object.entries(rawHeaders)) {
            if (typeof value === 'string') {
              headers[key] = value;
            } else if (Array.isArray(value)) {
              headers[key] = value.join(', ');
            }
          }

          // Parse response body
          let body: unknown;
          try {
            body = JSON.parse(response.body);
          } catch {
            body = response.body;
          }

          this.client.send({
            type: 'api_response',
            id: request.id,
            statusCode: response.statusCode,
            headers,
            body,
          });
        } catch (error) {
          this.logger.error(
            { err: error instanceof Error ? error.message : String(error), requestId: request.id },
            'Error sending relay API response',
          );
        }
      })
      .catch((error) => {
        this.logger.error(
          { err: error instanceof Error ? error.message : String(error), requestId: request.id },
          'Error processing relay API request',
        );
        // Send error response so the cloud doesn't hang
        try {
          this.client.send({
            type: 'api_response',
            id: request.id,
            statusCode: 500,
            headers: { 'content-type': 'application/json' },
            body: { error: 'Internal relay routing error' },
          });
        } catch {
          // Best effort — ignore send failures
        }
      });
  }

  // ---------------------------------------------------------------------------
  // Event Forwarding
  // ---------------------------------------------------------------------------

  private setupEventForwarding(): void {
    if (this.originalBroadcast) return; // Already set up

    const originalBroadcast = this.sseManager.broadcast.bind(this.sseManager);
    this.originalBroadcast = originalBroadcast;

    this.sseManager.broadcast = <T>(channel: SSEChannel, event: SSEEvent<T>): number => {
      const count = originalBroadcast(channel, event);

      // Forward event through relay
      try {
        if (this.client.isConnected) {
          this.client.send({
            type: 'event',
            channel,
            event: event as SSEEvent,
          });
        }
      } catch (error) {
        this.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          'Error forwarding event through relay',
        );
      }

      return count;
    };
  }

  private removeEventForwarding(): void {
    if (this.originalBroadcast) {
      this.sseManager.broadcast = this.originalBroadcast;
      this.originalBroadcast = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Conversation Message Handling
  // ---------------------------------------------------------------------------

  private handleConversationMessage(msg: { conversationId: string; data: unknown }): void {
    if (!this.conversationManager) {
      this.logger.warn('Received conversation message but no ConversationManager is configured');
      return;
    }

    const parsed = ConversationRelayInputSchema.safeParse(msg.data);
    if (!parsed.success) {
      this.logger.warn(
        { conversationId: msg.conversationId, error: parsed.error.message },
        'Invalid conversation relay input',
      );
      return;
    }

    this.conversationManager.sendMessage(msg.conversationId, parsed.data.content).catch((error) => {
      this.logger.error(
        { conversationId: msg.conversationId, err: error instanceof Error ? error.message : String(error) },
        'Error routing conversation message to manager',
      );
    });
  }

  /**
   * Send a conversation output event through the relay.
   */
  private sendConversationOutput(conversationId: string, event: ConversationOutputEvent): void {
    try {
      if (this.client.isConnected) {
        this.client.send({
          type: 'conversation',
          conversationId,
          data: {
            event: event.event,
            payload: event.payload,
            timestamp: event.timestamp,
          },
        } as unknown as RelayMessage);
      }
    } catch (error) {
      this.logger.error(
        { conversationId, err: error instanceof Error ? error.message : String(error) },
        'Error sending conversation output through relay',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Metadata Collection & Reporting
  // ---------------------------------------------------------------------------

  private startMetadataTimer(): void {
    this.clearMetadataTimer();
    this.metadataTimer = setInterval(() => {
      this.sendMetadata();
    }, this.config.metadataIntervalMs);
  }

  private clearMetadataTimer(): void {
    if (this.metadataTimer) {
      clearInterval(this.metadataTimer);
      this.metadataTimer = null;
    }
  }

  private sendMetadata(): void {
    try {
      const metadata = this.collectMetadata();
      if (this.client.isConnected) {
        this.client.send({
          type: 'metadata',
          data: metadata,
        });
      }
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Error sending metadata',
      );
    }
  }

  collectMetadata(): ClusterMetadataPayload {
    const metadata: ClusterMetadataPayload = {
      version: this.getVersion(),
      uptimeSeconds: process.uptime(),
      activeWorkflowCount: this.getActiveWorkflowCount(),
      gitRemotes: this.getGitRemotes(),
      reportedAt: new Date().toISOString(),
    };

    // Add cluster.yaml fields if available
    const clusterData = this.readClusterYaml();
    if (clusterData) {
      if (clusterData.workerCount !== undefined) {
        metadata.workerCount = clusterData.workerCount;
      }
      if (clusterData.channel !== undefined) {
        metadata.channel = clusterData.channel;
      }
    }

    return metadata;
  }

  private getVersion(): string {
    try {
      const pkgPath = resolve(
        new URL('.', import.meta.url).pathname,
        '../../package.json',
      );
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      return pkg.version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private getActiveWorkflowCount(): number {
    try {
      // Access workflow count through the Fastify server decorations if available
      // For now, return 0 as a safe default
      return 0;
    } catch {
      return 0;
    }
  }

  private getGitRemotes(): GitRemoteInfo[] {
    try {
      const output = execSync('git remote -v', {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const remotes: GitRemoteInfo[] = [];
      const seen = new Set<string>();

      for (const line of output.trim().split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split(/\s+/);
        const name = parts[0];
        const url = parts[1];
        if (name && url && !seen.has(name)) {
          seen.add(name);
          remotes.push({ name, url });
        }
      }

      return remotes;
    } catch {
      return [];
    }
  }

  private readClusterYaml(): { workerCount?: number; channel?: 'preview' | 'stable' } | null {
    try {
      const yamlPath = resolve(this.config.clusterYamlPath);
      if (!existsSync(yamlPath)) return null;

      const content = readFileSync(yamlPath, 'utf-8');
      const parsed = parseYaml(content);

      return {
        workerCount: typeof parsed?.workerCount === 'number' ? parsed.workerCount : undefined,
        channel: parsed?.channel === 'preview' || parsed?.channel === 'stable' ? parsed.channel : undefined,
      };
    } catch {
      return null;
    }
  }
}
