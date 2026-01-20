# Data Model: Orchestrator Service

## Core Entities

### API Request/Response Types

```typescript
// Workflow API Types
interface CreateWorkflowRequest {
  definitionId?: string;        // Reference to stored definition
  definition?: WorkflowDefinition; // Or inline definition
  context: Record<string, unknown>;
  metadata?: {
    name?: string;
    tags?: string[];
  };
}

interface WorkflowResponse {
  id: string;
  status: WorkflowStatus;
  currentStep: string | null;
  context: Record<string, unknown>;
  metadata: {
    name?: string;
    tags?: string[];
  };
  createdAt: string;           // ISO 8601
  updatedAt: string;
  completedAt?: string;
}

interface WorkflowListResponse {
  workflows: WorkflowResponse[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
  };
}

type WorkflowStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';
```

### Decision Queue Types

```typescript
interface DecisionQueueItem {
  id: string;
  workflowId: string;
  stepId: string;
  type: DecisionType;
  prompt: string;
  options?: DecisionOption[];
  context: Record<string, unknown>;
  priority: DecisionPriority;
  createdAt: string;
  expiresAt?: string;
}

type DecisionType =
  | 'approval'           // Yes/No approval
  | 'choice'             // Select from options
  | 'input'              // Free-form input
  | 'review';            // Code/artifact review

interface DecisionOption {
  id: string;
  label: string;
  description?: string;
}

type DecisionPriority =
  | 'blocking_now'       // Agent waiting synchronously
  | 'blocking_soon'      // Will block shortly
  | 'when_available';    // Non-urgent

interface DecisionResponse {
  id: string;
  response: string | boolean | string[];
  comment?: string;
  respondedBy: string;
  respondedAt: string;
}
```

### Agent Types

```typescript
interface ConnectedAgent {
  id: string;
  name: string;
  type: AgentType;
  status: AgentConnectionStatus;
  capabilities: string[];
  lastSeen: string;
  metadata: {
    version?: string;
    platform?: string;
    workflowId?: string;
  };
}

type AgentType =
  | 'claude'
  | 'gpt4'
  | 'custom';

type AgentConnectionStatus =
  | 'connected'
  | 'idle'
  | 'busy'
  | 'disconnected';
```

### Integration Types

```typescript
interface IntegrationStatus {
  integrations: Integration[];
}

interface Integration {
  id: string;
  name: string;
  type: IntegrationType;
  status: 'connected' | 'disconnected' | 'error';
  lastSync?: string;
  config: {
    enabled: boolean;
    autoSync?: boolean;
  };
  error?: string;
}

type IntegrationType =
  | 'github'
  | 'gitlab'
  | 'jira'
  | 'slack'
  | 'linear';
```

## Authentication Types

```typescript
interface ApiKeyCredential {
  key: string;              // Hashed, never stored plain
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  scopes: ApiScope[];
  rateLimit?: {
    max: number;
    timeWindow: string;
  };
}

type ApiScope =
  | 'workflows:read'
  | 'workflows:write'
  | 'queue:read'
  | 'queue:write'
  | 'agents:read'
  | 'admin';

interface JWTPayload {
  sub: string;              // User ID
  name: string;
  email: string;
  provider: 'github';
  scopes: ApiScope[];
  iat: number;
  exp: number;
}

interface GitHubUser {
  id: number;
  login: string;
  name: string;
  email: string;
  avatar_url: string;
}
```

## WebSocket Message Types

```typescript
// Client → Server
type ClientMessage =
  | SubscribeMessage
  | UnsubscribeMessage
  | PingMessage;

interface SubscribeMessage {
  type: 'subscribe';
  channels: Channel[];
  filters?: {
    workflowId?: string;
    tags?: string[];
  };
}

interface UnsubscribeMessage {
  type: 'unsubscribe';
  channels: Channel[];
}

interface PingMessage {
  type: 'ping';
}

type Channel = 'workflows' | 'queue' | 'agents';

// Server → Client
type ServerMessage =
  | WorkflowEventMessage
  | QueueUpdateMessage
  | AgentStatusMessage
  | PongMessage
  | ErrorMessage;

interface WorkflowEventMessage {
  type: 'workflow_event';
  payload: {
    event: WorkflowEventType;
    workflowId: string;
    stepId?: string;
    data: Record<string, unknown>;
    timestamp: string;
  };
}

type WorkflowEventType =
  | 'workflow:started'
  | 'workflow:completed'
  | 'workflow:failed'
  | 'workflow:paused'
  | 'workflow:resumed'
  | 'workflow:cancelled'
  | 'step:started'
  | 'step:completed'
  | 'step:failed'
  | 'decision:requested'
  | 'decision:resolved';

interface QueueUpdateMessage {
  type: 'queue_update';
  payload: DecisionQueueItem[];
}

interface AgentStatusMessage {
  type: 'agent_status';
  payload: ConnectedAgent;
}

interface PongMessage {
  type: 'pong';
  timestamp: string;
}

interface ErrorMessage {
  type: 'error';
  payload: ProblemDetails;
}
```

