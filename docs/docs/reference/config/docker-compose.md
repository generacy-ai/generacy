---
sidebar_position: 6
---

# Docker Compose Configuration Reference

Complete reference for the Docker Compose files used to run Generacy services.

## Compose Files

Generacy ships three Docker Compose files, each targeting a different use case:

| File | Purpose | Services |
|------|---------|----------|
| `docker-compose.yml` | Full stack — orchestrator, workers, and Redis | orchestrator, worker, redis |
| `docker-compose.override.yml` | Development overrides — hot reload and dev builds | orchestrator, worker |
| `docker/docker-compose.worker.yml` | Standalone worker — connects to an existing Redis | worker, redis |

The main `docker-compose.yml` and `docker-compose.override.yml` are used together by default. Docker Compose automatically merges the override file when you run `docker compose up` from the repository root. The standalone worker file is invoked explicitly with `-f`:

```bash
# Full stack (main + override merged automatically)
docker compose up

# Full stack without dev overrides
docker compose -f docker-compose.yml up

# Standalone worker only
docker compose -f docker/docker-compose.worker.yml up
```

## Services

### orchestrator

The orchestrator service runs the Generacy task dispatcher. It polls GitHub for labeled issues, manages the task queue in Redis, and dispatches work to workers.

```yaml title="docker-compose.yml"
orchestrator:
  build:
    context: .
    dockerfile: services/orchestrator/Dockerfile
  ports:
    - "3000:3000"
  environment:
    - NODE_ENV=development
    - REDIS_URL=redis://redis:6379
    - LOG_LEVEL=debug
  depends_on:
    - redis
  volumes:
    - ./services/orchestrator/src:/app/src:ro
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
    interval: 30s
    timeout: 10s
    retries: 3
```

| Property | Value | Description |
|----------|-------|-------------|
| `build.context` | `.` | Repository root |
| `build.dockerfile` | `services/orchestrator/Dockerfile` | Multi-stage Dockerfile |
| `ports` | `3000:3000` | HTTP API and health endpoint |
| `depends_on` | `redis` | Waits for Redis to start |
| `volumes` | `./services/orchestrator/src:/app/src:ro` | Source mount (read-only) for live updates |

#### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Node environment |
| `REDIS_URL` | `redis://redis:6379` | Redis connection URL (uses the `redis` service hostname) |
| `LOG_LEVEL` | `debug` | Log verbosity |

For the full list of orchestrator environment variables, see [Environment Variables](/docs/reference/config/environment-variables).

#### Health check

| Property | Value |
|----------|-------|
| `test` | `curl -f http://localhost:3000/health` |
| `interval` | 30s |
| `timeout` | 10s |
| `retries` | 3 |

### worker

The worker service executes tasks dispatched by the orchestrator. By default, two replicas are started.

```yaml title="docker-compose.yml"
worker:
  build:
    context: .
    dockerfile: services/worker/Dockerfile
  environment:
    - NODE_ENV=development
    - REDIS_URL=redis://redis:6379
    - ORCHESTRATOR_URL=http://orchestrator:3000
    - LOG_LEVEL=debug
  depends_on:
    - redis
    - orchestrator
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
    - ./services/worker/src:/app/src:ro
  deploy:
    replicas: 2
```

| Property | Value | Description |
|----------|-------|-------------|
| `build.context` | `.` | Repository root |
| `build.dockerfile` | `services/worker/Dockerfile` | Multi-stage Dockerfile |
| `depends_on` | `redis`, `orchestrator` | Waits for both services to start |
| `deploy.replicas` | `2` | Number of worker instances |
| `volumes` | `/var/run/docker.sock` | Docker socket mount for Docker-outside-of-Docker (DooD) |

#### Docker socket mount

The worker mounts the host Docker socket at `/var/run/docker.sock`. This allows workers to spawn isolated containers for task execution (the Docker-outside-of-Docker pattern). The host Docker daemon manages all containers.

:::warning

The Docker socket mount grants the worker container full access to the host Docker daemon. In production, consider restricting access with a Docker socket proxy.

