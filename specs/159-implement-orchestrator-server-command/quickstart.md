# Quickstart: Orchestrator Server

## Installation

The orchestrator command is part of the generacy CLI. No additional installation needed.

```bash
# From the generacy package
npm run build
```

## Basic Usage

### Start the Orchestrator

```bash
# Default configuration (port 3100, in-memory queue)
generacy orchestrator

# Custom port
generacy orchestrator --port 3200

# With Redis backend
generacy orchestrator --redis-url redis://localhost:6379

# With authentication
ORCHESTRATOR_TOKEN=secret generacy orchestrator
```

### CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `-p, --port <port>` | 3100 | HTTP server port |
| `-r, --redis-url <url>` | - | Redis connection URL (optional) |
| `--health-port <port>` | 3101 | Health check port |
| `--worker-timeout <ms>` | 60000 | Worker heartbeat timeout |
| `-l, --log-level <level>` | info | Log level (trace/debug/info/warn/error) |
| `--no-pretty` | - | Disable pretty logging |

## API Endpoints

### Health Check

```bash
curl http://localhost:3100/api/health
# Response: {"status":"healthy","workers":0,"pendingJobs":0,"timestamp":"..."}
```

### Worker Registration

```bash
curl -X POST http://localhost:3100/api/workers/register \
  -H "Content-Type: application/json" \
  -d '{"name":"worker-1","capabilities":["default"]}'
# Response: {"workerId":"worker-abc123"}
```

### Submit a Job (Internal)

Jobs are typically submitted programmatically or through other services:

```typescript
import { OrchestratorServer } from './orchestrator/server';

const server = await createOrchestratorServer({ port: 3100 });
const jobId = await server.submitJob({
  name: 'my-workflow',
  workflow: 'path/to/workflow.yaml',
  inputs: { key: 'value' },
});
```

## Example: Complete Workflow

### 1. Start Orchestrator

```bash
generacy orchestrator --port 3100
# [info] Orchestrator started on port 3100
# [info] Using in-memory job queue
```

### 2. Start Worker (in another terminal)

```bash
generacy worker --url http://localhost:3100
# [info] Worker registered with ID: worker-xyz
# [info] Polling for jobs...
```

### 3. Verify Connection

```bash
curl http://localhost:3100/api/health
# {"status":"healthy","workers":1,"pendingJobs":0,"timestamp":"2026-01-26T..."}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ORCHESTRATOR_TOKEN` | Bearer token for authentication (optional) |
| `REDIS_URL` | Redis connection URL (alternative to --redis-url) |
| `PORT` | Default port (alternative to --port) |
| `LOG_LEVEL` | Default log level |

## Devcontainer Integration

The orchestrator integrates with the triad-development devcontainer:

```bash
# In devcontainer, the entrypoint script runs:
generacy orchestrator --redis-url ${REDIS_URL:-redis://redis:6379}
```

## Troubleshooting

### Server won't start

1. Check if port is already in use:
   ```bash
   lsof -i :3100
   ```

2. Try a different port:
   ```bash
   generacy orchestrator --port 3200
   ```

### Workers not connecting

1. Verify orchestrator URL from worker perspective:
   ```bash
   curl http://localhost:3100/api/health
   ```

2. Check network/firewall settings

3. Ensure authentication tokens match (if used)

### Redis connection failures

1. Verify Redis is running:
   ```bash
   redis-cli ping
   ```

2. Check Redis URL format:
   ```bash
   # Correct formats:
   redis://localhost:6379
   redis://user:password@host:6379
   ```

3. The orchestrator will fall back to in-memory queue if Redis fails

### Workers timing out

1. Increase timeout:
   ```bash
   generacy orchestrator --worker-timeout 120000
   ```

2. Check network stability between worker and orchestrator

3. Verify worker heartbeat interval matches expectations

## Logging

### Log Levels

- `trace`: All internal operations
- `debug`: Detailed debugging info
- `info`: Normal operations (default)
- `warn`: Warnings (e.g., Redis fallback)
- `error`: Errors only

### Example Output

```
[info] Orchestrator starting...
[info] Port: 3100
[warn] Redis not configured, using in-memory queue (data will not persist)
[info] Orchestrator ready
[info] Worker registered: worker-1 (capabilities: default)
[debug] Heartbeat received from worker-1
[info] Job assigned: job-abc123 -> worker-1
```
