# Data Model: Fix launch CLI scaffolder

## Core Interfaces

### ScaffoldComposeInput (extended)

```typescript
// packages/generacy/src/cli/commands/cluster/scaffolder.ts

export interface ScaffoldComposeInput {
  // Existing fields
  imageTag: string;
  clusterId: string;
  projectId: string;
  projectName: string;
  cloudUrl: string;              // HTTP base URL from LaunchConfig
  variant: 'cluster-base' | 'cluster-microservices';
  deploymentMode?: 'local' | 'cloud';  // default: 'local'

  // New fields
  orgId: string;
  workers?: number;              // default: 1
  channel?: 'stable' | 'preview'; // default: 'preview'
  repoUrl?: string;              // from LaunchConfig.repos.primary
  claudeConfigMode?: 'bind' | 'volume'; // default: 'bind'
}
```

### ScaffoldEnvInput

```typescript
// packages/generacy/src/cli/commands/cluster/scaffolder.ts

export interface ScaffoldEnvInput {
  // Identity (from cloud, not user-editable)
  clusterId: string;
  projectId: string;
  orgId: string;
  cloudUrl: string;              // HTTP base URL — deriveRelayUrl() converts to wss

  // Project (from cloud, user may override)
  projectName: string;
  repoUrl?: string;
  repoBranch?: string;           // default: 'main'
  channel?: 'stable' | 'preview'; // default: 'preview'
  workers?: number;              // default: 1

  // Runtime defaults
  orchestratorPort?: number;     // default: 3100
}
```

## Generated File Structures

### docker-compose.yml (multi-service)

```yaml
name: <sanitized-project-name>

services:
  orchestrator:
    image: <imageTag>
    command: /usr/local/bin/entrypoint-orchestrator.sh
    restart: unless-stopped
    ports:
      - "${ORCHESTRATOR_PORT:-3100}:3100"  # or ephemeral for local
    volumes:
      - workspace:/workspaces
      - ~/.claude.json:/home/node/.claude.json  # or claude-config volume
      - shared-packages:/home/node/.local/share/generacy/packages
      - npm-cache:/home/node/.npm
      - generacy-data:/var/lib/generacy
      - /var/run/docker.sock:/var/run/docker-host.sock
    tmpfs:
      - /run/generacy-credhelper:uid=1002
      - /run/generacy-control-plane:uid=1000
    environment:
      - REDIS_URL=redis://redis:6379
      - REDIS_HOST=redis
      - DEPLOYMENT_MODE=local
      - CLUSTER_VARIANT=cluster-base
    env_file:
      - path: .env
      - path: .env.local
        required: false
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:3100/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    depends_on:
      redis:
        condition: service_healthy
    stop_grace_period: 30s
    extra_hosts:
      - "host.docker.internal:host-gateway"
    networks:
      - cluster-network

  worker:
    image: <imageTag>
    command: /usr/local/bin/entrypoint-worker.sh
    restart: unless-stopped
    deploy:
      replicas: ${WORKER_COUNT:-1}
    volumes:
      - workspace:/workspaces
      - ~/.claude.json:/home/node/.claude.json  # or claude-config volume
      - shared-packages:/home/node/.local/share/generacy/packages
      - npm-cache:/home/node/.npm
      - generacy-data:/var/lib/generacy
    tmpfs:
      - /run/generacy-credhelper:uid=1002
      - /run/generacy-control-plane:uid=1000
    environment:
      - REDIS_URL=redis://redis:6379
      - REDIS_HOST=redis
      - HEALTH_PORT=9001
      - DEPLOYMENT_MODE=local
      - CLUSTER_VARIANT=cluster-base
    env_file:
      - path: .env
      - path: .env.local
        required: false
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:9001/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    depends_on:
      orchestrator:
        condition: service_healthy
    stop_grace_period: 30s
    extra_hosts:
      - "host.docker.internal:host-gateway"
    networks:
      - cluster-network

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    volumes:
      - redis-data:/data
    networks:
      - cluster-network

volumes:
  workspace:
  shared-packages:
  npm-cache:
  generacy-data:
  redis-data:
  # claude-config only present when claudeConfigMode === 'volume'

networks:
  cluster-network:
    driver: bridge
```

### .env (generated)

```bash
# Identity (from cloud LaunchConfig — do not edit)
GENERACY_CLUSTER_ID=abc123
GENERACY_PROJECT_ID=proj456
GENERACY_ORG_ID=org789
GENERACY_CLOUD_URL=wss://api.generacy.ai/relay?projectId=proj456

# Project
PROJECT_NAME=my-project
REPO_URL=https://github.com/org/repo
REPO_BRANCH=main
GENERACY_CHANNEL=preview
WORKER_COUNT=1

# Cluster runtime
ORCHESTRATOR_PORT=3100
LABEL_MONITOR_ENABLED=true
WEBHOOK_SETUP_ENABLED=true
SKIP_PACKAGE_UPDATE=false
SMEE_CHANNEL_URL=
```

## Relay URL Derivation

```
Input:  cloudUrl = "https://api.generacy.ai", projectId = "proj456"
Output: "wss://api.generacy.ai/relay?projectId=proj456"

Input:  cloudUrl = "https://api-staging.generacy.ai", projectId = "proj456"
Output: "wss://api-staging.generacy.ai/relay?projectId=proj456"

Input:  cloudUrl = "http://localhost:3001", projectId = "proj456"
Output: "ws://localhost:3001/relay?projectId=proj456"
```

## Volume Mount Differences by Mode

| Volume | Launch (local) | Deploy (cloud) |
|--------|---------------|----------------|
| `workspace` | Named volume → `/workspaces` | Named volume → `/workspaces` |
| Claude config | Bind: `~/.claude.json` → `/home/node/.claude.json` | Named: `claude-config` → `/home/node/.claude.json` |
| `shared-packages` | Named volume | Named volume |
| `npm-cache` | Named volume | Named volume |
| `generacy-data` | Named volume → `/var/lib/generacy` | Named volume → `/var/lib/generacy` |
| Docker socket | Bind: `/var/run/docker.sock` → `/var/run/docker-host.sock` | Bind: `/var/run/docker.sock` → `/var/run/docker-host.sock` |
| `redis-data` | Named volume → `/data` | Named volume → `/data` |

## Validation Rules

- `clusterId`, `projectId`, `orgId` must be non-empty strings
- `cloudUrl` must be a valid URL (http or https)
- `variant` must be `'cluster-base'` or `'cluster-microservices'`
- `workers` must be a positive integer (default 1)
- `channel` must be `'stable'` or `'preview'`
- Project name is sanitized for Docker Compose via `sanitizeComposeProjectName()`