:::

#### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Node environment |
| `REDIS_URL` | `redis://redis:6379` | Redis connection URL |
| `ORCHESTRATOR_URL` | `http://orchestrator:3000` | Orchestrator API URL (uses the `orchestrator` service hostname) |
| `LOG_LEVEL` | `debug` | Log verbosity |

### redis

Redis provides the task queue and inter-service communication layer.

```yaml title="docker-compose.yml"
redis:
  image: redis:7-alpine
  ports:
    - "6379:6379"
  volumes:
    - redis-data:/data
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 10s
    timeout: 5s
    retries: 5
```

| Property | Value | Description |
|----------|-------|-------------|
| `image` | `redis:7-alpine` | Alpine-based Redis 7 image |
| `ports` | `6379:6379` | Default Redis port, exposed to the host |
| `volumes` | `redis-data:/data` | Named volume for data persistence |

#### Health check

| Property | Value |
|----------|-------|
| `test` | `redis-cli ping` |
| `interval` | 10s |
| `timeout` | 5s |
| `retries` | 5 |

## Network

All services share a single bridge network:

```yaml title="docker-compose.yml"
networks:
  default:
    name: generacy-network
```

By naming the default network `generacy-network`, services resolve each other by service name. The orchestrator is reachable at `orchestrator:3000`, Redis at `redis:6379`, and so on.

## Volumes

```yaml title="docker-compose.yml"
volumes:
  redis-data:
```

| Volume | Mount Point | Description |
|--------|-------------|-------------|
| `redis-data` | `/data` (in redis container) | Persists Redis data across container restarts |

## Startup Order and Dependencies

Docker Compose starts services in dependency order:

```
redis ─→ orchestrator ─→ worker
```

1. **redis** starts first (no dependencies)
2. **orchestrator** starts after redis is running
3. **worker** starts after both redis and orchestrator are running

The orchestrator health check (`curl -f http://localhost:3000/health`) confirms the HTTP server is accepting requests. The redis health check (`redis-cli ping`) confirms Redis is ready for connections. Workers depend on both services but do not define their own health check in the main compose file.

:::note

The `depends_on` directive ensures start **order**, not readiness. For readiness-based startup, use `depends_on` with `condition: service_healthy` as shown in the standalone worker file.

:::

## Development Overrides

The `docker-compose.override.yml` file is merged automatically when running `docker compose up`. It configures development-mode builds and hot reload:

```yaml title="docker-compose.override.yml"
services:
  orchestrator:
    build:
      target: development
    volumes:
      - ./services/orchestrator:/app
    command: npm run dev

  worker:
    build:
      target: development
    volumes:
      - ./services/worker:/app
    command: npm run dev
```

| Override | Effect |
|----------|--------|
| `build.target: development` | Uses the `development` stage of the multi-stage Dockerfile (includes dev dependencies) |
| `volumes: ./services/{service}:/app` | Mounts the full service directory (replaces the read-only `src` mount from the main file) |
| `command: npm run dev` | Runs the dev server with file watching instead of the production entrypoint |

To run without development overrides (e.g., to test the production build locally):

```bash
docker compose -f docker-compose.yml up
```

## Standalone Worker

The `docker/docker-compose.worker.yml` file runs a single worker with its own Redis instance, independent of the orchestrator. This is useful for running additional workers on separate machines.

```yaml title="docker/docker-compose.worker.yml"
services:
  worker:
    build:
      context: ..
      dockerfile: docker/worker/Dockerfile
    container_name: generacy-worker
    restart: unless-stopped
    environment:
      - NODE_ENV=development
      - WORKER_ID=worker-local-1
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - HEALTH_PORT=3001
      - HEARTBEAT_ENABLED=true
      - HEARTBEAT_INTERVAL=5000
      - POLL_INTERVAL=1000
      - GRACEFUL_SHUTDOWN_TIMEOUT=60000
    ports:
      - "3001:3001"
    depends_on:
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:3001/health/live"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
    networks:
      - generacy-network

  redis:
    image: redis:7-alpine
    container_name: generacy-redis
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3
    networks:
      - generacy-network

volumes:
  redis-data:

networks:
  generacy-network:
    driver: bridge
```

