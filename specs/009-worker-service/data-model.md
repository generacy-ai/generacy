# Data Model: Worker Service

## Core Entities

### WorkerProcessor

The main processor that handles job execution.

```typescript
interface WorkerProcessor {
  // Identity
  readonly workerId: string;

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // Processing
  processJob(job: Job): Promise<JobResult>;

  // Status
  isProcessing(): boolean;
  getCurrentJob(): Job | undefined;
  getStatus(): WorkerStatus;
  getMetrics(): WorkerMetrics;
  isHealthy(): boolean;
}

type WorkerStatus = 'idle' | 'processing' | 'draining' | 'stopped';
```

### Job Types

Extended from scheduler types with worker-specific payloads.

```typescript
// Base job from scheduler
interface Job {
  id: string;
  workflowId: string;
  stepId: string;
  type: JobType;
  status: JobStatus;
  priority: JobPriority;
  attempts: number;
  maxAttempts: number;
  payload: unknown;
  result?: unknown;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  visibilityTimeout: number;
  visibleAt?: number;
}

type JobType = 'agent' | 'human' | 'integration';
type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead';
type JobPriority = 'high' | 'normal' | 'low';
```

### Job Payloads

Type-specific payloads for each job type.

```typescript
// Agent job payload
interface AgentJobPayload {
  agent?: string;                      // Agent name (default: 'claude-code')
  command: string;                     // Command to execute
  context: {
    workingDirectory: string;
    environment?: Record<string, string>;
    mode?: string;
    issueNumber?: number;
    branch?: string;
  };
  timeout?: number;                    // Job-specific timeout
  container?: ContainerOverrides;      // Optional container config
}

// Human job payload
interface HumanJobPayload {
  type: 'approval' | 'decision' | 'input';
  title: string;
  description: string;
  options?: DecisionOption[];          // For decision type
  assignee?: string;
  urgency: 'low' | 'normal' | 'high' | 'critical';
  timeout: number;
  escalation?: EscalationConfig;
}

interface DecisionOption {
  id: string;
  label: string;
  description?: string;
}

interface EscalationConfig {
  timeoutAction: 'escalate' | 'fail';
  escalationChannels: string[];
  escalationDelay: number;
}

// Integration job payload
interface IntegrationJobPayload {
  integration: string;                 // Integration name
  action: string;                      // Action to perform
  params: Record<string, unknown>;     // Action parameters
  timeout?: number;
}
```

### Job Results

```typescript
interface JobResult {
  success: boolean;
  output: unknown;
  duration?: number;
  metadata?: Record<string, unknown>;
}

// Agent-specific result
interface AgentJobResult extends JobResult {
  output: string;
  exitCode?: number;
  toolCalls?: ToolCallRecord[];
  error?: {
    code: string;
    message: string;
  };
}

// Human-specific result
interface HumanJobResult extends JobResult {
  output: {
    decision?: string;                 // Selected option ID
    input?: string;                    // Free-form input
    approved?: boolean;                // For approval type
    respondedBy: string;               // Who responded
    respondedAt: string;               // When responded
  };
}

// Integration-specific result
interface IntegrationJobResult extends JobResult {
  output: unknown;                     // Integration-specific response
  statusCode?: number;                 // HTTP status if applicable
}
```

## Configuration Types

### WorkerConfig

```typescript
interface WorkerConfig {
  // Identity
  workerId?: string;                   // Auto-generated UUID if not provided

  // Processing
  concurrency: number;                 // Max concurrent jobs (default: 1)
  pollInterval: number;                // Queue poll interval ms (default: 1000)

  // Shutdown
  gracefulShutdownTimeout: number;     // Max wait for current job (default: 60000)
  forceShutdownOnTimeout: boolean;     // Force exit after timeout (default: true)

  // Health
  health: HealthConfig;

  // Heartbeat
  heartbeat: HeartbeatConfig;

  // Redis
  redis: RedisConfig;

  // Job handlers
  handlers: HandlersConfig;

  // Containers
  containers: ContainerConfig;
}

interface HealthConfig {
  enabled: boolean;
  port: number;                        // Default: 3001
}

interface HeartbeatConfig {
  enabled: boolean;
  interval: number;                    // Default: 5000ms
  ttl: number;                         // Default: 15000ms
}

interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
}
```

### Handler Configs

```typescript
interface HandlersConfig {
  agent: AgentHandlerConfig;
  human: HumanHandlerConfig;
  integration: IntegrationHandlerConfig;
}

interface AgentHandlerConfig {
  defaultTimeout: number;              // Default: 300000 (5 min)
  retry: AgentRetryConfig;
}

interface AgentRetryConfig {
  maxRetries: number;                  // Default: 3
  initialDelay: number;                // Default: 1000ms
  maxDelay: number;                    // Default: 30000ms
  backoffMultiplier: number;           // Default: 2
  retryableErrors: string[];           // Error codes to retry
}

interface HumanHandlerConfig {
  defaultTimeout: number;              // Default: 3600000 (1 hour)
  timeoutAction: 'escalate' | 'fail';  // Default: 'escalate'
  escalationDelay: number;             // Default: 300000 (5 min)
  defaultEscalationChannels: string[];
}

interface IntegrationHandlerConfig {
  defaultTimeout: number;              // Default: 30000
  retry: IntegrationRetryConfig;
}

interface IntegrationRetryConfig {
  maxRetries: number;                  // Default: 3
  retryDelay: number;                  // Default: 5000ms
  retryOn: number[];                   // HTTP status codes: [429, 502, 503, 504]
}
```

