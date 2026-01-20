# Feature Specification: Worker service

**Branch**: `009-worker-service` | **Date**: 2026-01-19 | **Status**: In Progress

## Summary

Implement the worker service that processes jobs and invokes agents.

## Parent Epic

#7 - Generacy Services

## Dependencies

- #2 - Generacy Core Package
- #4 - Agent invocation abstraction
- #6 - Job scheduler

## Requirements

### Job Processor

```typescript
class WorkerProcessor {
  constructor(config: WorkerConfig);
  
  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;
  
  // Processing
  processJob(job: Job): Promise<JobResult>;
  
  // Status
  isProcessing(): boolean;
  getCurrentJob(): Job | undefined;
}
```

### Job Type Handlers

```typescript
// Agent job - invoke an AI agent
async function handleAgentJob(job: AgentJob): Promise<JobResult> {
  const agent = registry.get(job.agent || 'claude-code');
  const result = await agent.invoke({
    command: job.command,
    context: job.context,
    timeout: job.timeout
  });
  return { success: result.success, output: result.output };
}

// Human job - wait for human decision
async function handleHumanJob(job: HumanJob): Promise<JobResult> {
  const request = createDecisionRequest(job);
  await router.routeToHumancy(request);
  const response = await waitForResponse(request.id, job.timeout);
  return { success: true, output: response };
}

// Integration job - call external service
async function handleIntegrationJob(job: IntegrationJob): Promise<JobResult> {
  const plugin = integrations.get(job.integration);
  return plugin.execute(job.action, job.params);
}
```

### Container Management

For agent jobs, optionally run in isolated containers:

```typescript
interface ContainerConfig {
  image: string;                   // Dev container image
  volumes: VolumeMount[];          // Source code mount
  environment: Record<string, string>;
  network?: string;
}

async function runInContainer(
  config: ContainerConfig,
  command: string
): Promise<ContainerResult> {
  // Create container
  // Mount volumes
  // Run command
  // Capture output
  // Cleanup container
}
```

### Retry Policy (Job-Type Specific)

Different job types have different retry strategies based on their failure modes:

**Agent Jobs**: Exponential backoff for transient failures
```typescript
interface AgentRetryConfig {
  maxRetries: number;           // Default: 3
  initialDelay: number;         // Default: 1000ms
  maxDelay: number;             // Default: 30000ms
  backoffMultiplier: number;    // Default: 2
  retryableErrors: string[];    // e.g., ['RATE_LIMIT', 'NETWORK_ERROR']
}
```

**Human Jobs**: No automatic retries - wait for decisions or escalate on timeout

**Integration Jobs**: Service-specific retry behavior
```typescript
interface IntegrationRetryConfig {
  maxRetries: number;
  retryDelay: number;
  retryOn: number[];            // HTTP status codes to retry
}
```

### Graceful Shutdown

When `stop()` is called:
1. Stop accepting new jobs from queue
2. Wait for current job to complete (with configurable timeout)
3. If job doesn't complete within timeout, log warning and force stop
4. Return any incomplete jobs to the queue for re-processing

```typescript
interface ShutdownConfig {
  gracefulShutdownTimeout: number;  // Default: 60000ms
  forceShutdownOnTimeout: boolean;  // Default: true
}
```

### Human Job Timeout & Escalation