### Differences from main compose

| Aspect | Main compose | Standalone worker |
|--------|-------------|-------------------|
| Redis connection | `REDIS_URL=redis://redis:6379` | `REDIS_HOST=redis` + `REDIS_PORT=6379` (split variables) |
| Health endpoint | No worker health check | `wget http://localhost:3001/health/live` on port 3001 |
| Startup | `depends_on: [redis, orchestrator]` | `depends_on.redis.condition: service_healthy` (readiness-based) |
| Restart policy | None (default) | `unless-stopped` |
| Container names | Auto-generated | Explicit: `generacy-worker`, `generacy-redis` |
| Network | Named default network | Explicit `generacy-network` bridge |

### Worker environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_ID` | `worker-local-1` | Unique worker identifier |
| `REDIS_HOST` | `redis` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `HEALTH_PORT` | `3001` | Worker health check port |
| `HEARTBEAT_ENABLED` | `true` | Send heartbeats to Redis |
| `HEARTBEAT_INTERVAL` | `5000` | Heartbeat interval in milliseconds |
| `POLL_INTERVAL` | `1000` | Job poll interval in milliseconds |
| `GRACEFUL_SHUTDOWN_TIMEOUT` | `60000` | Shutdown grace period in milliseconds |

For the full list of worker environment variables, see [Environment Variables](/docs/reference/config/environment-variables#worker).

## Common Customizations

### Scaling workers

Increase the number of worker replicas:

```yaml title="docker-compose.override.yml"
services:
  worker:
    deploy:
      replicas: 5
```

Or scale at runtime:

```bash
docker compose up --scale worker=5
```

### Changing ports

Remap ports to avoid conflicts with other services:

```yaml title="docker-compose.override.yml"
services:
  orchestrator:
    ports:
      - "8080:3000"  # Host port 8080 → container port 3000
  redis:
    ports:
      - "6380:6379"  # Host port 6380 → container port 6379
```

Update `REDIS_URL` if the orchestrator or workers need to connect via the remapped host port.

### Using an external Redis

Connect to an existing Redis instance instead of the bundled one:

```yaml title="docker-compose.override.yml"
services:
  orchestrator:
    environment:
      - REDIS_URL=redis://your-redis-host:6379
    depends_on: []  # Remove redis dependency

  worker:
    environment:
      - REDIS_URL=redis://your-redis-host:6379
    depends_on:
      - orchestrator  # Keep orchestrator, remove redis
```

Then start without the redis service:

```bash
docker compose up orchestrator worker
```

### Adding custom volumes

Mount additional directories for worker access:

```yaml title="docker-compose.override.yml"
services:
  worker:
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./custom-config:/app/config:ro
      - worker-logs:/app/logs

volumes:
  worker-logs:
```

### Production configuration

For production, skip the override file and set production environment variables:

```bash
docker compose -f docker-compose.yml up -d
```

```yaml title="docker-compose.production.yml"
services:
  orchestrator:
    environment:
      - NODE_ENV=production
      - REDIS_URL=redis://redis:6379
      - LOG_LEVEL=info
    restart: unless-stopped

  worker:
    environment:
      - NODE_ENV=production
      - REDIS_URL=redis://redis:6379
      - LOG_LEVEL=info
    restart: unless-stopped
    deploy:
      replicas: 3

  redis:
    restart: unless-stopped
```

## See Also

- [Orchestrator Configuration](/docs/reference/config/orchestrator) — Full orchestrator config schema
- [Environment Variables](/docs/reference/config/environment-variables) — All environment variables reference
- [Generacy Configuration](/docs/reference/config/generacy) — Project-level `.generacy/config.yaml` settings
- [CLI Commands](/docs/reference/cli/commands) — `generacy worker` starts a standalone worker process
