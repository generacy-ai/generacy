# Data Model: @generacy-ai/cluster-relay

## Core Message Types

### RelayMessage (Discriminated Union)

The single message type sent over the WebSocket connection. Discriminated on the `type` field.

```typescript
type RelayMessage =
  | ApiRequestMessage
  | ApiResponseMessage
  | EventMessage
  | ConversationMessage
  | HeartbeatMessage
  | HandshakeMessage
  | ErrorMessage;
```

### ApiRequestMessage

Sent by cloud to relay. Proxied to local orchestrator.

```typescript
interface ApiRequestMessage {
  type: 'api_request';
  id: string;            // Correlation ID for matching response
  method: string;        // HTTP method (GET, POST, PUT, DELETE, PATCH)
  path: string;          // Orchestrator API path (e.g., '/workflows')
  headers?: Record<string, string>;
  body?: unknown;
}
```

### ApiResponseMessage

Sent by relay to cloud. Response from local orchestrator.

```typescript
interface ApiResponseMessage {
  type: 'api_response';
  id: string;            // Matches the api_request id
  status: number;        // HTTP status code
  headers?: Record<string, string>;
  body?: unknown;
}
```

### EventMessage

Sent by relay to cloud. Forwarded from local orchestrator SSE streams.

```typescript
interface EventMessage {
  type: 'event';
  channel: string;       // 'workflows' | 'queue' | 'agents' | string
  event: unknown;        // SSE event data (matches orchestrator SSEEvent format)
}
```

### ConversationMessage

Bidirectional. Phase 4 feature — type defined for forward compatibility only.

```typescript
interface ConversationMessage {
  type: 'conversation';
  conversationId: string;
  data: unknown;         // Conversation payload (stdin/stdout streams, defined in Phase 4)
}
```

### HeartbeatMessage

Bidirectional. Keep-alive signal.

```typescript
interface HeartbeatMessage {
  type: 'heartbeat';
}
```

### HandshakeMessage

Sent by relay to cloud on connection. Contains cluster metadata.

```typescript
interface HandshakeMessage {
  type: 'handshake';
  metadata: ClusterMetadata;
}
```

### ErrorMessage

Sent by cloud to relay on protocol errors.

```typescript
interface ErrorMessage {
  type: 'error';
  code: string;          // Machine-readable error code
  message: string;       // Human-readable description
}
```

## ClusterMetadata

Collected on connection and sent with handshake.

```typescript
interface ClusterMetadata {
  workerCount: number;          // Active worker processes
  activeWorkflows: number;      // Currently running workflows
  channel: 'preview' | 'stable';
  orchestratorVersion: string;  // Semver from orchestrator /health
  gitRemotes: GitRemote[];      // Project git remotes
  uptime: number;               // Orchestrator uptime in seconds
}

interface GitRemote {
  name: string;   // e.g., 'origin'
  url: string;    // e.g., 'git@github.com:org/repo.git'
}
```

## Configuration

```typescript
interface RelayConfig {
  apiKey: string;                   // GENERACY_API_KEY — cloud auth
  relayUrl: string;                 // Default: 'wss://api.generacy.ai/relay'
  orchestratorUrl: string;          // Default: 'http://localhost:3000'
  orchestratorApiKey?: string;      // ORCHESTRATOR_API_KEY — local auth (standalone mode)
  requestTimeoutMs: number;         // Default: 30000
  heartbeatIntervalMs: number;      // Default: 30000
  baseReconnectDelayMs: number;     // Default: 5000
  maxReconnectDelayMs: number;      // Default: 300000
}
```

### Zod Schema

```typescript
const RelayConfigSchema = z.object({
  apiKey: z.string().min(1, 'GENERACY_API_KEY is required'),
  relayUrl: z.string().url().default('wss://api.generacy.ai/relay'),
  orchestratorUrl: z.string().url().default('http://localhost:3000'),
  orchestratorApiKey: z.string().optional(),
  requestTimeoutMs: z.number().positive().default(30000),
  heartbeatIntervalMs: z.number().positive().default(30000),
  baseReconnectDelayMs: z.number().positive().default(5000),
  maxReconnectDelayMs: z.number().positive().default(300000),
});
```

## Relay State

```typescript
type RelayState = 'disconnected' | 'connecting' | 'authenticating' | 'connected' | 'disconnecting';
```

## ClusterRelay Class Interface

```typescript
class ClusterRelay {
  constructor(config: Partial<RelayConfig> & { apiKey: string }, logger?: Logger);

  readonly state: RelayState;

  /** Establish WebSocket connection, authenticate, send handshake */
  connect(): Promise<void>;

  /** Graceful disconnect with close frame */
  disconnect(): Promise<void>;

  /** Register handler for incoming messages */
  onMessage(handler: (message: RelayMessage) => void): void;

  /** Push event to cloud (library mode — called by orchestrator) */
  pushEvent(channel: string, event: unknown): void;

  /** Override metadata (library mode — orchestrator provides live data) */
  setMetadata(metadata: Partial<ClusterMetadata>): void;
}
```

## Validation Rules

- `apiKey` must be non-empty string
- `relayUrl` must be valid URL with `wss://` or `ws://` scheme
- `orchestratorUrl` must be valid URL with `http://` or `https://` scheme
- `id` fields on request/response messages must be non-empty strings
- `method` on api_request must be valid HTTP method
- `status` on api_response must be valid HTTP status code (100-599)
- `channel` on ClusterMetadata must be `'preview'` or `'stable'`
- Incoming messages must parse as valid `RelayMessage` (unknown types are logged and skipped)

## Relationships

```
ClusterRelay ──uses──→ RelayConfig (validated by Zod)
ClusterRelay ──sends──→ HandshakeMessage (contains ClusterMetadata)
ClusterRelay ──receives──→ ApiRequestMessage ──proxied to──→ Orchestrator HTTP API
ClusterRelay ──sends──→ ApiResponseMessage (correlated by id)
ClusterRelay ──sends──→ EventMessage (via pushEvent or SSE subscription)
Orchestrator (issue 2.2) ──imports──→ ClusterRelay (library mode)
Cloud Relay Service (issue 2.3) ──connects to──→ ClusterRelay (WebSocket)
```

---

*Generated by speckit*
