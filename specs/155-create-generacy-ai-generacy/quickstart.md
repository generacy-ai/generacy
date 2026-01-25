# Quickstart: @generacy-ai/generacy

Get started with headless workflow execution in minutes.

## Installation

```bash
# Global installation
npm install -g @generacy-ai/generacy

# Or run directly with npx
npx @generacy-ai/generacy --help
```

## Quick Start

### 1. Run a Workflow Locally

```bash
# Run a workflow file
npx @generacy-ai/generacy run my-workflow.yaml

# With input variables
npx @generacy-ai/generacy run my-workflow.yaml \
  --input issueUrl=https://github.com/org/repo/issues/123 \
  --input branch=feature/test

# Dry run (validate without executing)
npx @generacy-ai/generacy run my-workflow.yaml --dry-run
```

### 2. Start as Worker

```bash
# Connect to orchestrator and process jobs
npx @generacy-ai/generacy worker \
  --orchestrator http://localhost:3000 \
  --id worker-1

# With health check endpoint
npx @generacy-ai/generacy worker \
  --orchestrator http://localhost:3000 \
  --id worker-1 \
  --health-port 8080
```

### 3. Start as Agent (Full Autonomous Mode)

```bash
# Worker + Agency MCP integration
npx @generacy-ai/generacy agent \
  --orchestrator http://localhost:3000 \
  --id agent-1

# With Agency running as network service
npx @generacy-ai/generacy agent \
  --orchestrator http://localhost:3000 \
  --id agent-1 \
  --agency-mode network \
  --agency-url http://localhost:3001
```

## CLI Reference

### Global Options

```
Options:
  -V, --version          Output version number
  -h, --help             Display help
  --log-level <level>    Log level: debug, info, warn, error (default: info)
  --log-format <format>  Output format: json, pretty (default: pretty)
```

### `run` Command

Execute a workflow file directly.

```
Usage: generacy run [options] <workflow>

Arguments:
  workflow               Path to workflow YAML file

Options:
  -i, --input <key=value>  Input variables (can be repeated)
  -w, --workdir <path>     Working directory (default: current)
  -t, --timeout <duration> Maximum execution time (default: 30m)
  -n, --dry-run            Validate without executing
  -h, --help               Display help
```

**Examples:**

```bash
# Basic execution
generacy run workflows/build.yaml

# With multiple inputs
generacy run workflows/deploy.yaml \
  -i environment=staging \
  -i version=1.2.3 \
  -i notify=true

# Set working directory
generacy run workflows/test.yaml --workdir /app

# Timeout after 10 minutes
generacy run workflows/long-task.yaml --timeout 10m
```

### `worker` Command

Connect to orchestrator and process jobs from queue.

```
Usage: generacy worker [options]

Options:
  -o, --orchestrator <url>   Orchestrator URL (required)
  --id <worker-id>           Worker identifier (default: auto-generated)
  --poll-interval <ms>       Job polling interval (default: 5000)
  --health-port <port>       Health check HTTP port
  -h, --help                 Display help
```

**Examples:**

```bash
# Basic worker
generacy worker --orchestrator http://orchestrator:3000

# Named worker with health check
generacy worker \
  --orchestrator http://orchestrator:3000 \
  --id worker-pod-abc123 \
  --health-port 8080

# Custom poll interval (10 seconds)
generacy worker \
  --orchestrator http://orchestrator:3000 \
  --poll-interval 10000
```

### `agent` Command

Worker with Agency MCP integration for tool access.

```
Usage: generacy agent [options]

Options:
  -o, --orchestrator <url>   Orchestrator URL (required)
  --id <agent-id>            Agent identifier (default: auto-generated)
  --poll-interval <ms>       Job polling interval (default: 5000)
  --health-port <port>       Health check HTTP port
  --agency-mode <mode>       Agency connection: subprocess, network (default: subprocess)
  --agency-url <url>         Agency URL (for network mode)
  -h, --help                 Display help
```

**Examples:**

