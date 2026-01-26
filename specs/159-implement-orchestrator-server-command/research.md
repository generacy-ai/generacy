# Research: Orchestrator Server Implementation

## Technology Decisions

### 1. HTTP Server Framework

**Decision**: Native Node.js `http` module

**Alternatives Considered**:
| Option | Pros | Cons |
|--------|------|------|
| **Native http (chosen)** | No deps, follows existing pattern, lightweight | Manual routing needed |
| Express | Rich ecosystem, middleware support | New dependency, overkill for simple API |
| Fastify | High performance, schema validation | New dependency, learning curve |
| Hono | Lightweight, modern | New dependency |

**Rationale**: The existing `health/server.ts` uses native Node.js `http`. Maintaining consistency reduces cognitive load and dependencies. The orchestrator API is simple enough that manual routing is manageable.

### 2. Job Queue Storage

**Decision**: Dual backend with interface abstraction (Redis + In-Memory)

**Pattern**: Strategy pattern with factory function

```typescript
interface JobQueue {
  enqueue(job: Job): Promise<void>;
  poll(workerId: string, capabilities: string[]): Promise<Job | null>;
  // ...
}

// Factory chooses implementation based on config
function createJobQueue(options: { redisUrl?: string }): JobQueue;
```

**Redis Considerations**:
- Use Redis List (`LPUSH`/`RPOPLPUSH`) for FIFO queue
- Store job details in Hash (`HSET job:{id}`)
- Use Sorted Set for priority queue (`ZADD jobs:pending`)
- Consider Redis Streams for production-grade implementation

**In-Memory Considerations**:
- Use `Map<string, Job>` for job storage
- Use priority queue (array sorted by priority) for pending jobs
- Warn on startup about data loss on restart

### 3. Worker Registry Design

**Decision**: In-memory registry with heartbeat-based health tracking

**Data Structure**:
```typescript
interface RegisteredWorker {
  id: string;
  name: string;
  capabilities: string[];
  maxConcurrent: number;
  currentJobs: string[];
  lastHeartbeat: Date;
  status: 'healthy' | 'unhealthy' | 'offline';
  metadata: Record<string, unknown>;
}

// Storage
const workers = new Map<string, RegisteredWorker>();
```

**Health States**:
| State | Condition | Behavior |
|-------|-----------|----------|
| healthy | Heartbeat within timeout | Eligible for job assignment |
| unhealthy | Heartbeat missed (< 2x timeout) | No new jobs, existing jobs continue |
| offline | No heartbeat (> 2x timeout) | Jobs reassigned, worker removed |

### 4. Authentication Approach

**Decision**: Optional Bearer token authentication

**Implementation**:
```typescript
function authenticate(req: IncomingMessage): boolean {
  const token = process.env['ORCHESTRATOR_TOKEN'];
  if (!token) return true; // Auth disabled

  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return false;

  return authHeader.slice(7) === token;
}
```

**Rationale**: Matches existing OrchestratorClient implementation that sends Bearer token when `ORCHESTRATOR_TOKEN` is set.

## Implementation Patterns

### 1. Request Routing Pattern

Based on native http module with manual path matching:

```typescript
interface RouteMatch {
  handler: string;
  params: Record<string, string>;
}

function matchRoute(method: string, path: string): RouteMatch | null {
  const routes = [
    { method: 'POST', pattern: /^\/api\/workers\/register$/, handler: 'registerWorker' },
    { method: 'DELETE', pattern: /^\/api\/workers\/([^/]+)$/, handler: 'unregisterWorker', paramNames: ['id'] },
    { method: 'POST', pattern: /^\/api\/workers\/([^/]+)\/heartbeat$/, handler: 'handleHeartbeat', paramNames: ['id'] },
    { method: 'GET', pattern: /^\/api\/jobs\/poll$/, handler: 'pollJob' },
    { method: 'PUT', pattern: /^\/api\/jobs\/([^/]+)\/status$/, handler: 'updateJobStatus', paramNames: ['id'] },
    { method: 'POST', pattern: /^\/api\/jobs\/([^/]+)\/result$/, handler: 'reportResult', paramNames: ['id'] },
    { method: 'GET', pattern: /^\/api\/jobs\/([^/]+)$/, handler: 'getJob', paramNames: ['id'] },
    { method: 'POST', pattern: /^\/api\/jobs\/([^/]+)\/cancel$/, handler: 'cancelJob', paramNames: ['id'] },
    { method: 'GET', pattern: /^\/api\/health$/, handler: 'healthCheck' },
  ];

  for (const route of routes) {
    if (method !== route.method) continue;
    const match = path.match(route.pattern);
    if (match) {
      const params: Record<string, string> = {};
      route.paramNames?.forEach((name, i) => {
        params[name] = match[i + 1];
      });
      return { handler: route.handler, params };
    }
  }
  return null;
}
```

### 2. Request Body Parsing

```typescript
async function parseBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body) as T);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
```

### 3. Response Helpers

```typescript
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}
```

### 4. Job Assignment Algorithm

```typescript
function assignJob(job: Job, workers: Map<string, RegisteredWorker>): string | null {
  // Find workers matching job requirements
  const eligible = [...workers.values()].filter(w => {
    if (w.status !== 'healthy') return false;
    if (w.currentJobs.length >= w.maxConcurrent) return false;
    if (job.tags?.length) {
      // All job tags must match worker capabilities
      return job.tags.every(tag => w.capabilities.includes(tag));
    }
    return true;
  });

  if (eligible.length === 0) return null;

  // Simple round-robin or least-loaded selection
  eligible.sort((a, b) => a.currentJobs.length - b.currentJobs.length);
  return eligible[0].id;
}
```

## Key References

### Existing Codebase Patterns

| File | Pattern Used |
|------|--------------|
| `health/server.ts` | Native HTTP server structure |
| `cli/commands/worker.ts` | CLI command pattern with Commander.js |
| `orchestrator/client.ts` | API contract (methods to implement) |
| `orchestrator/types.ts` | Type definitions for request/response |

### API Contract (from OrchestratorClient)

The client expects these endpoints:
- `POST /api/workers/register` - Returns `{ workerId: string }`
- `DELETE /api/workers/:id` - Returns 204
- `POST /api/workers/:id/heartbeat` - Returns `HeartbeatResponse`
- `GET /api/jobs/poll?workerId=X&capabilities=a,b` - Returns `PollResponse`
- `PUT /api/jobs/:id/status` - Returns 204
- `POST /api/jobs/:id/result` - Returns 204
- `GET /api/jobs/:id` - Returns `Job`
- `POST /api/jobs/:id/cancel` - Returns 204

### Error Handling

Match `OrchestratorError` type:
```typescript
interface OrchestratorError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Memory leak in job queue | Medium | High | Size limits, periodic cleanup |
| Worker timeout edge cases | Medium | Medium | Grace period, state transitions |
| Race conditions in job assignment | Medium | High | Atomic operations, locking |
| Redis connection failures | Low | High | Graceful fallback, reconnection |

## Performance Considerations

1. **Job Polling**: Workers poll every 5s by default. With 10 workers, ~2 requests/second.
2. **Heartbeats**: Workers heartbeat every 30s. With 10 workers, ~0.3 requests/second.
3. **Expected Load**: Low - designed for devcontainer use with few workers.
4. **Bottleneck**: Job assignment algorithm if queue grows large.
