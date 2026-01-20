# Implementation Plan: Docker Compose Local Development Setup

**Feature**: Docker Compose configuration for local development environment
**Branch**: `010-docker-compose-local-development`
**Status**: Complete

## Summary

Create a Docker Compose configuration that orchestrates the Generacy services (orchestrator, worker) along with Redis for local development. This setup enables developers to quickly spin up the complete stack with hot reload support, proper networking, health checks, and volume mounts for source code.

## Technical Context

| Aspect | Details |
|--------|---------|
| Docker Compose | v3.8 format (supports deploy.replicas for worker scaling) |
| Services | Orchestrator (#8), Worker (#9), Redis |
| Base Images | Node.js 20 (services), Redis 7 Alpine |
| Development Mode | Multi-stage Dockerfile with development target |
| Hot Reload | nodemon/tsx watch with volume mounts |
| Networking | Custom bridge network (generacy-network) |

## Project Structure

```text
/
├── docker-compose.yml              # Main compose file
├── docker-compose.override.yml     # Development overrides (auto-loaded)
├── .env.example                    # Environment template
├── scripts/
│   ├── start-local.sh             # Start all services
│   ├── stop-local.sh              # Stop all services
│   ├── logs.sh                    # View service logs
│   └── reset.sh                   # Reset volumes and restart
├── services/
│   ├── orchestrator/
│   │   └── Dockerfile             # Multi-stage Dockerfile
│   └── worker/
│       └── Dockerfile             # Multi-stage Dockerfile
```

## Architecture

### Service Topology

```
┌────────────────────────────────────────────────────────────────┐
│                    Docker Compose Stack                         │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                 generacy-network (bridge)                │   │
│  │                                                          │   │
│  │  ┌──────────────────┐         ┌──────────────────┐      │   │
│  │  │   Orchestrator   │         │      Redis       │      │   │
│  │  │   (Fastify API)  │────────▶│   (7-alpine)     │      │   │
│  │  │   :3000          │         │   :6379          │      │   │
│  │  └────────┬─────────┘         └──────────────────┘      │   │
│  │           │                            ▲                 │   │
│  │           │                            │                 │   │
│  │           ▼                            │                 │   │
│  │  ┌──────────────────┐                  │                 │   │
│  │  │     Worker       │──────────────────┘                 │   │
│  │  │   (replicas: 2)  │                                    │   │
│  │  │   :3001 (health) │                                    │   │
│  │  └──────────────────┘                                    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Host Ports:                                                    │
│    - 3000 → orchestrator (API)                                  │
│    - 6379 → redis (debugging)                                   │
└────────────────────────────────────────────────────────────────┘
```

### Container Dependency Flow

```
redis
   │
   ├──▶ orchestrator (depends_on: redis)
   │         │
   │         └──▶ worker (depends_on: redis, orchestrator)
   │                  │
   │                  └── Mounts docker.sock for container ops
```

## Implementation Phases

### Phase 1: Docker Configuration Files

**Files**: `docker-compose.yml`, `docker-compose.override.yml`

- Main compose file with production-ready defaults
- Override file auto-loaded for development (volume mounts, dev commands)
- Health checks for all services
- Proper dependency ordering

### Phase 2: Service Dockerfiles

**Files**: `services/orchestrator/Dockerfile`, `services/worker/Dockerfile`

- Multi-stage builds (development, production targets)
- Node.js 20 base image
- npm ci for reproducible installs
- Non-root user for security

### Phase 3: Development Scripts

**Files**: `scripts/*.sh`

- start-local.sh: docker-compose up with status messages
- stop-local.sh: clean shutdown
- logs.sh: follow logs for specific or all services
- reset.sh: volume cleanup and fresh start

### Phase 4: Environment Configuration

**Files**: `.env.example`

- Template with all configurable environment variables
- Sensible defaults for local development
- Documentation comments for each variable

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Compose v3.8 format | Supports deploy.replicas for worker scaling |
| Development override | Automatic loading of dev settings without modifying base config |
| Volume mounts (ro) | Read-only source mounts prevent accidental container writes |
| Redis Alpine | Smaller image size, sufficient for development |
| Docker socket mount | Worker needs access to spawn agent containers |
| Named volume for Redis | Persist data between restarts |
| Health checks | Enable proper startup ordering and monitoring |

## Service Configuration

### Orchestrator Service

| Setting | Value | Notes |
|---------|-------|-------|
| Port | 3000:3000 | Exposed to host |
| Environment | NODE_ENV=development | |
| Redis | redis://redis:6379 | Docker internal DNS |
| Health Check | curl localhost:3000/health | 30s interval |
| Volumes | ./services/orchestrator/src:/app/src:ro | Read-only mount |

### Worker Service

| Setting | Value | Notes |
|---------|-------|-------|
| Replicas | 2 | Via deploy.replicas |
| Port | None exposed | Health on 3001 internal |
| Docker Socket | /var/run/docker.sock | For container ops |
| Orchestrator URL | http://orchestrator:3000 | Service discovery |
| Volumes | ./services/worker/src:/app/src:ro | Read-only mount |

### Redis Service

| Setting | Value | Notes |
|---------|-------|-------|
| Image | redis:7-alpine | Official Alpine image |
| Port | 6379:6379 | Exposed for debugging |
| Volume | redis-data:/data | Named persistent volume |
| Health Check | redis-cli ping | 10s interval |

## Development Workflow

### Starting Development

```bash
# Copy environment template
cp .env.example .env

# Start all services (detached)
./scripts/start-local.sh

# View logs
./scripts/logs.sh
./scripts/logs.sh orchestrator  # specific service
```

### Hot Reload

```
┌─────────────────────────────────────────────────────────────┐
│   Edit src/*.ts on host                                     │
│        │                                                    │
│        ▼                                                    │
│   Volume mount syncs change to container                    │
│        │                                                    │
│        ▼                                                    │
│   nodemon/tsx detects change                                │
│        │                                                    │
│        ▼                                                    │
│   Service restarts with new code                            │
└─────────────────────────────────────────────────────────────┘
```

### Stopping and Cleanup

```bash
# Stop services (preserves volumes)
./scripts/stop-local.sh

# Full reset (removes volumes)
./scripts/reset.sh
```

## Dependencies

This feature depends on:
- **#8 Orchestrator service**: Dockerfile in `services/orchestrator/`
- **#9 Worker service**: Dockerfile in `services/worker/`

Both services must have:
- Multi-stage Dockerfile with `development` target
- `npm run dev` script for hot reload
- `/health` endpoint for health checks

## Verification Checklist

- [ ] `docker-compose up` starts all services without errors
- [ ] Services can communicate (worker → orchestrator → redis)
- [ ] Hot reload works: edit src file → service restarts
- [ ] Volume mounts reflect source code changes
- [ ] Health checks pass for all services
- [ ] `docker-compose down` cleanly shuts down all services
- [ ] `docker-compose down -v` removes persistent volumes
- [ ] Worker replicas both receive jobs
- [ ] Environment variables properly passed to services

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| REDIS_URL | redis://localhost:6379 | Redis connection string |
| ORCHESTRATOR_PORT | 3000 | API server port |
| LOG_LEVEL | info | Logging verbosity |
| WORKER_CONCURRENCY | 2 | Jobs per worker |
| API_KEY | your-api-key-here | Development API key |
| GITHUB_TOKEN | your-github-token | GitHub integration |

## Next Steps

Run `/speckit:tasks` to generate detailed task list from this plan.

---

*Generated by speckit*