```bash
# Agent with subprocess Agency (default)
generacy agent --orchestrator http://orchestrator:3000

# Agent with network Agency
generacy agent \
  --orchestrator http://orchestrator:3000 \
  --agency-mode network \
  --agency-url http://agency:3001

# Full configuration
generacy agent \
  --orchestrator http://orchestrator:3000 \
  --id agent-001 \
  --health-port 8080 \
  --agency-mode subprocess
```

## Environment Variables

Configure via environment variables (useful for containers):

| Variable | Description | Default |
|----------|-------------|---------|
| `GENERACY_ORCHESTRATOR_URL` | Orchestrator URL | - |
| `GENERACY_WORKER_ID` | Worker/agent identifier | auto |
| `GENERACY_POLL_INTERVAL` | Job polling interval (ms) | 5000 |
| `GENERACY_HEALTH_PORT` | Health check port | - |
| `GENERACY_AGENCY_MODE` | Agency mode | subprocess |
| `GENERACY_AGENCY_URL` | Agency URL (network mode) | - |
| `GENERACY_LOG_LEVEL` | Log level | info |
| `GENERACY_LOG_FORMAT` | Log format | pretty |

## Docker Usage

### Basic Worker Container

```dockerfile
FROM node:20-slim
RUN npm install -g @generacy-ai/generacy
ENTRYPOINT ["generacy", "worker"]
```

```bash
docker run -e GENERACY_ORCHESTRATOR_URL=http://host:3000 generacy-worker
```

### Agent Container with Agency

```dockerfile
FROM node:20-slim
RUN npm install -g @generacy-ai/generacy @generacy-ai/agency
ENTRYPOINT ["generacy", "agent"]
```

### Kubernetes Health Probes

```yaml
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: generacy-worker
    image: generacy-worker:latest
    env:
    - name: GENERACY_ORCHESTRATOR_URL
      value: "http://orchestrator:3000"
    - name: GENERACY_HEALTH_PORT
      value: "8080"
    livenessProbe:
      httpGet:
        path: /health
        port: 8080
      initialDelaySeconds: 10
      periodSeconds: 30
    readinessProbe:
      httpGet:
        path: /health
        port: 8080
      initialDelaySeconds: 5
      periodSeconds: 10
```

## Workflow File Format

Workflows are defined in YAML:

```yaml
name: example-workflow
version: "1.0.0"
description: Example workflow demonstrating features

inputs:
  - name: issueUrl
    type: string
    required: true
    description: GitHub issue URL to process

phases:
  - id: setup
    name: Setup Phase
    steps:
      - id: checkout
        name: Checkout repository
        uses: workspace.prepare
        with:
          branch: feature/issue-${inputs.issueUrl | extractIssueNumber}

      - id: analyze
        name: Analyze issue
        uses: agent.invoke
        with:
          prompt: "Analyze the GitHub issue at ${inputs.issueUrl}"
        timeout: 5m
        retry:
          maxAttempts: 3
          backoff:
            type: exponential
            initialDelay: 10s
            multiplier: 2

  - id: implementation
    name: Implementation Phase
    condition: steps.analyze.output.complexity != 'trivial'
    steps:
      - id: implement
        name: Implement changes
        uses: agent.invoke
        with:
          prompt: "Implement the solution based on: ${steps.analyze.output}"
        timeout: 15m

outputs:
  - name: result
    value: ${steps.implement.output}
```

## Troubleshooting

### Connection Issues

```bash
# Check orchestrator connectivity
curl http://orchestrator:3000/health

# Enable debug logging
generacy worker --orchestrator http://host:3000 --log-level debug
```

### Health Check Not Responding

```bash
# Verify health port
curl http://localhost:8080/health

# Check if port is in use
lsof -i :8080
```

### Workflow Execution Failures

```bash
# Run with dry-run to validate
generacy run workflow.yaml --dry-run

# Check workflow syntax
cat workflow.yaml | yq .  # Validate YAML

# Enable debug logs
generacy run workflow.yaml --log-level debug
```

### Agency Connection Issues

```bash
# Subprocess mode - check Agency is installed
npx @generacy-ai/agency --version

# Network mode - check Agency is running
curl http://localhost:3001/health
```

---

*Generated by speckit*
