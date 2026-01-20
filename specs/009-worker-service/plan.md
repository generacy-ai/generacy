# Implementation Plan: Worker Service

**Feature**: Worker service that processes jobs and invokes agents
**Branch**: `009-worker-service`
**Status**: Complete

## Summary

The worker service is a job processor that dequeues jobs from the job scheduler (#6), executes them via the appropriate handler (agent, human, or integration), and reports results back to the workflow engine. It integrates with the agent invocation abstraction (#4) for AI agent execution and the message router for human decision routing.

## Technical Context

### Language & Framework
- **Runtime**: Node.js 20+
- **Language**: TypeScript 5.4+ with strict mode
- **Module System**: ESM modules
- **Testing**: Vitest

### Dependencies
| Package | Version | Purpose |
|---------|---------|---------|
| ioredis | ^5.x | Redis client for heartbeat publishing |
| uuid | ^9.x | Unique worker ID generation |
| express | ^4.x | HTTP health endpoint server |

### Internal Dependencies
| Module | Import Path | Used For |
|--------|-------------|----------|
| Job Scheduler | `@generacy/scheduler` | Job dequeue, ack/nack |
| Agent Registry | `@generacy/agents` | Agent invocation |
| Message Router | `@generacy/router` | Human job routing to Humancy |

## Project Structure

```
src/
  worker/
    index.ts                    # Public exports
    types.ts                    # Worker-specific types
    worker-processor.ts         # Main processor class
    handlers/
      index.ts                  # Handler exports
      agent-handler.ts          # Agent job handler
      human-handler.ts          # Human job handler
      integration-handler.ts    # Integration job handler
    health/
      index.ts                  # Health exports
      health-server.ts          # HTTP health endpoint
      heartbeat.ts              # Redis heartbeat publisher
    retry/
      index.ts                  # Retry exports
      retry-policy.ts           # Job-type specific retry policies
    config/
      index.ts                  # Config exports
      worker-config.ts          # Configuration schema
      defaults.ts               # Default configuration values
```

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                       Worker Service                            │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   WorkerProcessor                         │  │
│  │  - start() / stop()                                       │  │
│  │  - processJob()                                           │  │
│  │  - handleShutdown()                                       │  │
│  └─────────────────┬────────────────────────────────────────┘  │
│                    │                                            │
│         ┌──────────┼──────────┐                                 │
│         ▼          ▼          ▼                                 │
│  ┌───────────┐┌───────────┐┌───────────┐                       │
│  │  Agent    ││  Human    ││Integration│                       │
│  │  Handler  ││  Handler  ││  Handler  │                       │
│  └─────┬─────┘└─────┬─────┘└─────┬─────┘                       │
│        │            │            │                              │
│  ┌─────┴───────────────────────────────────────────────────┐   │
│  │              RetryPolicy (per job type)                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌────────────────────┐  ┌────────────────────┐                │
│  │   HealthServer     │  │    Heartbeat       │                │
│  │   (HTTP :3001)     │  │    (Redis pub)     │                │
│  └────────────────────┘  └────────────────────┘                │
└─────────────────────────────────────────────────────────────────┘
         │                     │                    │
         ▼                     ▼                    ▼
    ┌─────────┐          ┌─────────┐          ┌─────────┐
    │  Agent  │          │ Message │          │External │
    │Registry │          │ Router  │          │Services │
    └─────────┘          └─────────┘          └─────────┘
```

### Processing Flow

```
1. Worker starts → Subscribe to job queue
2. Dequeue job by priority (high → normal → low)
3. Dispatch to appropriate handler based on job.type
4. Handler executes job (with retry on transient failures)
5. On success: ack(job, result)
6. On failure: nack(job, error) → retry or dead-letter
7. Emit metrics and update heartbeat
8. Loop back to step 2
```

### Graceful Shutdown Flow

```
SIGTERM received
    ↓
Stop accepting new jobs
    ↓
Wait for current job (up to gracefulShutdownTimeout)
    ↓
┌─── Job completes? ───┐
│         │            │
│ YES     │     NO     │
│   ↓     │      ↓     │
│ Clean   │  Log warning
│ exit    │  Return job to queue
│         │  Force exit
└─────────┴────────────┘
```

## Implementation Details

### WorkerProcessor Class

```typescript
class WorkerProcessor extends EventEmitter {
  constructor(
    private scheduler: JobScheduler,
    private agentRegistry: AgentRegistry,
    private router: MessageRouter,
    private config: WorkerConfig
  ) {}

  async start(): Promise<void> {
    this.running = true;
    this.healthServer.start();
    this.heartbeat.start();
    await this.processLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.waitForCurrentJob();
    this.healthServer.stop();
    this.heartbeat.stop();
  }

  private async processLoop(): Promise<void> {
    while (this.running) {
      const job = await this.scheduler.dequeue();
      if (job) {
        await this.processJob(job);
      } else {
        await this.sleep(this.config.pollInterval);
      }
    }
  }

  private async processJob(job: Job): Promise<void> {
    this.currentJob = job;
    const handler = this.getHandler(job.type);
    const retryPolicy = this.getRetryPolicy(job.type);

    try {
      const result = await retryPolicy.execute(() => handler.handle(job));
      await this.scheduler.acknowledge(job.id, result);
      this.emit('job:completed', job, result);
    } catch (error) {
      await this.scheduler.nack(job.id, error);
      this.emit('job:failed', job, error);
    } finally {
      this.currentJob = undefined;
    }
  }
}
```

### Job Type Handlers

**Agent Handler**: Invokes AI agents via the registry
```typescript
class AgentHandler implements JobHandler {
  async handle(job: AgentJob): Promise<JobResult> {
    const agent = this.registry.get(job.payload.agent || 'claude-code');
    const result = await agent.invoke({
      command: job.payload.command,
      context: job.payload.context,
      timeout: job.payload.timeout
    });
    return { success: result.success, output: result.output };
  }
}
```

**Human Handler**: Routes to Humancy and waits for response
```typescript
class HumanHandler implements JobHandler {
  async handle(job: HumanJob): Promise<JobResult> {
    const request = this.createDecisionRequest(job);
    await this.router.routeToHumancy(request);
    const response = await this.waitForResponse(request.id, job.payload.timeout);
    return { success: true, output: response };
  }

  private async waitForResponse(id: string, timeout: number): Promise<unknown> {
    // Use correlation manager from router
    return this.router.waitForCorrelation(id, timeout);
  }
}
```

**Integration Handler**: Calls external service APIs
```typescript
class IntegrationHandler implements JobHandler {
  async handle(job: IntegrationJob): Promise<JobResult> {
    const plugin = this.integrations.get(job.payload.integration);
    return plugin.execute(job.payload.action, job.payload.params);
  }
}
```

### Retry Policies

```typescript
interface RetryPolicy {
  execute<T>(fn: () => Promise<T>): Promise<T>;
}

class ExponentialBackoffPolicy implements RetryPolicy {
  constructor(private config: AgentRetryConfig) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error;
    let delay = this.config.initialDelay;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (!this.isRetryable(error)) throw error;
        lastError = error;
        if (attempt < this.config.maxRetries) {
          await sleep(delay);
          delay = Math.min(delay * this.config.backoffMultiplier, this.config.maxDelay);
        }
      }
    }
    throw lastError;
  }
}

