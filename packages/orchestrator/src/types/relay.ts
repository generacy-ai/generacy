/**
 * Relay client interface contract and message types.
 *
 * Defines the interface that @generacy-ai/cluster-relay (Phase 2.1)
 * must implement for the orchestrator relay integration (Phase 2.2).
 */

import type { SSESubscriptionManager } from '../sse/subscriptions.js';
import type { FastifyInstance } from 'fastify';
import type { EventMessage } from '@generacy-ai/cluster-relay';
import type {
  RelayLeaseRequest,
  RelayLeaseGranted,
  RelayLeaseDenied,
  RelayLeaseRelease,
  RelayLeaseHeartbeat,
  RelaySlotAvailable,
  RelayTierInfo,
  RelayClusterRejected,
} from './lease.js';

// =============================================================================
// Relay Client Interface
// =============================================================================

/**
 * Interface for the cluster relay client.
 * Maintains a persistent WebSocket connection to the cloud relay service.
 *
 * Lifecycle:
 * 1. Create instance with options (API key, cloud URL)
 * 2. Call connect() — establishes WebSocket, authenticates with API key
 * 3. Register message/event handlers via on()
 * 4. Send messages via send()
 * 5. Call disconnect() for graceful shutdown
 *
 * The client handles reconnection internally (exponential backoff 5s→300s).
 */
export interface ClusterRelayClient {
  /** Connect to the cloud relay service. Resolves when handshake completes. */
  connect(): Promise<void>;

  /** Disconnect from the cloud relay service. */
  disconnect(): Promise<void>;

  /** Send a typed message through the relay. */
  send(message: RelayMessage): void;

  /** Register an event handler. */
  on(event: 'message', handler: (msg: RelayMessage) => void): void;
  on(event: 'connected', handler: () => void): void;
  on(event: 'disconnected', handler: (reason: string) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;

  /** Remove an event handler. */
  off(event: string, handler: (...args: unknown[]) => void): void;

  /** Whether the client is currently connected to the cloud. */
  readonly isConnected: boolean;
}

/**
 * Path-prefix route entry for dispatching relay-proxied requests to a
 * unix-socket or HTTP target.
 */
export interface RouteEntry {
  prefix: string;
  target: string;
}

/**
 * Options for creating a ClusterRelayClient instance.
 */
export interface ClusterRelayClientOptions {
  /** API key for cloud authentication (from GENERACY_API_KEY) */
  apiKey: string;

  /** Cloud relay WebSocket URL (default: 'wss://api.generacy.ai/relay') */
  cloudUrl?: string;

  /** Base reconnect delay in ms (default: 5000). Backoff: 5s→10s→20s→...→300s. */
  baseReconnectDelayMs?: number;

  /** URL of the local orchestrator API (default: http://localhost:3000) */
  orchestratorUrl?: string;

  /** API key for authenticating relay-proxied requests to the orchestrator */
  orchestratorApiKey?: string;

