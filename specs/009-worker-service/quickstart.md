# Quickstart: Worker Service

## Installation

```bash
# Install dependencies (from project root)
npm install

# Or if using the worker service standalone
npm install ioredis express uuid
```

## Basic Usage

### Starting a Worker

```typescript
import { WorkerProcessor, createWorkerConfig } from '@generacy/worker';
import { JobScheduler } from '@generacy/scheduler';
import { AgentRegistry } from '@generacy/agents';
import { MessageRouter } from '@generacy/router';

// Create dependencies
const scheduler = new JobScheduler({ /* scheduler config */ });
const agentRegistry = new AgentRegistry();
const router = new MessageRouter({ /* router config */ });

// Create worker config
const config = createWorkerConfig({
  concurrency: 1,
  health: { enabled: true, port: 3001 },
  heartbeat: { enabled: true, interval: 5000, ttl: 15000 },
  redis: { host: 'localhost', port: 6379 }
});

// Create and start worker
const worker = new WorkerProcessor(scheduler, agentRegistry, router, config);

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down worker...');
  await worker.stop();
  process.exit(0);
});

// Start processing
await worker.start();
console.log(`Worker ${worker.workerId} started`);
```

### Configuration via Environment Variables

```bash
# Core settings
WORKER_CONCURRENCY=2
WORKER_POLL_INTERVAL=1000
WORKER_GRACEFUL_SHUTDOWN_TIMEOUT=60000

# Health check
WORKER_HEALTH_ENABLED=true
WORKER_HEALTH_PORT=3001

# Heartbeat
WORKER_HEARTBEAT_ENABLED=true
WORKER_HEARTBEAT_INTERVAL=5000
WORKER_HEARTBEAT_TTL=15000

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# Agent handler
AGENT_DEFAULT_TIMEOUT=300000
AGENT_MAX_RETRIES=3

# Container isolation (optional)
CONTAINERS_ENABLED=false
CONTAINERS_DEFAULT_IMAGE=generacy-ai/dev-container:latest
```

### Configuration via YAML

```yaml
# worker.config.yaml
worker:
  concurrency: 2
  pollInterval: 1000
  gracefulShutdownTimeout: 60000
  forceShutdownOnTimeout: true

  health:
    enabled: true
    port: 3001

  heartbeat:
    enabled: true
    interval: 5000
    ttl: 15000

  redis:
    host: localhost
    port: 6379

  handlers:
    agent:
      defaultTimeout: 300000
      retry:
        maxRetries: 3
        initialDelay: 1000
        maxDelay: 30000
        backoffMultiplier: 2

    human:
      defaultTimeout: 3600000
      timeoutAction: escalate
      escalationDelay: 300000

    integration:
      defaultTimeout: 30000
      retry:
        maxRetries: 3
        retryDelay: 5000
        retryOn: [429, 502, 503, 504]

  containers:
    enabled: false
    defaultImage: generacy-ai/dev-container:latest
    cleanupOnFailure: true
    cleanupOnSuccess: true
```

## Job Processing Examples

### Processing Agent Jobs

Agent jobs invoke AI agents to perform code tasks:

```typescript
// Job payload structure
const agentJob = {
  id: 'job_123',
  type: 'agent',
  payload: {
    agent: 'claude-code',
    command: '/speckit:specify',
    context: {
      workingDirectory: '/workspace/project',
      issueNumber: 42,
      branch: 'feature/42-new-feature'
    },
    timeout: 300000  // 5 minutes
  }
};

// Result structure
const result = {
  success: true,
  output: '/* Generated specification */',
  exitCode: 0,
  duration: 45000,
  toolCalls: [
    { tool: 'Read', summary: 'Read 3 files' },
    { tool: 'Write', summary: 'Created spec.md' }
  ]
};
```

### Processing Human Jobs

Human jobs route decisions to Humancy:

```typescript
// Job payload structure
const humanJob = {
  id: 'job_456',
  type: 'human',
  payload: {
    type: 'decision',
    title: 'Approve deployment to production',
    description: 'Review the changes and approve for production deployment',
    options: [
      { id: 'approve', label: 'Approve', description: 'Deploy to production' },
      { id: 'reject', label: 'Reject', description: 'Block deployment' },
      { id: 'defer', label: 'Defer', description: 'Decide later' }
    ],
    urgency: 'high',
    timeout: 3600000,  // 1 hour
    escalation: {
      timeoutAction: 'escalate',
      escalationChannels: ['slack-team', 'email-manager'],
      escalationDelay: 300000  // 5 minutes
    }
  }
};

// Result structure
const result = {
  success: true,
  output: {
    decision: 'approve',
    respondedBy: 'user@example.com',
    respondedAt: '2024-01-15T10:30:00Z'
  }
};
```