### Container Config

```typescript
interface ContainerConfig {
  enabled: boolean;                    // Default: false
  defaultImage: string;                // Default: 'generacy-ai/dev-container:latest'
  cleanupOnFailure: boolean;           // Default: true in prod
  cleanupOnSuccess: boolean;           // Default: true
  preserveForDebugging: boolean;       // Default: false
  cleanupTimeout: number;              // Default: 30000ms
  defaultVolumes: VolumeMount[];
  defaultEnvironment: Record<string, string>;
  networkMode?: string;
}

interface ContainerOverrides {
  image?: string;
  volumes?: VolumeMount[];
  environment?: Record<string, string>;
  cleanupOnFailure?: boolean;
}

interface VolumeMount {
  source: string;
  target: string;
  readonly?: boolean;
}
```

## Health & Metrics Types

### Health Response

```typescript
interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;                      // Seconds since start
  currentJobs: number;
  lastJobCompleted: string | null;     // ISO timestamp
  version: string;
  details?: {
    redis: 'connected' | 'disconnected';
    queueDepth?: number;
  };
}

// Liveness probe - just returns 200 if process is running
// Readiness probe - checks Redis connectivity
```

### Worker Heartbeat

```typescript
interface WorkerHeartbeat {
  workerId: string;
  timestamp: number;                   // Unix timestamp ms
  status: WorkerStatus;
  currentJob?: string;                 // Job ID if processing
  metrics: WorkerMetrics;
}

interface WorkerMetrics {
  jobsProcessed: number;               // Total since start
  jobsSucceeded: number;
  jobsFailed: number;
  errorRate: number;                   // Failed / processed
  avgProcessingTime: number;           // ms
  lastProcessingTime?: number;         // ms
}
```

## Event Types

```typescript
// Events emitted by WorkerProcessor
type WorkerEvent =
  | { type: 'started'; workerId: string }
  | { type: 'stopped'; workerId: string }
  | { type: 'job:started'; job: Job }
  | { type: 'job:completed'; job: Job; result: JobResult }
  | { type: 'job:failed'; job: Job; error: Error }
  | { type: 'job:retrying'; job: Job; attempt: number; delay: number }
  | { type: 'metrics:snapshot'; metrics: WorkerMetrics }
  | { type: 'shutdown:initiated' }
  | { type: 'shutdown:timeout'; job?: Job };
```

## Validation Rules

### Job Payload Validation

```typescript
// Agent job validation
const agentJobSchema = {
  command: { required: true, type: 'string', minLength: 1 },
  context: {
    required: true,
    type: 'object',
    properties: {
      workingDirectory: { required: true, type: 'string' }
    }
  },
  timeout: { type: 'number', min: 1000, max: 3600000 }
};

// Human job validation
const humanJobSchema = {
  type: { required: true, enum: ['approval', 'decision', 'input'] },
  title: { required: true, type: 'string', minLength: 1, maxLength: 200 },
  description: { required: true, type: 'string', maxLength: 5000 },
  urgency: { required: true, enum: ['low', 'normal', 'high', 'critical'] },
  timeout: { required: true, type: 'number', min: 1000 }
};

// Integration job validation
const integrationJobSchema = {
  integration: { required: true, type: 'string', minLength: 1 },
  action: { required: true, type: 'string', minLength: 1 },
  params: { type: 'object' }
};
```

### Configuration Validation

```typescript
const configValidation = {
  concurrency: { min: 1, max: 10 },
  pollInterval: { min: 100, max: 60000 },
  gracefulShutdownTimeout: { min: 1000, max: 300000 },
  'health.port': { min: 1024, max: 65535 },
  'heartbeat.interval': { min: 1000, max: 60000 },
  'heartbeat.ttl': { min: 5000, max: 300000 }
};
```

## Entity Relationships

```
WorkerProcessor
    │
    ├── has one ──► WorkerConfig
    │
    ├── processes many ──► Job
    │       │
    │       ├── type: 'agent' ──► AgentJobPayload ──► AgentJobResult
    │       ├── type: 'human' ──► HumanJobPayload ──► HumanJobResult
    │       └── type: 'integration' ──► IntegrationJobPayload ──► IntegrationJobResult
    │
    ├── uses ──► JobScheduler (external)
    ├── uses ──► AgentRegistry (external)
    ├── uses ──► MessageRouter (external)
    │
    ├── has one ──► HealthServer
    │       └── returns ──► HealthResponse
    │
    └── has one ──► Heartbeat
            └── publishes ──► WorkerHeartbeat
```

---

*Generated by speckit*
