# Research: Docker Compose Local Development Setup

## Technology Decisions

### Docker Compose Version Format

**Decision**: Use Compose file format v3.8

**Rationale**:
- Supports `deploy.replicas` for worker scaling
- Compatible with Docker Engine 19.03+
- Mature, well-documented format
- Supports all required features (health checks, networks, volumes)

**Alternatives Considered**:
- v2.x: Lacks deploy options for scaling
- v3.9+: Newer but no additional features needed

### Base Images

**Decision**: Node.js 20 LTS + Redis 7 Alpine

**Rationale**:
- Node.js 20 is current LTS with best performance
- Alpine variants minimize image size (~150MB vs ~1GB)
- Redis 7 provides latest features and performance improvements
- Official images ensure security updates

### Multi-Stage Dockerfile Pattern

**Decision**: Use multi-stage builds with `development` and `production` targets

```dockerfile
# Stage 1: Base with dependencies
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Stage 2: Development (includes devDependencies)
FROM base AS development
RUN npm ci --include=dev
COPY . .
CMD ["npm", "run", "dev"]

# Stage 3: Production (optimized)
FROM base AS production
COPY . .
RUN npm run build
CMD ["node", "dist/index.js"]
```

**Benefits**:
- Development and production from same Dockerfile
- Smaller production images (no devDependencies)
- Consistent build process

### Volume Mount Strategy

**Decision**: Read-only source mounts with full mounts in override

**Base compose** (`docker-compose.yml`):
```yaml
volumes:
  - ./services/orchestrator/src:/app/src:ro
```

**Override for dev** (`docker-compose.override.yml`):
```yaml
volumes:
  - ./services/orchestrator:/app  # Full mount for nodemon
```

**Rationale**:
- Base config uses `:ro` for safety in non-development environments
- Override removes `:ro` and mounts full directory for hot reload
- Prevents accidental writes to host from container

### Health Check Configuration

**Decision**: HTTP health checks for services, TCP for Redis

| Service | Method | Interval | Timeout | Retries |
|---------|--------|----------|---------|---------|
| Orchestrator | HTTP /health | 30s | 10s | 3 |
| Worker | HTTP /health | 30s | 10s | 3 |
| Redis | redis-cli ping | 10s | 5s | 5 |

**Rationale**:
- HTTP checks validate actual service functionality
- Shorter intervals for Redis (critical dependency)
- Retries prevent false positives during startup

### Network Configuration

**Decision**: Named bridge network (`generacy-network`)

```yaml
networks:
  default:
    name: generacy-network
```

**Benefits**:
- Predictable network name for debugging
- Services resolve by container name
- Isolated from other Docker networks
- Easy to inspect: `docker network inspect generacy-network`

### Docker Socket Access

**Decision**: Mount docker.sock for worker service only

```yaml
worker:
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
```

**Security Considerations**:
- Required for worker to spawn agent containers
- Creates elevated privilege (effectively root access)
- Acceptable for development; review for production
- Alternative: Docker-in-Docker (more isolation, more complexity)

## Implementation Patterns

### Service Discovery Pattern

Services use Docker's internal DNS:

```
Orchestrator URL: http://orchestrator:3000
Redis URL:        redis://redis:6379
```

No hardcoded IPs or `links` directive needed.

### Dependency Ordering Pattern

Use `depends_on` with health conditions:

```yaml
orchestrator:
  depends_on:
    redis:
      condition: service_healthy

worker:
  depends_on:
    redis:
      condition: service_healthy
    orchestrator:
      condition: service_healthy
```

**Note**: In Compose v3.x without Swarm, `condition` is not supported. Use simple array format and rely on health checks for ready state.

### Environment Variable Management

**Pattern**: `.env.example` + `.env` (gitignored)

```bash
# .env.example - committed to git
REDIS_URL=redis://localhost:6379
API_KEY=your-api-key-here

# .env - local overrides, not committed
```

**Benefits**:
- Template documents all variables
- Local values stay private
- CI/CD can use different env files

### Script Pattern

**Pattern**: Wrapper scripts in `scripts/` directory

```bash
#!/bin/bash
set -e  # Exit on error

# Color output
GREEN='\033[0;32m'
NC='\033[0m'

docker-compose up -d
echo -e "${GREEN}Services starting...${NC}"
```

**Benefits**:
- Consistent interface across team
- Can add logging, timing, status messages
- Hides complex docker-compose flags

## Key Sources

1. **Docker Compose Documentation**: https://docs.docker.com/compose/
2. **Docker Best Practices**: https://docs.docker.com/develop/develop-images/dockerfile_best-practices/
3. **Node.js Docker Guide**: https://nodejs.org/en/docs/guides/nodejs-docker-webapp/
4. **Redis Docker Hub**: https://hub.docker.com/_/redis

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Volume sync performance (macOS) | Medium | Low | Use delegated/cached mounts |
| Port conflicts | Low | Medium | Document port requirements |
| Docker socket security | Medium | High | Document risks, limit to dev |
| Network conflicts | Low | Low | Named network avoids clashes |

---

*Generated by speckit*
