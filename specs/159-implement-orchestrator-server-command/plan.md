# Implementation Plan: Orchestrator Server Command

**Feature**: Implement orchestrator server command for generacy CLI
**Branch**: `159-implement-orchestrator-server-command`
**Status**: Complete

## Summary

Implement a `generacy orchestrator` CLI command that runs an HTTP server for worker coordination. The server will handle worker registration, heartbeat tracking, job distribution, and result collection. It follows existing patterns from the health server and CLI commands.

## Technical Context

- **Language**: TypeScript 5.x
- **Runtime**: Node.js 20+
- **CLI Framework**: Commander.js
- **HTTP Server**: Native Node.js `http` module (no Express/Fastify - following existing patterns)
- **Job Queue**: Redis (optional) with in-memory fallback
- **Logging**: Pino structured logging
- **Testing**: Vitest

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                   Orchestrator Server                        │
├─────────────────────────────────────────────────────────────┤
│  CLI Command (orchestrator.ts)                               │
│    └── Parses options, initializes components                │
├─────────────────────────────────────────────────────────────┤
│  HTTP Server (server.ts)                                     │
│    ├── /api/workers/register    POST                         │
│    ├── /api/workers/:id         DELETE                       │
│    ├── /api/workers/:id/heartbeat  POST                      │
│    ├── /api/jobs/poll           GET                          │
│    ├── /api/jobs/:id/result     POST                         │
│    ├── /api/jobs/:id/status     PUT                          │
│    ├── /api/jobs/:id/cancel     POST                         │
│    ├── /api/jobs/:id            GET                          │
│    └── /api/health              GET                          │
├─────────────────────────────────────────────────────────────┤
│  Worker Registry (worker-registry.ts)                        │
│    ├── register(worker)                                      │
│    ├── unregister(workerId)                                  │
│    ├── heartbeat(workerId, data)                             │
│    ├── getWorker(workerId)                                   │
│    └── checkTimeouts()                                       │
├─────────────────────────────────────────────────────────────┤
│  Job Queue (job-queue.ts)                                    │
│    ├── enqueue(job)                                          │
│    ├── poll(workerId, capabilities)                          │
│    ├── updateStatus(jobId, status)                           │
│    ├── reportResult(jobId, result)                           │
│    └── getJob(jobId)                                         │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
packages/generacy/src/
├── cli/
│   ├── index.ts                    # Add orchestratorCommand import
│   └── commands/
│       └── orchestrator.ts         # NEW: CLI command
├── orchestrator/
│   ├── types.ts                    # Existing types (read-only)
│   ├── client.ts                   # Existing client (read-only)
│   ├── server.ts                   # NEW: HTTP server
│   ├── job-queue.ts                # NEW: Job queue abstraction
│   └── worker-registry.ts          # NEW: Worker tracking
```

## Key Design Decisions

### 1. Native HTTP Module vs Framework

**Decision**: Use native Node.js `http` module (not Express/Fastify)

**Rationale**:
- Follows existing pattern from `health/server.ts`
- No additional dependencies
- Lightweight for simple REST API
- Consistent with codebase conventions

### 2. Job Queue Backend Strategy

**Decision**: Interface-based abstraction with Redis and in-memory implementations

**Rationale**:
- Redis provides persistence and horizontal scaling
- In-memory fallback allows development without Redis
- Common interface allows easy switching

### 3. Worker Timeout Handling

**Decision**: Periodic timeout check with configurable threshold

**Rationale**:
- Match client's default 60s heartbeat timeout expectation
- Mark workers as unhealthy after timeout, not immediately removed
- Allow workers to reconnect after brief network issues

### 4. Authentication

**Decision**: Optional Bearer token authentication

**Rationale**:
- Match existing OrchestratorClient pattern
- Unauthenticated by default for trusted networks
- Honor `ORCHESTRATOR_TOKEN` env var when set

## API Endpoints (Server Implementation)

| Method | Path | Handler | Request Body | Response |
|--------|------|---------|--------------|----------|
| POST | `/api/workers/register` | `registerWorker` | `WorkerRegistration` | `{ workerId: string }` |
| DELETE | `/api/workers/:id` | `unregisterWorker` | - | 204 |
| POST | `/api/workers/:id/heartbeat` | `handleHeartbeat` | `Heartbeat` | `HeartbeatResponse` |
| GET | `/api/jobs/poll` | `pollJob` | query: `workerId`, `capabilities` | `PollResponse` |
| PUT | `/api/jobs/:id/status` | `updateJobStatus` | `{ status, ...metadata }` | 204 |
| POST | `/api/jobs/:id/result` | `reportResult` | `JobResult` | 204 |
| GET | `/api/jobs/:id` | `getJob` | - | `Job` |
| POST | `/api/jobs/:id/cancel` | `cancelJob` | `{ reason? }` | 204 |
| GET | `/api/health` | `healthCheck` | - | `HealthStatus` |

## Component Interfaces

### OrchestratorServer Interface

```typescript
interface OrchestratorServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  getPort(): number;
  // For job submission (internal/programmatic use)
  submitJob(job: Omit<Job, 'id' | 'status' | 'createdAt'>): Promise<string>;
}
```

### JobQueue Interface

```typescript
interface JobQueue {
  enqueue(job: Job): Promise<void>;
  poll(workerId: string, capabilities: string[]): Promise<Job | null>;
  updateStatus(jobId: string, status: JobStatus, metadata?: Record<string, unknown>): Promise<void>;
  reportResult(jobId: string, result: JobResult): Promise<void>;
  getJob(jobId: string): Promise<Job | null>;
  cancelJob(jobId: string, reason?: string): Promise<void>;
}
```

### WorkerRegistry Interface

```typescript
interface WorkerRegistry {
  register(registration: WorkerRegistration): Promise<string>;
  unregister(workerId: string): Promise<void>;
  heartbeat(workerId: string, data: Heartbeat): Promise<HeartbeatResponse>;
  getWorker(workerId: string): Worker | undefined;
  getIdleWorkers(): Worker[];
  checkTimeouts(): Promise<string[]>; // Returns timed-out worker IDs
}
```

## Implementation Notes

### HTTP Request Routing

```typescript
// Pattern from health/server.ts adapted for multiple routes
function createServer(handlers: RouteHandlers): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const method = req.method;
    const path = url.pathname;

    // Route matching with path parameters
    // e.g., /api/workers/:id -> { params: { id: 'abc' } }
    const route = matchRoute(method, path);

    if (route) {
      await handlers[route.name](req, res, route.params);
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not Found' }));
    }
  });
}
```

### Redis vs In-Memory Queue

```typescript
// Factory function for queue creation
function createJobQueue(options: JobQueueOptions): JobQueue {
  if (options.redisUrl) {
    try {
      return new RedisJobQueue(options.redisUrl);
    } catch (error) {
      logger.warn('Redis connection failed, falling back to in-memory queue');
    }
  }
  return new InMemoryJobQueue();
}
```

### Graceful Shutdown

Following worker/agent pattern:
1. Stop accepting new connections
2. Wait for in-flight requests to complete (timeout)
3. Persist queue state (if Redis)
4. Close connections

## Dependencies

**Existing** (no new packages needed):
- `commander` - CLI framework
- `pino` - Logging
- Native `http` module - Server

**Optional** (for Redis support):
- `redis` or `ioredis` - Redis client (only if Redis used)

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Server startup time | < 1s | Time from command to listening |
| Request latency | < 10ms | API response time (p95) |
| Memory footprint | < 100MB | Without jobs queued |
| Worker registration | Works | Integration test |
| Job distribution | Works | Integration test |

## Testing Strategy

1. **Unit Tests**: Job queue, worker registry logic
2. **Integration Tests**: Full HTTP API testing
3. **E2E Tests**: Worker connects, receives job, reports result

## Migration Path

1. Implement basic server with in-memory queue
2. Add Redis support as optional enhancement
3. Deploy to devcontainer and validate worker integration