When a human job times out:
1. Escalate to a different channel/assignee based on urgency
2. Preserve the decision request (don't fail it)
3. Notify the workflow of the escalation

```typescript
interface HumanJobEscalation {
  timeoutAction: 'escalate' | 'fail';  // Default: 'escalate'
  escalationChannels: string[];         // Ordered list of channels to try
  escalationDelay: number;              // Delay between escalations
}
```

### Container Cleanup (Configurable)

Container cleanup behavior is configurable per-job or globally:
- **Production default**: Best-effort cleanup (kill and remove containers on failure)
- **Development default**: Preserve containers for debugging

```typescript
interface ContainerCleanupConfig {
  cleanupOnFailure: boolean;       // Default: true in prod, false in dev
  cleanupOnSuccess: boolean;       // Default: true
  preserveForDebugging: boolean;   // Override to keep containers
  cleanupTimeout: number;          // Max time to wait for cleanup
}
```

### Resource Management

- Concurrency limits
- Memory limits per job
- Timeout enforcement
- CPU throttling

### Health Check Protocol

Worker exposes health status via two mechanisms:

**HTTP Endpoint** (for Kubernetes/Docker health checks):
```typescript
// GET /health
interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  currentJobs: number;
  lastJobCompleted: string | null;
  version: string;
}

// GET /health/live - Liveness probe
// GET /health/ready - Readiness probe (checks Redis connectivity)
```

**Redis Heartbeat** (for orchestrator tracking):
```typescript
interface WorkerHeartbeat {
  workerId: string;
  timestamp: number;
  status: 'idle' | 'processing' | 'draining';
  currentJob?: string;
  metrics: {
    jobsProcessed: number;
    errorRate: number;
    avgProcessingTime: number;
  };
}

// Published to Redis channel: worker:heartbeat
// Frequency: Every 5 seconds
// TTL: 15 seconds (worker considered dead if 3 heartbeats missed)
```

### Monitoring

- Current job status
- Processing time metrics
- Error rates
- Queue depth

### Configuration

```yaml
worker:
  concurrency: 2

  # Graceful shutdown
  gracefulShutdownTimeout: 60000
  forceShutdownOnTimeout: true

  # Health check
  healthPort: 3001
  heartbeatInterval: 5000
  heartbeatTtl: 15000

  redis:
    url: redis://localhost:6379

  containers:
    enabled: false
    defaultImage: generacy-ai/dev-container:latest
    cleanupOnFailure: true     # Set to false in dev
    cleanupOnSuccess: true
    cleanupTimeout: 30000

  agents:
    claudeCode:
      enabled: true
      timeout: 300000
      retry:
        maxRetries: 3
        initialDelay: 1000
        maxDelay: 30000
        backoffMultiplier: 2

  humanJobs:
    timeoutAction: escalate
    escalationDelay: 300000    # 5 minutes

  integrations:
    defaultRetry:
      maxRetries: 3
      retryDelay: 5000
      retryOn: [429, 502, 503, 504]
```

### Docker

```dockerfile
FROM node:20-alpine

# Install Docker CLI for container management
RUN apk add --no-cache docker-cli

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist ./dist

CMD ["node", "dist/processor.js"]
```

## Acceptance Criteria

- [ ] Jobs dequeue and process
- [ ] Agent invocation works
- [ ] Human jobs wait for response
- [ ] Timeout enforcement works
- [ ] Error handling and retry works
- [ ] Docker image builds
- [ ] Health reporting to orchestrator

## User Stories

### US1: Job Processing

**As a** workflow engine,
**I want** jobs to be processed reliably,
**So that** workflow execution proceeds without manual intervention.

**Acceptance Criteria**:
- [ ] Jobs are dequeued and processed according to priority
- [ ] Job results are returned to the workflow engine
- [ ] Failed jobs are retried with appropriate backoff

### US2: Agent Invocation

**As a** developer,
**I want** AI agents to be invoked for code tasks,
**So that** code changes can be generated automatically.

**Acceptance Criteria**:
- [ ] Agent jobs invoke the correct agent type
- [ ] Agent output is captured and returned
- [ ] Timeouts are enforced for long-running agents

### US3: Human Decision Routing

**As a** decision requester,
**I want** human decisions to be routed and collected,
**So that** workflows can incorporate human judgment.

**Acceptance Criteria**:
- [ ] Human jobs are routed to Humancy
- [ ] Responses are collected and returned
- [ ] Timeouts trigger escalation, not failure

### US4: Graceful Operations

**As an** operator,
**I want** workers to shut down gracefully,
**So that** deployments don't lose in-progress work.

**Acceptance Criteria**:
- [ ] In-progress jobs complete before shutdown
- [ ] Configurable shutdown timeout
- [ ] Health endpoints report worker status

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Dequeue and process jobs from Redis queue | P1 | Core functionality |
| FR-002 | Invoke agents via agent abstraction layer | P1 | Depends on #4 |
| FR-003 | Route human jobs to Humancy service | P1 | |
| FR-004 | Enforce job timeouts | P1 | |
| FR-005 | Implement job-type-specific retry policies | P1 | Agent: exponential backoff |
| FR-006 | Graceful shutdown with configurable timeout | P1 | |
| FR-007 | HTTP health endpoint | P1 | /health, /health/live, /health/ready |
| FR-008 | Redis heartbeat publishing | P2 | Every 5 seconds |
| FR-009 | Container isolation for agent jobs (optional) | P2 | |
| FR-010 | Container cleanup on failure (configurable) | P2 | |
| FR-011 | Human job timeout escalation | P2 | Route to alternate channel |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Job processing success rate | >99% | jobs_succeeded / jobs_attempted |
| SC-002 | Average job latency | <500ms overhead | Total time - agent/human time |
| SC-003 | Graceful shutdown success | 100% | No jobs lost during deployment |
| SC-004 | Health check availability | 99.9% | HTTP endpoint uptime |

## Assumptions

- Redis is available and configured
- Agent abstraction layer (#4) provides invoke() interface
- Job scheduler (#6) provides queue primitives
- Humancy service is available for human job routing

## Out of Scope

- Agent implementation details (handled by #4)
- Queue persistence and backup (handled by #6)
- Human decision UI (handled by Humancy)
- Workflow orchestration logic (separate service)

---

*Generated by speckit*
