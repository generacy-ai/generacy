# Research: Worker Service

## Technology Decisions

### 1. Job Processing Model

**Decision**: Single-threaded polling loop with configurable poll interval

**Rationale**:
- **Control**: Polling allows precise control over shutdown timing
- **Simplicity**: Avoids complexity of blocking dequeue operations
- **Observability**: Easy to inspect current state at any time

**Alternatives Considered**:
| Option | Pros | Cons |
|--------|------|------|
| Blocking BRPOP | Lower latency | Hard to interrupt for shutdown |
| Event-driven with listeners | Reactive | Complex state management |
| Worker threads pool | Parallel processing | Node.js threading overhead |

**Pattern**: The job scheduler already provides `dequeue()` as a non-blocking operation, which fits the polling model.

### 2. Retry Strategy

**Decision**: Job-type specific retry policies

**Rationale**: Different job types have fundamentally different failure modes:

| Job Type | Failure Mode | Appropriate Strategy |
|----------|--------------|---------------------|
| Agent | Rate limits, network issues | Exponential backoff |
| Human | Timeout waiting for response | Escalation, not retry |
| Integration | Service unavailable | Status-code based retry |

**Implementation Pattern**: Strategy pattern with `RetryPolicy` interface
```typescript
interface RetryPolicy {
  execute<T>(fn: () => Promise<T>): Promise<T>;
}
```

### 3. Health Reporting

**Decision**: Dual mechanism - HTTP endpoints + Redis heartbeat

**Rationale**:
- **HTTP**: Standard for container orchestration (K8s probes)
- **Redis**: Enables distributed coordination and leader election

**HTTP Endpoints**:
| Endpoint | Purpose | Response Time |
|----------|---------|---------------|
| `/health` | Full status | <100ms |
| `/health/live` | Liveness probe | <10ms |
| `/health/ready` | Readiness probe | <50ms (checks Redis) |

**Redis Pattern**: Heartbeat with TTL
- Key: `worker:heartbeat:{workerId}`
- TTL: 15 seconds (3x heartbeat interval)
- Channel: `worker:heartbeat` for pub/sub

### 4. Graceful Shutdown

**Decision**: Wait for current job with configurable timeout

**Rationale**: Agent jobs accumulate context over their execution. Interrupting them loses that context and may leave partial changes.

**Shutdown Sequence**:
1. SIGTERM received → Set `running = false`
2. Stop accepting new jobs from queue
3. Wait up to `gracefulShutdownTimeout` for current job
4. If timeout: Log warning, return job to queue, force exit
5. Clean exit

**Alternative Considered**: Checkpoint/resume for long-running jobs
- **Rejected**: Too complex for MVP, agents don't support checkpointing

### 5. Concurrency Model

**Decision**: Single-job processing with concurrency limit of 1 (default)

**Rationale**:
- **Simplicity**: Single job = simpler state management
- **Resource control**: Agent jobs can be resource-intensive
- **Future-proof**: Can increase concurrency when needed

**Future Enhancement**: Pool of workers with shared job queue
- Each worker process handles one job
- Kubernetes scales worker pods based on queue depth

### 6. Container Isolation

**Decision**: Optional, configurable per-job

**Rationale**:
- **Development**: Run agents directly for faster iteration
- **Production**: Use containers for isolation and security

**Container Strategy**:
```typescript
interface ContainerConfig {
  enabled: boolean;
  image: string;
  cleanupOnFailure: boolean;  // true in prod, false in dev
  cleanupOnSuccess: boolean;
  cleanupTimeout: number;
}
```

## Implementation Patterns

### Event Emitter Pattern

Used throughout the codebase for observability:
```typescript
class WorkerProcessor extends EventEmitter {
  // Emits: 'job:started', 'job:completed', 'job:failed', 'metrics:snapshot'
}
```

### Registry Pattern

For managing multiple integrations:
```typescript
class IntegrationRegistry {
  private integrations = new Map<string, Integration>();

  register(name: string, integration: Integration): void;
  get(name: string): Integration | undefined;
}
```

### Configuration with Defaults

Pattern from existing services:
```typescript
const DEFAULT_CONFIG: WorkerConfig = {
  concurrency: 1,
  pollInterval: 1000,
  gracefulShutdownTimeout: 60000,
  // ...
};

function createConfig(partial: Partial<WorkerConfig>): WorkerConfig {
  return { ...DEFAULT_CONFIG, ...partial };
}
```

## Key Sources

1. **Job Scheduler Interface**: `/src/scheduler/job-scheduler.ts`
   - Provides `dequeue()`, `acknowledge()`, `nack()` methods
   - Event-based for job lifecycle tracking

2. **Agent Registry Interface**: `/src/agents/agent-registry.ts`
   - `get(name)` returns `AgentInvoker`
   - `AgentInvoker.invoke()` for execution

3. **Message Router Interface**: `/src/router/message-router.ts`
   - `routeToHumancy()` for human job routing
   - Correlation manager for response tracking

4. **Existing Service Patterns**: `/src/learning/`, `/src/scheduler/`
   - EventEmitter base class
   - Configuration with defaults
   - Interface-first design

## Performance Considerations

### Latency Targets

| Operation | Target | Measurement |
|-----------|--------|-------------|
| Job dequeue | <10ms | Redis RPOPLPUSH |
| Health check | <100ms | HTTP response |
| Heartbeat publish | <50ms | Redis SET + PUBLISH |
| Job ack/nack | <20ms | Redis transaction |

### Resource Limits

| Resource | Default Limit | Rationale |
|----------|--------------|-----------|
| Memory per job | 512MB | Agent processes can be memory-intensive |
| CPU per job | 1 core | Fair sharing in multi-tenant environment |
| Job timeout | 5 minutes | Reasonable for most agent tasks |
| Queue poll interval | 1 second | Balance between latency and CPU usage |

## Security Considerations

1. **Container Isolation**: Run untrusted agent code in containers
2. **Network Policies**: Restrict container network access
3. **Volume Mounts**: Read-only source code mounts
4. **Credentials**: Use environment variables, not config files

---

*Generated by speckit*
