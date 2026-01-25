# @generacy-ai/generacy

Headless CLI for running Generacy workflows in containers and CI/CD environments.

## Installation

```bash
npm install -g @generacy-ai/generacy
```

Or use with npx:

```bash
npx @generacy-ai/generacy run workflow.yaml
```

## Features

- **Headless Execution**: Run workflows without VS Code or GUI
- **Orchestrator Integration**: Connect to Generacy orchestrator for job management
- **Worker Mode**: Process jobs from a central queue
- **Agent Mode**: Enhanced worker with AI tool routing via Agency
- **Health Checks**: Built-in health endpoints for container orchestration
- **Configurable**: Environment variables and CLI options

## CLI Commands

### Run a Workflow

Execute a workflow file directly:

```bash
generacy run workflow.yaml

# With inputs
generacy run workflow.yaml -i name=value -i count=5

# In a specific directory
generacy run workflow.yaml -w /path/to/project

# Dry run (validation only)
generacy run workflow.yaml --dry-run

# Execute single step
generacy run workflow.yaml --single-step "step-name"
```

### Worker Mode

Start a worker that processes jobs from the orchestrator:

```bash
generacy worker --url http://orchestrator:3000

# With custom worker ID
generacy worker -u http://orchestrator:3000 -i my-worker-01

# With capabilities
generacy worker -u http://orchestrator:3000 -c nodejs -c typescript

# Custom health port
generacy worker -u http://orchestrator:3000 -p 9090
```

### Agent Mode

Start an agent worker with AI tool routing:

```bash
generacy agent --url http://orchestrator:3000

# With network Agency
generacy agent -u http://orchestrator:3000 --agency-mode network --agency-url http://agency:8000

# With subprocess Agency
generacy agent -u http://orchestrator:3000 --agency-mode subprocess --agency-command "npx agency"
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Logging level | `info` |
| `GENERACY_PRETTY_LOG` | Enable pretty logging | `true` (dev) |
| `GENERACY_WORKDIR` | Working directory | `process.cwd()` |
| `ORCHESTRATOR_URL` | Orchestrator service URL | - |
| `ORCHESTRATOR_TOKEN` | Authentication token | - |
| `WORKER_ID` | Worker identifier | auto-generated |
| `HEALTH_PORT` | Health check port | `8080` |
| `HEARTBEAT_INTERVAL` | Heartbeat interval (ms) | `30000` |
| `POLL_INTERVAL` | Job poll interval (ms) | `5000` |
| `AGENCY_MODE` | Agency mode | `subprocess` |
| `AGENCY_URL` | Agency URL (network mode) | - |
| `AGENCY_COMMAND` | Agency command (subprocess) | `npx @anthropic-ai/agency` |

### CLI Options

Global options available for all commands:

```bash
-l, --log-level <level>  Log level (trace, debug, info, warn, error)
--no-pretty              Disable pretty logging (use JSON)
```

## Docker Usage

```dockerfile
FROM node:20-alpine

RUN npm install -g @generacy-ai/generacy

WORKDIR /app

# Health check
HEALTHCHECK --interval=30s --timeout=3s \
  CMD curl -f http://localhost:8080/health || exit 1

# Run as worker
CMD ["generacy", "worker", "-u", "http://orchestrator:3000"]
```

Docker Compose example:

```yaml
services:
  worker:
    image: generacy-worker
    environment:
      - ORCHESTRATOR_URL=http://orchestrator:3000
      - ORCHESTRATOR_TOKEN=${ORCHESTRATOR_TOKEN}
      - LOG_LEVEL=info
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 3s
      retries: 3
```

## Health Endpoints

The worker exposes health endpoints on the configured port:

- `GET /health` - Full health status
- `GET /ready` - Readiness probe
- `GET /live` - Liveness probe

Example response:

```json
{
  "status": "healthy",
  "uptime": 3600000,
  "lastHeartbeat": "2024-01-15T10:30:00.000Z",
  "currentJob": null,
  "timestamp": "2024-01-15T10:30:30.000Z"
}
```

## Programmatic Usage

Use as a library in your Node.js applications:

```typescript
import {
  OrchestratorClient,
  createAgencyConnection,
  loadWorkflow,
  WorkflowExecutor,
} from '@generacy-ai/generacy';

// Create orchestrator client
const client = new OrchestratorClient({
  baseUrl: 'http://orchestrator:3000',
});

// Register worker
await client.register({
  id: 'my-worker',
  name: 'My Worker',
  capabilities: ['nodejs'],
  maxConcurrent: 1,
});

// Poll for jobs
const response = await client.pollForJob('my-worker');
if (response.job) {
  // Execute the job workflow
  const workflow = await loadWorkflow(response.job.workflow);
  // ...
}
```

## Graceful Shutdown

The worker handles SIGTERM and SIGINT for graceful shutdown:

1. Stops accepting new jobs
2. Waits for current job to complete (up to 60 seconds)
3. Sends final heartbeat
4. Unregisters from orchestrator
5. Closes health server

## License

MIT
