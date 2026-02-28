# T003: Docker Compose Files Catalog

Research output for task T003. This file catalogs all services, ports, volumes, environment variables, health checks, and networks from the three Docker Compose files, notes differences between them, and documents the `generacy-network` bridge network.

---

## Source Files

| File | Purpose | Compose Version |
|------|---------|-----------------|
| `docker-compose.yml` | Main production/default compose | Implicit (v3+) |
| `docker-compose.override.yml` | Development overrides (auto-merged by Docker Compose) | Implicit (v3+) |
| `docker/docker-compose.worker.yml` | Standalone worker for local development | Explicit `3.8` |

---

## 1. Main Compose: `docker-compose.yml`

### Services

#### `orchestrator`

| Property | Value |
|----------|-------|
| **Build context** | `.` (project root) |
| **Dockerfile** | `services/orchestrator/Dockerfile` |
| **Ports** | `3000:3000` (host:container) |
| **Depends on** | `redis` |
| **Volumes** | `./services/orchestrator/src:/app/src:ro` (read-only source mount) |

**Environment variables:**

| Variable | Value | Description |
|----------|-------|-------------|
| `NODE_ENV` | `development` | Node environment |
| `REDIS_URL` | `redis://redis:6379` | Redis connection using Docker service name |
| `LOG_LEVEL` | `debug` | Logging level |

**Health check:**

| Property | Value |
|----------|-------|
| Test command | `curl -f http://localhost:3000/health` |
| Interval | 30s |
| Timeout | 10s |
| Retries | 3 |
| Start period | Not set (default) |

---

#### `worker`

| Property | Value |
|----------|-------|
| **Build context** | `.` (project root) |
| **Dockerfile** | `services/worker/Dockerfile` |
| **Ports** | None exposed |
| **Depends on** | `redis`, `orchestrator` |
| **Volumes** | `/var/run/docker.sock:/var/run/docker.sock` (Docker socket mount), `./services/worker/src:/app/src:ro` (read-only source mount) |
| **Deploy replicas** | `2` |

**Environment variables:**

| Variable | Value | Description |
|----------|-------|-------------|
| `NODE_ENV` | `development` | Node environment |
| `REDIS_URL` | `redis://redis:6379` | Redis connection using Docker service name |
| `ORCHESTRATOR_URL` | `http://orchestrator:3000` | Orchestrator API using Docker service name |
| `LOG_LEVEL` | `debug` | Logging level |

**Health check:** None defined in compose (may rely on Dockerfile health check or none).

**Notable:** Worker mounts the Docker socket (`/var/run/docker.sock`) to allow container-in-container operations for job execution.

---

#### `redis`

| Property | Value |
|----------|-------|
| **Image** | `redis:7-alpine` |
| **Ports** | `6379:6379` (host:container) |
| **Volumes** | `redis-data:/data` (named volume for persistence) |

**Health check:**

| Property | Value |
|----------|-------|
| Test command | `redis-cli ping` |
| Interval | 10s |
| Timeout | 5s |
| Retries | 5 |
| Start period | Not set (default) |

---

### Named Volumes

| Volume | Used By | Mount Point | Description |
|--------|---------|-------------|-------------|
| `redis-data` | `redis` | `/data` | Persistent Redis data across restarts |

### Networks

| Network | Name | Driver |
|---------|------|--------|
| `default` | `generacy-network` | Default (bridge) |

The main compose renames the default network to `generacy-network`. All services automatically join this network. The driver is not explicitly set, so it defaults to `bridge`.

---

## 2. Dev Override: `docker-compose.override.yml`

This file is automatically merged with `docker-compose.yml` by Docker Compose when running `docker compose up` without `-f` flags.

### Orchestrator Overrides

| Property | Base Value | Override Value |
|----------|------------|----------------|
| Build target | Not set (default/final stage) | `development` |
| Volumes | `./services/orchestrator/src:/app/src:ro` | `./services/orchestrator:/app` (full directory, read-write) |
| Command | Not set (Dockerfile CMD) | `npm run dev` |