class NoRetryPolicy implements RetryPolicy {
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}
```

### Health Check Server

```typescript
class HealthServer {
  private app = express();

  constructor(private processor: WorkerProcessor, private port: number) {
    this.app.get('/health', this.handleHealth.bind(this));
    this.app.get('/health/live', this.handleLiveness.bind(this));
    this.app.get('/health/ready', this.handleReadiness.bind(this));
  }

  private handleHealth(req: Request, res: Response) {
    res.json({
      status: this.processor.isHealthy() ? 'healthy' : 'degraded',
      uptime: process.uptime(),
      currentJobs: this.processor.getCurrentJobCount(),
      lastJobCompleted: this.processor.getLastCompletedTime(),
      version: process.env.VERSION || '0.0.0'
    });
  }
}
```

### Redis Heartbeat

```typescript
class Heartbeat {
  private intervalId?: NodeJS.Timeout;

  constructor(
    private redis: Redis,
    private workerId: string,
    private processor: WorkerProcessor,
    private config: HeartbeatConfig
  ) {}

  start(): void {
    this.intervalId = setInterval(
      () => this.publish(),
      this.config.heartbeatInterval
    );
  }

  private async publish(): Promise<void> {
    const heartbeat: WorkerHeartbeat = {
      workerId: this.workerId,
      timestamp: Date.now(),
      status: this.processor.getStatus(),
      currentJob: this.processor.getCurrentJob()?.id,
      metrics: this.processor.getMetrics()
    };

    await this.redis.setex(
      `worker:heartbeat:${this.workerId}`,
      this.config.heartbeatTtl / 1000,
      JSON.stringify(heartbeat)
    );

    await this.redis.publish('worker:heartbeat', JSON.stringify(heartbeat));
  }
}
```

## Testing Strategy

### Unit Tests
- WorkerProcessor: start/stop lifecycle, job dispatching
- Each handler: job type processing, error handling
- Retry policies: backoff calculation, retry limits
- Health endpoints: response format, status calculation

### Integration Tests
- Full job processing flow with mock scheduler
- Graceful shutdown with in-progress job
- Redis heartbeat publishing
- Human job correlation timeout

### End-to-End Tests
- Worker + real Redis backend
- Agent job execution
- Human job routing to mock Humancy

## Configuration Schema

```typescript
interface WorkerConfig {
  workerId?: string;                  // Auto-generated if not provided
  concurrency: number;                // Max concurrent jobs
  pollInterval: number;               // Queue polling interval (ms)

  gracefulShutdownTimeout: number;    // Shutdown wait time (ms)
  forceShutdownOnTimeout: boolean;    // Force exit after timeout

  health: {
    port: number;                     // HTTP health port
    enabled: boolean;
  };

  heartbeat: {
    interval: number;                 // Heartbeat frequency (ms)
    ttl: number;                      // Heartbeat TTL in Redis (ms)
    enabled: boolean;
  };

  handlers: {
    agent: AgentRetryConfig;
    human: HumanJobConfig;
    integration: IntegrationRetryConfig;
  };

  containers: ContainerConfig;        // Container isolation settings
}
```

## Key Technical Decisions

1. **Single process loop**: Uses polling instead of blocking dequeue for better control over shutdown
2. **Per-type retry policies**: Different job types have fundamentally different failure modes
3. **Dual health reporting**: HTTP for orchestration, Redis for distributed coordination
4. **Event-driven metrics**: Emits events for external observability systems
5. **Container isolation optional**: Can run agents directly or in containers based on config

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Job loss during shutdown | Return incomplete jobs to queue |
| Human job timeout | Escalation to alternate channel |
| Agent timeout | Configurable per-agent limits |
| Redis connection loss | Health check marks worker unhealthy |
| Container cleanup failure | Best-effort cleanup with timeout |

## Dependencies Resolution

This implementation depends on:
- **#4 Agent invocation abstraction**: Uses `AgentRegistry` and `AgentInvoker` interfaces
- **#6 Job scheduler**: Uses `JobScheduler` for queue operations
- **#5 Message router**: Uses `MessageRouter` for human job routing

All dependencies provide the interfaces specified in the spec.

---

*Generated by speckit*