### Processing Integration Jobs

Integration jobs call external services:

```typescript
// Job payload structure
const integrationJob = {
  id: 'job_789',
  type: 'integration',
  payload: {
    integration: 'github',
    action: 'create-pr',
    params: {
      repo: 'owner/repo',
      title: 'Feature implementation',
      body: 'Implements feature #42',
      base: 'main',
      head: 'feature/42'
    }
  }
};

// Result structure
const result = {
  success: true,
  output: {
    prNumber: 123,
    url: 'https://github.com/owner/repo/pull/123'
  },
  statusCode: 201
};
```

## Health Check Endpoints

### Full Health Status

```bash
curl http://localhost:3001/health
```

Response:
```json
{
  "status": "healthy",
  "uptime": 3600,
  "currentJobs": 1,
  "lastJobCompleted": "2024-01-15T10:25:00Z",
  "version": "1.0.0",
  "details": {
    "redis": "connected",
    "queueDepth": 5
  }
}
```

### Liveness Probe

```bash
curl http://localhost:3001/health/live
```

Response: `200 OK` if process is running

### Readiness Probe

```bash
curl http://localhost:3001/health/ready
```

Response: `200 OK` if worker is ready to process jobs (Redis connected)

## Monitoring

### Worker Events

```typescript
worker.on('job:started', (job) => {
  console.log(`Started job ${job.id} (${job.type})`);
});

worker.on('job:completed', (job, result) => {
  console.log(`Completed job ${job.id} in ${result.duration}ms`);
});

worker.on('job:failed', (job, error) => {
  console.error(`Failed job ${job.id}: ${error.message}`);
});

worker.on('metrics:snapshot', (metrics) => {
  console.log(`Processed: ${metrics.jobsProcessed}, Error rate: ${metrics.errorRate}`);
});
```

### Redis Heartbeat

Monitor worker status via Redis:

```bash
# Get current heartbeat
redis-cli GET worker:heartbeat:worker_abc123

# Subscribe to heartbeat channel
redis-cli SUBSCRIBE worker:heartbeat
```

Heartbeat format:
```json
{
  "workerId": "worker_abc123",
  "timestamp": 1705312800000,
  "status": "processing",
  "currentJob": "job_123",
  "metrics": {
    "jobsProcessed": 150,
    "jobsSucceeded": 145,
    "jobsFailed": 5,
    "errorRate": 0.033,
    "avgProcessingTime": 12500
  }
}
```

## Docker Deployment

### Building the Image

```bash
docker build -t generacy/worker:latest -f services/worker/Dockerfile .
```

### Running in Docker

```bash
docker run -d \
  --name generacy-worker \
  -p 3001:3001 \
  -e REDIS_HOST=redis \
  -e WORKER_HEALTH_PORT=3001 \
  generacy/worker:latest
```

### Docker Compose

```yaml
version: '3.8'

services:
  worker:
    build:
      context: .
      dockerfile: services/worker/Dockerfile
    ports:
      - "3001:3001"
    environment:
      - REDIS_HOST=redis
      - WORKER_CONCURRENCY=2
    depends_on:
      - redis
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/health/live"]
      interval: 10s
      timeout: 5s
      retries: 3

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

## Troubleshooting

### Common Issues

**Worker not processing jobs**
- Check Redis connectivity: `redis-cli ping`
- Verify queue has jobs: Check job scheduler status
- Check health endpoint: `curl localhost:3001/health`

**Jobs failing with timeout**
- Increase `handlers.agent.defaultTimeout` in config
- Check if agent is responsive
- Review container resource limits

**Heartbeat not publishing**
- Verify `heartbeat.enabled: true` in config
- Check Redis PUBLISH permissions
- Verify `heartbeat.interval` is not too high

**Graceful shutdown failing**
- Increase `gracefulShutdownTimeout`
- Check if current job is stuck
- Review logs for shutdown sequence

### Debug Mode

Enable verbose logging:

```bash
DEBUG=generacy:worker* node dist/processor.js
```

---

*Generated by speckit*