### Worker Overrides

| Property | Base Value | Override Value |
|----------|------------|----------------|
| Build target | Not set (default/final stage) | `development` |
| Volumes | Docker socket + `./services/worker/src:/app/src:ro` | Docker socket (inherited) + `./services/worker:/app` (full directory, read-write) |
| Command | Not set (Dockerfile CMD) | `npm run dev` |

### Key Differences from Base

1. **Build target**: Both services target the `development` stage of multi-stage Dockerfiles (includes dev dependencies, source maps, etc.)
2. **Volume mounts**: Override mounts the full service directory (`./services/<name>:/app`) instead of just the source subdirectory — enables hot reload of all files including `package.json`, config files, etc.
3. **Volume permissions**: Override removes the `:ro` (read-only) flag, allowing bidirectional file sync
4. **Command override**: Both services run `npm run dev` instead of the Dockerfile's default production CMD
5. **Redis**: Not overridden — runs identically in dev and base configurations

---

## 3. Standalone Worker: `docker/docker-compose.worker.yml`

This is an independent compose file for running a worker **without** the orchestrator. Must be invoked explicitly: `docker-compose -f docker/docker-compose.worker.yml up`.

### Worker Service

| Property | Value |
|----------|-------|
| **Build context** | `..` (project root, relative to `docker/`) |
| **Dockerfile** | `docker/worker/Dockerfile` |
| **Container name** | `generacy-worker` |
| **Restart policy** | `unless-stopped` |
| **Ports** | `3001:3001` (health check port) |
| **Depends on** | `redis` with `condition: service_healthy` |
| **Networks** | `generacy-network` (explicit) |

**Environment variables:**

| Variable | Value | Description |
|----------|-------|-------------|
| `NODE_ENV` | `development` | Node environment |
| `WORKER_ID` | `worker-local-1` | Static worker identifier |
| `REDIS_HOST` | `redis` | Redis host (service name) |
| `REDIS_PORT` | `6379` | Redis port |
| `HEALTH_PORT` | `3001` | Health check endpoint port |
| `HEARTBEAT_ENABLED` | `true` | Enable heartbeat reporting |
| `HEARTBEAT_INTERVAL` | `5000` | Heartbeat interval in ms |
| `POLL_INTERVAL` | `1000` | Job poll interval in ms |
| `GRACEFUL_SHUTDOWN_TIMEOUT` | `60000` | Graceful shutdown timeout in ms |

**Health check:**

| Property | Value |
|----------|-------|
| Test command | `wget --quiet --tries=1 --spider http://localhost:3001/health/live` |
| Interval | 30s |
| Timeout | 10s |
| Retries | 3 |
| Start period | 10s |

### Redis Service (Standalone)

| Property | Value |
|----------|-------|
| **Image** | `redis:7-alpine` |
| **Container name** | `generacy-redis` |
| **Restart policy** | `unless-stopped` |
| **Ports** | `6379:6379` |
| **Volumes** | `redis-data:/data` |
| **Networks** | `generacy-network` (explicit) |

**Health check:**

| Property | Value |
|----------|-------|
| Test command | `redis-cli ping` |
| Interval | 10s |
| Timeout | 5s |
| Retries | 3 |
| Start period | Not set (default) |

### Named Volumes

| Volume | Used By | Mount Point |
|--------|---------|-------------|
| `redis-data` | `redis` | `/data` |

### Networks

| Network | Name | Driver |
|---------|------|--------|
| `generacy-network` | `generacy-network` | `bridge` (explicit) |

---

## 4. Differences Between Compose Files

### Service Availability

| Service | Main (`docker-compose.yml`) | Dev Override | Standalone Worker |
|---------|---------------------------|--------------|-------------------|
| `orchestrator` | Yes | Overridden | **Not present** |
| `worker` | Yes (2 replicas) | Overridden | Yes (1 instance, named) |
| `redis` | Yes | Not overridden | Yes (separate instance) |

### Redis Connection Strategy