## Error Types (RFC 7807)

```typescript
interface ProblemDetails {
  type: string;       // URI reference: urn:generacy:error:*
  title: string;      // Short summary
  status: number;     // HTTP status code
  detail?: string;    // Explanation for this occurrence
  instance?: string;  // URI to this specific error
  // Extensions
  code?: string;      // Machine-readable error code
  errors?: ValidationError[];
  traceId?: string;
}

interface ValidationError {
  field: string;
  message: string;
  code: string;
}

// Error Type URIs
const ErrorTypes = {
  VALIDATION_ERROR: 'urn:generacy:error:validation',
  NOT_FOUND: 'urn:generacy:error:not-found',
  UNAUTHORIZED: 'urn:generacy:error:unauthorized',
  FORBIDDEN: 'urn:generacy:error:forbidden',
  RATE_LIMITED: 'urn:generacy:error:rate-limited',
  CONFLICT: 'urn:generacy:error:conflict',
  INTERNAL: 'urn:generacy:error:internal',
} as const;
```

## Configuration Types

```typescript
interface OrchestratorConfig {
  server: {
    port: number;
    host: string;
  };
  redis: {
    url: string;
  };
  auth: {
    enabled: boolean;
    providers: ('apiKey' | 'github-oauth2')[];
    github?: {
      clientId: string;
      clientSecret: string;
      callbackUrl: string;
    };
    jwt: {
      secret: string;
      expiresIn: string;
    };
  };
  rateLimit: {
    enabled: boolean;
    max: number;
    timeWindow: string;
  };
  cors: {
    origin: boolean | string | string[];
    credentials: boolean;
  };
  logging: {
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
    pretty: boolean;
  };
}
```

## Zod Schemas

```typescript
import { z } from 'zod';

// Request Schemas
export const CreateWorkflowSchema = z.object({
  definitionId: z.string().uuid().optional(),
  definition: z.any().optional(), // WorkflowDefinition validated separately
  context: z.record(z.unknown()),
  metadata: z.object({
    name: z.string().max(255).optional(),
    tags: z.array(z.string().max(50)).max(10).optional(),
  }).optional(),
}).refine(
  data => data.definitionId || data.definition,
  { message: 'Either definitionId or definition must be provided' }
);

export const WorkflowIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const ListWorkflowsQuerySchema = z.object({
  status: z.enum(['created', 'running', 'paused', 'completed', 'cancelled', 'failed']).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const DecisionResponseSchema = z.object({
  response: z.union([z.string(), z.boolean(), z.array(z.string())]),
  comment: z.string().max(1000).optional(),
});

// WebSocket Message Schemas
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    channels: z.array(z.enum(['workflows', 'queue', 'agents'])).min(1),
    filters: z.object({
      workflowId: z.string().uuid().optional(),
      tags: z.array(z.string()).optional(),
    }).optional(),
  }),
  z.object({
    type: z.literal('unsubscribe'),
    channels: z.array(z.enum(['workflows', 'queue', 'agents'])).min(1),
  }),
  z.object({
    type: z.literal('ping'),
  }),
]);
```

## Relationships

```
┌─────────────────┐
│    Workflow     │
│                 │
│  id             │
│  status         │
│  currentStep    │
└────────┬────────┘
         │ 1:N
         ▼
┌─────────────────┐        ┌─────────────────┐
│ DecisionQueue   │        │  ConnectedAgent │
│ Item            │        │                 │
│                 │        │  id             │
│  workflowId ────┼───────▶│  workflowId     │
│  stepId         │        │  status         │
│  priority       │        │                 │
└─────────────────┘        └─────────────────┘

┌─────────────────┐
│  ApiKeyCredential│
│                 │
│  key (hashed)   │───────▶ Rate limit bucket
│  scopes         │
│  rateLimit      │
└─────────────────┘
```

---

*Generated by speckit*
