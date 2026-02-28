# T017 Validation Report: Docker Compose Docs vs Source

**Date**: 2026-02-28
**Status**: PASS — 0 discrepancies
**Files compared**:
- Doc: `docs/docs/reference/config/docker-compose.md`
- Source: `docker-compose.yml`
- Source: `docker-compose.override.yml`
- Source: `docker/docker-compose.worker.yml`

---

## Sub-task 1: Services, Ports, Volumes, and Environment Variables

### `docker-compose.yml` — orchestrator service

| Property | Source | Doc | Match |
|----------|--------|-----|-------|
| `build.context` | `.` | `.` | YES |
| `build.dockerfile` | `services/orchestrator/Dockerfile` | `services/orchestrator/Dockerfile` | YES |
| `ports` | `"3000:3000"` | `3000:3000` | YES |
| `environment.NODE_ENV` | `development` | `development` | YES |
| `environment.REDIS_URL` | `redis://redis:6379` | `redis://redis:6379` | YES |
| `environment.LOG_LEVEL` | `debug` | `debug` | YES |
| `depends_on` | `redis` | `redis` | YES |
| `volumes` | `./services/orchestrator/src:/app/src:ro` | `./services/orchestrator/src:/app/src:ro` | YES |

### `docker-compose.yml` — worker service

| Property | Source | Doc | Match |
|----------|--------|-----|-------|
| `build.context` | `.` | `.` | YES |
| `build.dockerfile` | `services/worker/Dockerfile` | `services/worker/Dockerfile` | YES |
| `environment.NODE_ENV` | `development` | `development` | YES |
| `environment.REDIS_URL` | `redis://redis:6379` | `redis://redis:6379` | YES |
| `environment.ORCHESTRATOR_URL` | `http://orchestrator:3000` | `http://orchestrator:3000` | YES |
| `environment.LOG_LEVEL` | `debug` | `debug` | YES |
| `depends_on` | `[redis, orchestrator]` | `[redis, orchestrator]` | YES |
| `volumes[0]` | `/var/run/docker.sock:/var/run/docker.sock` | `/var/run/docker.sock:/var/run/docker.sock` | YES |
| `volumes[1]` | `./services/worker/src:/app/src:ro` | `./services/worker/src:/app/src:ro` | YES |
| `deploy.replicas` | `2` | `2` | YES |

### `docker-compose.yml` — redis service

| Property | Source | Doc | Match |
|----------|--------|-----|-------|
| `image` | `redis:7-alpine` | `redis:7-alpine` | YES |
| `ports` | `"6379:6379"` | `6379:6379` | YES |
| `volumes` | `redis-data:/data` | `redis-data:/data` | YES |

### `docker-compose.yml` — top-level volumes

| Property | Source | Doc | Match |
|----------|--------|-----|-------|
| `volumes.redis-data` | defined | documented | YES |

### `docker-compose.override.yml`

| Property | Source | Doc | Match |
|----------|--------|-----|-------|
| `orchestrator.build.target` | `development` | `development` | YES |
| `orchestrator.volumes` | `./services/orchestrator:/app` | `./services/orchestrator:/app` | YES |
| `orchestrator.command` | `npm run dev` | `npm run dev` | YES |
| `worker.build.target` | `development` | `development` | YES |
| `worker.volumes` | `./services/worker:/app` | `./services/worker:/app` | YES |
| `worker.command` | `npm run dev` | `npm run dev` | YES |

### `docker/docker-compose.worker.yml` — worker service

| Property | Source | Doc | Match |
|----------|--------|-----|-------|
| `build.context` | `..` | `..` | YES |
| `build.dockerfile` | `docker/worker/Dockerfile` | `docker/worker/Dockerfile` | YES |
| `container_name` | `generacy-worker` | `generacy-worker` | YES |
| `restart` | `unless-stopped` | `unless-stopped` | YES |
| `environment.NODE_ENV` | `development` | `development` | YES |
| `environment.WORKER_ID` | `worker-local-1` | `worker-local-1` | YES |
| `environment.REDIS_HOST` | `redis` | `redis` | YES |
| `environment.REDIS_PORT` | `6379` | `6379` | YES |
| `environment.HEALTH_PORT` | `3001` | `3001` | YES |
| `environment.HEARTBEAT_ENABLED` | `true` | `true` | YES |
| `environment.HEARTBEAT_INTERVAL` | `5000` | `5000` | YES |
| `environment.POLL_INTERVAL` | `1000` | `1000` | YES |
| `environment.GRACEFUL_SHUTDOWN_TIMEOUT` | `60000` | `60000` | YES |
| `ports` | `"3001:3001"` | `3001:3001` | YES |
| `depends_on.redis.condition` | `service_healthy` | `service_healthy` | YES |

### `docker/docker-compose.worker.yml` — redis service