| Compose File | Variable | Value | Notes |
|-------------|----------|-------|-------|
| Main + Dev Override | `REDIS_URL` | `redis://redis:6379` | Full URL format |
| Standalone Worker | `REDIS_HOST` + `REDIS_PORT` | `redis` / `6379` | Split host/port format |

**This is a key difference.** The main compose uses `REDIS_URL` (consumed by the orchestrator's `loader.ts`), while the standalone worker uses `REDIS_HOST` + `REDIS_PORT` (separate variables). This reflects different connection handling in the two codepaths.

### Health Check Differences

| Service/File | Endpoint | Tool | Port |
|-------------|----------|------|------|
| Orchestrator (main) | `/health` | `curl -f` | 3000 |
| Worker (main) | None | — | — |
| Redis (main) | Redis protocol | `redis-cli ping` | 6379 |
| Worker (standalone) | `/health/live` | `wget --spider` | 3001 |
| Redis (standalone) | Redis protocol | `redis-cli ping` | 6379 |

**Notable differences:**
1. Main worker has **no health check** — standalone worker has a full health check on `/health/live`
2. Orchestrator uses `curl`, standalone worker uses `wget` (Alpine-compatible, no curl installed)
3. Health check endpoints differ: `/health` (orchestrator) vs `/health/live` (standalone worker)
4. Standalone worker includes `start_period: 10s`, main orchestrator does not

### Dependency Strategy

| Compose File | Strategy | Details |
|-------------|----------|---------|
| Main | Simple `depends_on` | `orchestrator` → `redis`; `worker` → `redis`, `orchestrator` (no health condition) |
| Standalone Worker | `depends_on` with condition | `worker` → `redis` with `condition: service_healthy` |

The standalone worker uses the stricter `service_healthy` condition, ensuring Redis is actually ready before starting. The main compose relies on simple ordering only.

### Build Context & Dockerfiles

| Compose File | Service | Dockerfile | Build Context |
|-------------|---------|------------|---------------|
| Main | orchestrator | `services/orchestrator/Dockerfile` | `.` (project root) |
| Main | worker | `services/worker/Dockerfile` | `.` (project root) |
| Standalone | worker | `docker/worker/Dockerfile` | `..` (project root from `docker/`) |

**Note:** The Dockerfiles at `services/orchestrator/Dockerfile` and `services/worker/Dockerfile` (referenced by main compose) **do not currently exist** in the repo. Only `docker/worker/Dockerfile` exists. This means the main `docker-compose.yml` cannot currently build successfully — it appears to be a forward-looking configuration.

### Container Naming & Restart

| Property | Main Compose | Standalone Worker |
|----------|-------------|-------------------|
| Container names | Auto-generated by Docker Compose | Explicit: `generacy-worker`, `generacy-redis` |
| Restart policy | Not set (default: `no`) | `unless-stopped` |

### Replicas

| Compose File | Worker Replicas |
|-------------|----------------|
| Main | 2 (`deploy.replicas: 2`) |
| Standalone | 1 (single container) |

### Additional Standalone Worker Variables

The standalone worker compose defines several environment variables not present in the main compose worker:

| Variable | Value | Present in Main? |
|----------|-------|-----------------|
| `WORKER_ID` | `worker-local-1` | No |
| `REDIS_HOST` | `redis` | No (uses `REDIS_URL` instead) |
| `REDIS_PORT` | `6379` | No (uses `REDIS_URL` instead) |
| `HEALTH_PORT` | `3001` | No |
| `HEARTBEAT_ENABLED` | `true` | No |
| `HEARTBEAT_INTERVAL` | `5000` | No |
| `POLL_INTERVAL` | `1000` | No |
| `GRACEFUL_SHUTDOWN_TIMEOUT` | `60000` | No |

---

## 5. `generacy-network` Bridge Network

### Configuration Across Files

| Compose File | Network Definition | Approach |
|-------------|-------------------|----------|
| `docker-compose.yml` | `networks.default.name: generacy-network` | Renames the default network |
| `docker/docker-compose.worker.yml` | `networks.generacy-network.driver: bridge` | Explicitly defines a named network |

### Main Compose Network

In `docker-compose.yml`, the network is configured by renaming the **default** network:

```yaml
networks:
  default:
    name: generacy-network
```

- All services automatically join the default network without explicit `networks:` declarations per service
- The driver defaults to `bridge` (Docker's standard default)
- Services can communicate via service names as DNS hostnames (e.g., `redis://redis:6379`, `http://orchestrator:3000`)

### Standalone Worker Network

In `docker/docker-compose.worker.yml`, the network is explicitly defined:

```yaml
networks:
  generacy-network:
    driver: bridge
```

- Each service must explicitly declare `networks: [generacy-network]`
- The driver is explicitly set to `bridge`
- Both `worker` and `redis` services declare membership in this network

### Inter-Service Communication

Services on the `generacy-network` can reach each other using Docker's built-in DNS resolution:

| From | To | Address |
|------|-----|---------|
| Worker (main) | Orchestrator | `http://orchestrator:3000` |
| Worker (main) | Redis | `redis://redis:6379` |
| Orchestrator | Redis | `redis://redis:6379` |
| Worker (standalone) | Redis | `redis:6379` (via `REDIS_HOST`) |

### Important Note

The two compose files create **separate** `generacy-network` instances. The main compose and standalone worker compose are not intended to be run simultaneously sharing the same network. They represent alternative deployment configurations:
- **Main compose**: Full stack (orchestrator + workers + Redis)
- **Standalone worker**: Worker + Redis only (connects to an external orchestrator, or for testing)

---

## 6. Standalone Worker Dockerfile (`docker/worker/Dockerfile`)

For reference, the standalone worker Dockerfile uses a multi-stage build:

| Stage | Base Image | Purpose |
|-------|-----------|---------|
| `builder` | `node:20-alpine` | Install deps, compile TypeScript |
| `production` | `node:20-alpine` | Production runtime (prod deps only) |

**Production stage details:**
- Non-root user: `nodejs` (UID 1001)
- Exposed port: `3001`
- Default `NODE_ENV`: `production`
- Health check: `wget --spider http://localhost:3001/health/live` (30s interval, 10s timeout, 10s start period, 3 retries)
- Entrypoint: `node dist/worker/main.js`

---

## 7. Port Summary

| Service | Port | Exposed to Host | Purpose |
|---------|------|----------------|---------|
| Orchestrator | 3000 | Yes (`3000:3000`) | HTTP API + health check |
| Worker (main) | — | No | No exposed ports |
| Worker (standalone) | 3001 | Yes (`3001:3001`) | Health check endpoint |
| Redis | 6379 | Yes (`6379:6379`) | Redis protocol |

---

## 8. Observations & Notes for Documentation

1. **Main compose Dockerfiles don't exist yet**: `services/orchestrator/Dockerfile` and `services/worker/Dockerfile` are referenced but not present. The main `docker-compose.yml` appears to be forward-looking infrastructure. Only the standalone `docker/worker/Dockerfile` exists.

2. **Redis health check inconsistency**: Main compose uses 5 retries for Redis; standalone uses 3 retries.

3. **Worker health check gap**: The main compose worker service has no health check, while the standalone worker has a comprehensive one.

4. **`depends_on` strictness**: The standalone worker uses `condition: service_healthy` for Redis dependency, which is more robust than the main compose's simple `depends_on`.

5. **Redis connection split**: The different Redis connection strategies (`REDIS_URL` vs `REDIS_HOST`+`REDIS_PORT`) should be called out clearly in documentation to avoid confusion.

6. **Volume mount patterns**: Main compose uses read-only source mounts (`:ro`), dev override uses read-write full-directory mounts for hot reload.

7. **No Docker socket in standalone**: The standalone worker compose does **not** mount `/var/run/docker.sock`, unlike the main compose worker. This may limit its ability to spawn sub-containers for job execution.