  /** Path-prefix routes for dispatching relay-proxied requests to unix sockets or HTTP targets */
  routes?: RouteEntry[];
}

// =============================================================================
// Relay Message Types
// =============================================================================

/**
 * Conversation message from cloud to cluster (user input).
 */
export interface RelayConversationInput {
  type: 'conversation';
  conversationId: string;
  data: {
    action: 'message';
    content: string;
  };
}

/**
 * Conversation message from cluster to cloud (CLI output).
 */
export interface RelayConversationOutput {
  type: 'conversation';
  conversationId: string;
  data: {
    event: 'output' | 'tool_use' | 'tool_result' | 'complete' | 'error';
    payload: unknown;
    timestamp: string;
  };
}


/**
 * Discriminated union of all relay message types.
 */
export interface RelayTunnelOpen {
  type: 'tunnel_open';
  tunnelId: string;
  target: string;
}

export interface RelayTunnelOpenAck {
  type: 'tunnel_open_ack';
  tunnelId: string;
  status: 'ok' | 'error';
  error?: string;
}

export interface RelayTunnelData {
  type: 'tunnel_data';
  tunnelId: string;
  data: string;
}

export interface RelayTunnelClose {
  type: 'tunnel_close';
  tunnelId: string;
  reason?: string;
}

export type RelayMessage =
  | RelayApiRequest
  | RelayApiResponse
  | EventMessage
  | RelayMetadata
  | RelayConversationInput
  | RelayConversationOutput
  | RelayLeaseRequest
  | RelayLeaseGranted
  | RelayLeaseDenied
  | RelayLeaseRelease
  | RelayLeaseHeartbeat
  | RelaySlotAvailable
  | RelayTierInfo
  | RelayClusterRejected
  | RelayTunnelOpen
  | RelayTunnelOpenAck
  | RelayTunnelData
  | RelayTunnelClose;

// Re-export lease protocol types
export type {
  RelayLeaseRequest,
  RelayLeaseGranted,
  RelayLeaseDenied,
  RelayLeaseRelease,
  RelayLeaseHeartbeat,
  RelaySlotAvailable,
  RelayTierInfo,
  RelayClusterRejected,
} from './lease.js';

/**
 * API request forwarded from cloud to cluster.
 * The orchestrator processes this via Fastify inject() and returns an api_response.
 */
export interface RelayApiRequest {
  type: 'api_request';
  /** Unique request ID for response correlation */
  id: string;
  /** HTTP method (GET, POST, PUT, DELETE, PATCH) */
  method: string;
  /** Request URL path (e.g., '/workflows', '/queue/items') */
  url: string;
  /** Optional request headers */
  headers?: Record<string, string>;
  /** Optional request body (JSON-serializable) */
  body?: unknown;
}

/**
 * API response sent from cluster back to cloud.
 */
export interface RelayApiResponse {
  type: 'api_response';
  /** Correlation ID matching the original api_request.id */
  id: string;
  /** HTTP status code */
  statusCode: number;
  /** Response headers */
  headers: Record<string, string>;
  /** Response body */
  body: unknown;
}


/**
 * Cluster metadata report sent on connect and periodically.
 */
export interface RelayMetadata {
  type: 'metadata';
  /** Metadata payload */
  data: ClusterMetadataPayload;
}

// =============================================================================
// Metadata Types
// =============================================================================

/**
 * Cluster metadata payload.
 * Fields sourced from cluster.yaml are optional — omitted when file is missing.
 */
export interface ClusterMetadataPayload {
  /** Orchestrator package version */
  version: string;

  /** Process uptime in seconds */
  uptimeSeconds: number;

  /** Number of currently active workflows */
  activeWorkflowCount: number;

  /** Git remote URLs from workspace repos */
  gitRemotes: GitRemoteInfo[];

  /** Worker count from cluster.yaml (omitted if file missing) */
  workerCount?: number;

  /** Release channel from cluster.yaml (omitted if file missing) */
  channel?: 'preview' | 'stable';

  /** ISO 8601 timestamp of this report */
  reportedAt: string;

  /** Whether code-server is running and ready for connections */
  codeServerReady?: boolean;

  /** Whether the control-plane Unix socket is accepting connections */
  controlPlaneReady?: boolean;

  /** Init results from the control-plane daemon (read from init-result.json) */
  initResult?: {
    stores: Record<string, 'ok' | 'fallback' | 'disabled'>;
    warnings: string[];
  };
}

/**
 * Git remote information.
 */
export interface GitRemoteInfo {
  /** Remote name (e.g., 'origin') */
  name: string;
  /** Remote URL */
  url: string;
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Relay configuration.
 */
export interface RelayConfig {
  /** API key for cloud authentication (from GENERACY_API_KEY env var) */
  apiKey?: string;

  /** Cloud relay WebSocket URL */
  cloudUrl: string;

  /** Interval for periodic metadata refresh in ms */
  metadataIntervalMs: number;

  /** Path to cluster.yaml relative to workspace root */
  clusterYamlPath: string;
}

// =============================================================================
// Bridge Types
// =============================================================================

interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Options for creating a RelayBridge instance.
 */
export interface RelayBridgeOptions {
  /** The relay client instance */
  client: ClusterRelayClient;

  /** The Fastify server instance (for inject()) */
  server: FastifyInstance;

  /** SSE subscription manager (for event forwarding) */
  sseManager: SSESubscriptionManager;

  /** Logger instance */
  logger: Logger;

  /** Relay configuration */
  config: RelayConfig;
}
