# Data Model: Orchestrator Relay Integration

## Core Entities

### ClusterRelayClient (Interface Contract)

The interface that Phase 2.1 (`@generacy-ai/cluster-relay`) must implement:

```typescript
/**
 * Relay client interface for orchestrator integration.
 * Implemented by @generacy-ai/cluster-relay package (Phase 2.1).
 */
export interface ClusterRelayClient {
  /** Connect to the cloud relay service */
  connect(): Promise<void>;

  /** Disconnect from the cloud relay service */
  disconnect(): Promise<void>;

  /** Send a message through the relay */
  send(message: RelayMessage): void;

  /** Register event handler */
  on(event: 'message', handler: (msg: RelayMessage) => void): void;
  on(event: 'connected', handler: () => void): void;
  on(event: 'disconnected', handler: (reason: string) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;

  /** Remove event handler */
  off(event: string, handler: (...args: unknown[]) => void): void;

  /** Whether the client is currently connected */
  readonly isConnected: boolean;
}

/**
 * Options for creating a relay client instance
 */
export interface ClusterRelayClientOptions {
  /** API key for authentication */
  apiKey: string;

  /** Cloud relay WebSocket URL */
  cloudUrl: string;

  /** Base reconnect delay in ms (default: 5000) */
  baseReconnectDelayMs?: number;
}
```

### Relay Message Types

```typescript
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
 * The orchestrator should process this via Fastify inject().
 */
export interface RelayApiRequest {
  type: 'api_request';
  /** Unique request ID for correlation */
  id: string;
  /** HTTP method */
  method: string;
  /** Request URL path (e.g., '/workflows', '/queue') */
  url: string;
  /** Request headers */
  headers?: Record<string, string>;
  /** Request body (JSON-serializable) */
  body?: unknown;
}

/**
 * API response sent from cluster back to cloud.
 */
export interface RelayApiResponse {
  type: 'api_response';
  /** Correlation ID matching the original api_request */
  id: string;
  /** HTTP status code */
  statusCode: number;
  /** Response headers */
  headers: Record<string, string>;
  /** Response body */
  body: unknown;
}

/**
 * SSE event forwarded from cluster to cloud.
 */
export interface RelayEvent {
  type: 'event';
  /** SSE channel (workflows, queue, agents) */
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
```

### Cluster Metadata

```typescript
/**
 * Cluster metadata reported to the cloud.
 * Fields sourced from cluster.yaml are optional (file may not exist).
 */
export interface ClusterMetadataPayload {
  /** Orchestrator package version */
  version: string;

  /** Process uptime in seconds */
  uptimeSeconds: number;

  /** Number of active workflows */
  activeWorkflowCount: number;

  /** Git remote URLs from workspace repos */
  gitRemotes: GitRemoteInfo[];

  /** Worker count from cluster.yaml (omitted if file missing) */
  workerCount?: number;

  /** Release channel from cluster.yaml (omitted if file missing) */
  channel?: 'preview' | 'stable';

  /** Timestamp of this metadata report */
  reportedAt: string;
}

/**
 * Git remote information
 */
export interface GitRemoteInfo {
  /** Remote name (e.g., 'origin') */
  name: string;
  /** Remote URL */
  url: string;
}
```

### Relay Configuration

```typescript
/**
 * Relay configuration added to OrchestratorConfig
 */
export interface RelayConfig {
  /** API key for cloud authentication (from GENERACY_API_KEY env var) */
  apiKey?: string;

  /** Cloud relay WebSocket URL */
  cloudUrl: string; // default: 'wss://api.generacy.ai/relay'

  /** Interval for periodic metadata refresh in ms */
  metadataIntervalMs: number; // default: 60000

  /** Path to cluster.yaml relative to workspace root */
  clusterYamlPath: string; // default: '.generacy/cluster.yaml'
}
```

### RelayBridge

```typescript
/**
 * Bridge between the orchestrator and the relay client.
 * Handles API routing, event forwarding, and metadata reporting.
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
```

## Validation Rules

| Field | Rule |
|-------|------|
| `RelayConfig.apiKey` | Optional; relay disabled if not set |
| `RelayConfig.cloudUrl` | Valid URL, must start with `wss://` or `ws://` |
| `RelayConfig.metadataIntervalMs` | Minimum 10000ms, default 60000ms |
| `RelayConfig.clusterYamlPath` | Non-empty string, default `.generacy/cluster.yaml` |
| `RelayApiRequest.id` | Non-empty string, used for response correlation |
| `RelayApiRequest.method` | Valid HTTP method (GET, POST, PUT, DELETE, PATCH) |
| `RelayApiRequest.url` | Must start with `/` |

## Relationships

```
OrchestratorConfig
  └── relay: RelayConfig
        └── apiKey → enables relay connection

RelayBridge
  ├── uses ClusterRelayClient (from @generacy-ai/cluster-relay)
  ├── uses FastifyInstance.inject() (for API routing)
  ├── uses SSESubscriptionManager (for event forwarding)
  └── produces ClusterMetadataPayload (from multiple sources)

ClusterRelayClient ─── sends/receives ──→ RelayMessage
  ├── RelayApiRequest  (cloud → cluster)
  ├── RelayApiResponse (cluster → cloud)
  ├── RelayEvent       (cluster → cloud)
  └── RelayMetadata    (cluster → cloud)
```

## Zod Schemas

```typescript
export const RelayConfigSchema = z.object({
  apiKey: z.string().min(1).optional(),
  cloudUrl: z.string().url().default('wss://api.generacy.ai/relay'),
  metadataIntervalMs: z.number().int().min(10000).default(60000),
  clusterYamlPath: z.string().min(1).default('.generacy/cluster.yaml'),
});
```