| Property | Source | Doc | Match |
|----------|--------|-----|-------|
| `image` | `redis:7-alpine` | `redis:7-alpine` | YES |
| `container_name` | `generacy-redis` | `generacy-redis` | YES |
| `restart` | `unless-stopped` | `unless-stopped` | YES |
| `ports` | `"6379:6379"` | `6379:6379` | YES |
| `volumes` | `redis-data:/data` | `redis-data:/data` | YES |

### `docker/docker-compose.worker.yml` — top-level volumes

| Property | Source | Doc | Match |
|----------|--------|-----|-------|
| `volumes.redis-data` | defined | documented | YES |

---

## Sub-task 2: Health Check Configurations

### `docker-compose.yml` — orchestrator health check

| Property | Source | Doc | Match |
|----------|--------|-----|-------|
| `test` | `["CMD", "curl", "-f", "http://localhost:3000/health"]` | `curl -f http://localhost:3000/health` | YES |
| `interval` | `30s` | `30s` | YES |
| `timeout` | `10s` | `10s` | YES |
| `retries` | `3` | `3` | YES |

### `docker-compose.yml` — redis health check

| Property | Source | Doc | Match |
|----------|--------|-----|-------|
| `test` | `["CMD", "redis-cli", "ping"]` | `redis-cli ping` | YES |
| `interval` | `10s` | `10s` | YES |
| `timeout` | `5s` | `5s` | YES |
| `retries` | `5` | `5` | YES |

### `docker/docker-compose.worker.yml` — worker health check

| Property | Source | Doc | Match |
|----------|--------|-----|-------|
| `test` | `["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:3001/health/live"]` | matches | YES |
| `interval` | `30s` | `30s` | YES |
| `timeout` | `10s` | `10s` | YES |
| `retries` | `3` | `3` | YES |
| `start_period` | `10s` | `10s` | YES |

### `docker/docker-compose.worker.yml` — redis health check

| Property | Source | Doc | Match |
|----------|--------|-----|-------|
| `test` | `["CMD", "redis-cli", "ping"]` | matches | YES |
| `interval` | `10s` | `10s` | YES |
| `timeout` | `5s` | `5s` | YES |
| `retries` | `3` | `3` | YES |

Note: Main compose Redis has `retries: 5`, standalone worker Redis has `retries: 3`. The docs correctly document both values in their respective sections.

---

## Sub-task 3: Network Configuration

### `docker-compose.yml`

| Property | Source | Doc | Match |
|----------|--------|-----|-------|
| `networks.default.name` | `generacy-network` | `generacy-network` | YES |

### `docker/docker-compose.worker.yml`

| Property | Source | Doc | Match |
|----------|--------|-----|-------|
| `networks.generacy-network.driver` | `bridge` | `bridge` | YES |
| Worker service networks | `[generacy-network]` | `[generacy-network]` | YES |
| Redis service networks | `[generacy-network]` | `[generacy-network]` | YES |

### Differences table (doc lines 309-316)

| Aspect | Doc claim | Source verification | Match |
|--------|-----------|---------------------|-------|
| Redis connection: main vs standalone | `REDIS_URL` vs `REDIS_HOST`+`REDIS_PORT` | Confirmed | YES |
| Health endpoint: main worker | No health check | Main worker has no healthcheck | YES |
| Health endpoint: standalone worker | wget on port 3001 | `wget ...http://localhost:3001/health/live` | YES |
| Startup: main worker | `depends_on: [redis, orchestrator]` | Confirmed | YES |
| Startup: standalone worker | `depends_on.redis.condition: service_healthy` | Confirmed | YES |
| Restart: main | None (default) | No restart policy in main compose | YES |
| Restart: standalone | `unless-stopped` | Confirmed | YES |
| Container names: main | Auto-generated | No `container_name` in main compose | YES |
| Container names: standalone | `generacy-worker`, `generacy-redis` | Confirmed | YES |
| Network: main | Named default network | `networks.default.name: generacy-network` | YES |
| Network: standalone | Explicit bridge | `networks.generacy-network.driver: bridge` | YES |

---

## Minor Observations (Non-discrepancies)

1. **`version: '3.8'`**: The standalone worker compose file includes `version: '3.8'` (deprecated in modern Docker Compose). The docs omit this, which is appropriate — the version key is informational and deprecated.

2. **Compose file overview table**: The doc states the standalone worker file contains services `worker, redis`. Source confirms: `worker` and `redis` services. Match.

3. **YAML code blocks**: The doc embeds YAML snippets that exactly match the source files. All embedded YAML was verified line-by-line.

---

## Summary

| Sub-task | Result |
|----------|--------|
| Services, ports, volumes, env vars | 0 discrepancies |
| Health check configurations | 0 discrepancies |
| Network configuration | 0 discrepancies |

**Total discrepancies: 0**
**Validation: PASS**
