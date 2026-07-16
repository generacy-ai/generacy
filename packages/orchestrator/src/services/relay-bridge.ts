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

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { readMergedClusterConfig } from '@generacy-ai/config';
import {
  type DockerEngineClient,
  computeProjectName,
  enumerateWorkers,
} from '@generacy-ai/control-plane';
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
import type { LeaseManager } from './lease-manager.js';
import type { StatusReporter } from './status-reporter.js';
import { readFile } from 'node:fs/promises';
import { probeCodeServerSocket } from './code-server-probe.js';
import { probeControlPlaneSocket } from './control-plane-probe.js';
import {
  clearRetainedTunnelEvent,
  getRetainedTunnelEvent,
} from '../routes/retained-tunnel-event.js';

export interface TunnelHandlerLike {
  handleOpen(msg: { tunnelId: string; target: string }): Promise<void>;
  handleData(msg: { tunnelId: string; data: string }): void;
  handleClose(msg: { tunnelId: string; reason?: string }): void;
  cleanup(): void;
}

const WORKER_EVENT_BACKOFF_INITIAL_MS = 5_000;
const WORKER_EVENT_BACKOFF_MAX_MS = 60_000;
const WORKER_EVENT_RESET_BACKOFF_AFTER_MS = 30_000;
const WORKER_EVENT_ACTIONS = new Set(['create', 'start', 'die', 'destroy']);

export class RelayBridge {
  private readonly client: ClusterRelayClient;
  private readonly server: FastifyInstance;
  private readonly sseManager: SSESubscriptionManager;
  private readonly logger: RelayBridgeOptions['logger'];
  private readonly config: RelayBridgeOptions['config'];
  private readonly cluster: RelayBridgeOptions['cluster'];
  private readonly engineClient: DockerEngineClient;
  private conversationManager: ConversationManager | null = null;
  private leaseManager: LeaseManager | null = null;
  private statusReporter: StatusReporter | null = null;
  private tunnelHandler: TunnelHandlerLike | null = null;

  private running = false;
  private metadataTimer: NodeJS.Timeout | null = null;
  private originalBroadcast: SSESubscriptionManager['broadcast'] | null = null;

  // Worker event subscription state
  private workerEventAbort: AbortController | null = null;
  private workerEventReconnectTimer: NodeJS.Timeout | null = null;
  private workerEventBackoffMs: number = WORKER_EVENT_BACKOFF_INITIAL_MS;
  private cachedProjectName: string | null = null;
  private workerEventSubscriptionSkipped = false;
  private workerCountOmissionWarned = false;

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
    this.cluster = options.cluster;
    this.engineClient = options.engineClient;

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

