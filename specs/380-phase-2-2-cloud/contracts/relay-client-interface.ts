/**
 * Relay Client Interface Contract
 *
 * This file defines the interface that @generacy-ai/cluster-relay (Phase 2.1)
 * must implement for the orchestrator relay integration (Phase 2.2).
 *
 * NOTE: This is a contract definition, not executable code. It will be
 * replaced by the actual import from @generacy-ai/cluster-relay once
 * Phase 2.1 is implemented.
 */

import type { SSEChannel, SSEEvent } from '../packages/orchestrator/src/types/sse.js';

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
 * Options for creating a ClusterRelayClient instance.
 */
export interface ClusterRelayClientOptions {
  /** API key for cloud authentication (from GENERACY_API_KEY) */
  apiKey: string;

  /** Cloud relay WebSocket URL (default: 'wss://api.generacy.ai/relay') */
  cloudUrl?: string;

  /** Base reconnect delay in ms (default: 5000). Backoff: 5s→10s→20s→...→300s. */
  baseReconnectDelayMs?: number;
}

// =============================================================================
// Relay Message Types
// =============================================================================

/**
 * Discriminated union of all relay message types.
 */
export type RelayMessage =
  | RelayApiRequest
  | RelayApiResponse
  | RelayEvent
  | RelayMetadata;

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
 * SSE event forwarded from cluster to cloud subscribers.
 */
export interface RelayEvent {
  type: 'event';
  /** SSE channel the event belongs to */
  channel: SSEChannel;
  /** The SSE event payload */
  event: SSEEvent;
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