    // Subscribe to Docker Engine container lifecycle events so the workers
    // tile in the cloud UI updates within ~10s of a `docker stop` (#714).
    // Fire-and-forget — the loop owns its own reconnect/backoff.
    this.startWorkerEventSubscription();
  }

  /**
   * Stop the relay bridge: disconnect client, remove forwarding, clear timers.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    // Clear metadata timer
    this.clearMetadataTimer();

    // Stop the worker event subscription and any pending reconnect.
    if (this.workerEventAbort) {
      this.workerEventAbort.abort();
      this.workerEventAbort = null;
    }
    this.clearWorkerEventReconnectTimer();

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
        type: 'event',
        event,
        data,
        timestamp: new Date().toISOString(),
      });
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

    this.replayRetainedTunnelEvent();

    // Send metadata immediately on connect
    this.sendMetadata().catch((err) => {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Error in initial metadata send',
      );
    });

    // Start periodic metadata timer
    this.startMetadataTimer();

    // Push ready status to control-plane
    if (this.statusReporter) {
      this.statusReporter.pushStatus('ready').catch(() => {});
    }
  }

  private replayRetainedTunnelEvent(): void {
    const retained = getRetainedTunnelEvent();
    if (!retained) return;
    if (!this.client.isConnected) return;
    try {
      this.client.send({
        type: 'event',
        event: retained.event,
        data: retained.data,
        timestamp: retained.timestamp,
      });
      clearRetainedTunnelEvent();
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to replay retained cluster.vscode-tunnel event (non-fatal)',
      );
    }
  }

  private handleDisconnected(reason: string): void {
    this.logger.warn({ reason }, 'Relay disconnected from cloud');

    // Remove event forwarding while disconnected
    this.removeEventForwarding();

    // Clear metadata timer
    this.clearMetadataTimer();

    // Clean up tunnel connections (stateless across reconnects)
    if (this.tunnelHandler) {
      this.tunnelHandler.cleanup();
    }

    // Push degraded status to control-plane
    if (this.statusReporter) {
      this.statusReporter.pushStatus('degraded', `Relay disconnected: ${reason}`).catch(() => {});
    }
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

  /**
   * Wire a LeaseManager to receive incoming lease protocol messages
   * and route them to the appropriate handler.
   */
  setLeaseManager(manager: LeaseManager): void {
    this.leaseManager = manager;
  }

  /**
   * Wire a StatusReporter to push lifecycle state to the control-plane.
   */
  setStatusReporter(reporter: StatusReporter): void {
    this.statusReporter = reporter;
  }

  /**
   * Wire a TunnelHandler to receive tunnel messages from the relay.
   */
  setTunnelHandler(handler: TunnelHandlerLike): void {
    this.tunnelHandler = handler;
  }

  private handleMessage(msg: RelayMessage): void {
    try {
      if (msg.type === 'api_request') {
        this.handleApiRequest(msg);
      } else if (msg.type === 'conversation') {
        this.handleConversationMessage(msg as RelayMessage & { type: 'conversation'; conversationId: string; data: unknown });
      } else if (msg.type === 'lease_granted' || msg.type === 'lease_denied') {
        if (this.leaseManager) {
          this.leaseManager.handleLeaseResponse(msg);
        }
      } else if (msg.type === 'slot_available') {
        if (this.leaseManager) {
          this.leaseManager.handleSlotAvailable(msg);
        }
      } else if (msg.type === 'tier_info') {
        if (this.leaseManager) {
          this.leaseManager.handleTierInfo(msg);
        }
      } else if (msg.type === 'cluster_rejected') {
        if (this.leaseManager) {
          this.leaseManager.handleClusterRejected(msg);
        }
        // Broadcast error to connected SSE clients
        this.sseManager.broadcast('workflows' as SSEChannel, {
          event: 'error',
          id: `cluster-rejected-${Date.now()}`,
          data: {
            message: 'Active cluster limit reached for your plan.',
            reason: msg.reason,
            tier: msg.tier,
          },
          timestamp: new Date().toISOString(),
        } as SSEEvent);
      } else if (msg.type === 'tunnel_open') {
        if (this.tunnelHandler) {
          this.tunnelHandler.handleOpen(msg).catch((error) => {
            this.logger.error(
              { err: error instanceof Error ? error.message : String(error), tunnelId: msg.tunnelId },
              'Error handling tunnel open',
            );
          });
        }
      } else if (msg.type === 'tunnel_data') {
        if (this.tunnelHandler) {
          this.tunnelHandler.handleData(msg);
        }
      } else if (msg.type === 'tunnel_close') {
        if (this.tunnelHandler) {
          this.tunnelHandler.handleClose(msg);
        }
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
            event: channel,
            data: event as SSEEvent,
            timestamp: new Date().toISOString(),
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
      this.sendMetadata().catch((err) => {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Error in periodic metadata send',
        );
      });
    }, this.config.metadataIntervalMs);
  }

  private clearMetadataTimer(): void {
    if (this.metadataTimer) {
      clearInterval(this.metadataTimer);
      this.metadataTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Worker Event Subscription (Docker Engine /events)
  // ---------------------------------------------------------------------------

  private startWorkerEventSubscription(): void {
    if (this.workerEventSubscriptionSkipped) return;
    if (this.workerEventAbort) return; // already running

    const controller = new AbortController();
    this.workerEventAbort = controller;

    void this.runWorkerEventLoop(controller);
  }

  private async runWorkerEventLoop(controller: AbortController): Promise<void> {
    let project: string;
    try {
      project = await this.resolveProjectName();
    } catch (err) {
      if (err instanceof Error && err.message === 'ORCHESTRATOR_NOT_COMPOSE_MANAGED') {
        this.logger.info(
          'Orchestrator is not compose-managed; skipping worker event subscription',
        );
        this.workerEventSubscriptionSkipped = true;
        this.workerEventAbort = null;
        return;
      }
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to resolve compose project name; worker event subscription will retry on reconnect',
      );
      this.scheduleWorkerEventReconnect(controller);
      return;
    }

    while (!controller.signal.aborted) {
      const streamOpenedAt = Date.now();
      let receivedAny = false;
      try {
        const stream = this.engineClient.streamContainerEvents({
          filters: {
            label: [
              `com.docker.compose.project=${project}`,
              'com.docker.compose.service=worker',
            ],
            type: ['container'],
          },
          signal: controller.signal,
        });
        for await (const event of stream) {
          if (controller.signal.aborted) break;
          receivedAny = true;
          // Reset backoff once a stream is healthy.
          this.workerEventBackoffMs = WORKER_EVENT_BACKOFF_INITIAL_MS;
          if (event.Type === 'container' && WORKER_EVENT_ACTIONS.has(event.Action)) {
            this.sendMetadata().catch((sendErr) => {
              this.logger.warn(
                { err: sendErr instanceof Error ? sendErr.message : String(sendErr) },
                'Error sending event-triggered metadata refresh',
              );
            });
          }
        }
        if (controller.signal.aborted) break;
        // Stream closed cleanly (daemon restart etc.) — reconnect.
        this.logger.info('Docker Engine /events stream ended; reconnecting');
      } catch (err) {
        if (controller.signal.aborted) break;
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || err.message === 'aborted');
        if (isAbort) break;
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Docker Engine /events subscription error; will reconnect with backoff',
        );
      }

      if (controller.signal.aborted) break;

      // Reset backoff if the stream stayed open long enough or received any event.
      const streamLifetimeMs = Date.now() - streamOpenedAt;
      if (receivedAny || streamLifetimeMs >= WORKER_EVENT_RESET_BACKOFF_AFTER_MS) {
        this.workerEventBackoffMs = WORKER_EVENT_BACKOFF_INITIAL_MS;
      }

      const waited = await this.waitForBackoff(controller);
      if (!waited) break;
      this.workerEventBackoffMs = Math.min(
        this.workerEventBackoffMs * 2,
        WORKER_EVENT_BACKOFF_MAX_MS,
      );
    }

    this.workerEventAbort = null;
  }

  private waitForBackoff(controller: AbortController): Promise<boolean> {
    return new Promise<boolean>((resolveWait) => {
      if (controller.signal.aborted) {
        resolveWait(false);
        return;
      }
      this.clearWorkerEventReconnectTimer();
      const timer = setTimeout(() => {
        controller.signal.removeEventListener('abort', onAbort);
        this.workerEventReconnectTimer = null;
        resolveWait(true);
      }, this.workerEventBackoffMs);
      this.workerEventReconnectTimer = timer;
      const onAbort = (): void => {
        clearTimeout(timer);
        this.workerEventReconnectTimer = null;
        resolveWait(false);
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private scheduleWorkerEventReconnect(controller: AbortController): void {
    if (controller.signal.aborted) return;
    this.clearWorkerEventReconnectTimer();
    this.workerEventReconnectTimer = setTimeout(() => {
      this.workerEventReconnectTimer = null;
      void this.runWorkerEventLoop(controller);
    }, this.workerEventBackoffMs);
    this.workerEventBackoffMs = Math.min(
      this.workerEventBackoffMs * 2,
      WORKER_EVENT_BACKOFF_MAX_MS,
    );
  }

  private clearWorkerEventReconnectTimer(): void {
    if (this.workerEventReconnectTimer) {
      clearTimeout(this.workerEventReconnectTimer);
      this.workerEventReconnectTimer = null;
    }
  }

  async sendMetadata(): Promise<void> {
    try {
      const metadata = await this.collectMetadata();
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

  async collectMetadata(): Promise<ClusterMetadataPayload> {
    const [codeServerReady, controlPlaneReady] = await Promise.all([
      probeCodeServerSocket(),
      probeControlPlaneSocket(),
    ]);

    const metadata: ClusterMetadataPayload = {
      version: this.getVersion(),
      uptimeSeconds: process.uptime(),
      activeWorkflowCount: this.getActiveWorkflowCount(),
      gitRemotes: this.getGitRemotes(),
      reportedAt: new Date().toISOString(),
      codeServerReady,
      controlPlaneReady,
    };

    if (this.cluster?.displayName) {
      metadata.displayName = this.cluster.displayName;
    }
    if (this.cluster?.id) {
      metadata.clusterId = this.cluster.id;
    }

    // Read init-result.json for control-plane store status
    try {
      const raw = await readFile('/run/generacy-control-plane/init-result.json', 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.stores) {
        const stores: Record<string, 'ok' | 'fallback' | 'disabled'> = {};
        for (const [key, val] of Object.entries(parsed.stores)) {
          const v = val as { status?: string };
          if (v?.status === 'ok' || v?.status === 'fallback' || v?.status === 'disabled') {
            stores[key] = v.status;
          }
        }
        metadata.initResult = {
          stores,
          warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
        };
      }
    } catch {
      // init-result.json may not exist yet — graceful degradation
    }

    // Add merged cluster.yaml / cluster.local.yaml fields if available.
    // Only `channel` is still YAML-sourced; `workers` is enumerated below.
    const clusterData = await this.readClusterYaml();
    if (clusterData && clusterData.channel !== undefined) {
      metadata.channel = clusterData.channel;
    }

    // Workers: enumerate actual running containers from the Docker Engine API.
    // Omit on any failure (no fallback to YAML) per #714 clarification C4.
    try {
      const project = await this.resolveProjectName();
      const replicas = await enumerateWorkers(this.engineClient, project);
      metadata.workers = replicas.filter((r) => r.state === 'running').length;
    } catch (err) {
      if (!this.workerCountOmissionWarned) {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Worker enumeration failed; omitting workers field from relay metadata',
        );
        this.workerCountOmissionWarned = true;
      }
      // Field intentionally left undefined.
    }

    return metadata;
  }

  /**
   * Resolve and cache the compose project name. The value is stable for the
   * life of the orchestrator process, so we compute it once.
   */
  private async resolveProjectName(): Promise<string> {
    if (this.cachedProjectName) return this.cachedProjectName;
    const project = await computeProjectName(this.engineClient);
    this.cachedProjectName = project;
    return project;
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

  private async readClusterYaml(): Promise<{ workers?: number; channel?: 'preview' | 'stable' } | null> {
    try {
      const generacyDir = dirname(resolve(this.config.clusterYamlPath));
      const { merged } = await readMergedClusterConfig(generacyDir);

      return {
        workers: typeof merged.workers === 'number' ? merged.workers : undefined,
        channel: merged.channel === 'preview' || merged.channel === 'stable' ? merged.channel : undefined,
      };
    } catch {
      return null;
    }
  }
}
