---
sidebar_position: 4
---

# Orchestrator Configuration Reference

Complete reference for all orchestrator configuration options.

## Configuration File

The orchestrator reads its configuration from a YAML file:

```yaml title="orchestrator.yaml"
server:
  port: 3000
  host: 0.0.0.0
redis:
  url: redis://localhost:6379
auth:
  enabled: true
  providers:
    - apiKey
  jwt:
    secret: your-secret-at-least-32-characters-long
    expiresIn: 24h
logging:
  level: info
repositories:
  - owner: acme
    repo: main-app
monitor:
  pollIntervalMs: 30000
dispatch:
  maxConcurrentWorkers: 3
```

### File Discovery

The orchestrator searches for its config file in the following order:

1. `./orchestrator.yaml`
2. `./orchestrator.yml`
3. `./config/orchestrator.yaml`
4. `./config/orchestrator.yml`

The first file found is used. If no file is found, the orchestrator runs with environment variables and schema defaults only.

### Configuration Precedence

Configuration values are merged from three sources, highest priority first:

1. **Environment variables** — always win
2. **Config file** — values from the YAML file
3. **Schema defaults** — built-in defaults from the Zod schema

Environment variables override config file values, and config file values override schema defaults. Empty or undefined environment variables are ignored (they do not override config file values with blank strings).

## Top-Level Structure

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `server` | object | No | `{}` | HTTP server configuration |
| `redis` | object | No | `{}` | Redis connection configuration |
| `auth` | object | Yes | — | Authentication configuration |
| `rateLimit` | object | No | `{}` | Rate limiting configuration |
| `cors` | object | No | `{}` | CORS configuration |
| `logging` | object | No | `{}` | Logging configuration |
| `repositories` | array | No | `[]` | Monitored repositories |
| `monitor` | object | No | `{}` | Label detection monitor configuration |
| `prMonitor` | object | No | `{}` | PR feedback monitor configuration |
| `epicMonitor` | object | No | `{}` | Epic completion monitor configuration |
| `dispatch` | object | No | `{}` | Worker queue and dispatcher settings |
| `worker` | object | No | `{}` | Worker execution configuration |

All sections except `auth` default to `{}` and use sub-field defaults from the schema. The `auth` section is required because it needs a `jwt.secret` value (minimum 32 characters) that has no safe default.

## server

HTTP server configuration.

| Property | Type | Default | Constraints | Description |
|----------|------|---------|-------------|-------------|
| `port` | integer | `3000` | 0–65535 | Port to listen on. Set to `0` for a random available port. |
| `host` | string | `"0.0.0.0"` | — | Host to bind to. |

```yaml
server:
  port: 3000
  host: 0.0.0.0
```

## redis

Redis connection configuration.

| Property | Type | Default | Constraints | Description |
|----------|------|---------|-------------|-------------|
| `url` | string (URL) | `"redis://localhost:6379"` | Must be a valid URL | Redis connection URL. |

```yaml
redis:
  url: redis://localhost:6379
```

## auth

Authentication configuration. This section is **required** because `jwt.secret` has no default.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `enabled` | boolean | `true` | Whether authentication is enabled. |
| `providers` | string[] | `["apiKey"]` | Enabled authentication providers. Values: `apiKey`, `github-oauth2`. |
| `github` | object | — | GitHub OAuth configuration. Required if `github-oauth2` is in `providers`. |
| `jwt` | object | — | **Required.** JWT signing configuration. |

### auth.jwt

| Property | Type | Default | Constraints | Description |
|----------|------|---------|-------------|-------------|
| `secret` | string | — | **Required**, min 32 characters | Secret key for signing JWTs. |
| `expiresIn` | string | `"24h"` | — | Token expiration time (e.g., `24h`, `7d`). |

### auth.github

Required when `github-oauth2` is included in `auth.providers`.

| Property | Type | Default | Constraints | Description |
|----------|------|---------|-------------|-------------|
| `clientId` | string | — | **Required**, min 1 character | GitHub OAuth client ID. |
| `clientSecret` | string | — | **Required**, min 1 character | GitHub OAuth client secret. |
| `callbackUrl` | string (URL) | `"http://localhost:3000/auth/github/callback"` | Must be a valid URL | OAuth callback URL. |

```yaml
auth:
  enabled: true
  providers:
    - apiKey
    - github-oauth2
  jwt:
    secret: your-secret-key-at-least-32-characters-long
    expiresIn: 24h
  github:
    clientId: Iv1.abc123
    clientSecret: secret_abc123
    callbackUrl: https://app.example.com/auth/github/callback
```

## rateLimit

Rate limiting configuration for the HTTP API.

| Property | Type | Default | Constraints | Description |
|----------|------|---------|-------------|-------------|
| `enabled` | boolean | `true` | — | Whether rate limiting is enabled. |
| `max` | integer | `100` | Must be positive | Maximum requests per time window. |
| `timeWindow` | string | `"1 minute"` | — | Time window for rate limiting. |

```yaml
rateLimit:
  enabled: true
  max: 100
  timeWindow: 1 minute
```

## cors

CORS (Cross-Origin Resource Sharing) configuration.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `origin` | boolean \| string \| string[] | `true` | Allowed origins. `true` reflects the request origin. A string or array restricts to specific origins. |
| `credentials` | boolean | `true` | Whether to include credentials in CORS responses. |

```yaml
cors:
  origin: true
  credentials: true
```

## logging

Logging configuration.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `level` | string | `"info"` | Log level. Values: `trace`, `debug`, `info`, `warn`, `error`. |
| `pretty` | boolean | `false` | Pretty-print logs. Enable for development, disable in production for structured JSON logs. |

```yaml
logging:
  level: info
  pretty: false
```

## repositories

Array of GitHub repositories to monitor for label-based task dispatch. Each entry identifies a repository by owner and name.

| Property | Type | Constraints | Description |
|----------|------|-------------|-------------|
| `owner` | string | **Required**, min 1 character | GitHub organization or username. |
| `repo` | string | **Required**, min 1 character | Repository name. |

```yaml
repositories:
  - owner: acme
    repo: main-app
  - owner: acme
    repo: api-service
```

Can also be set via the `MONITORED_REPOS` environment variable using comma-separated `owner/repo` format:

```bash
MONITORED_REPOS=acme/main-app,acme/api-service
```

## monitor

Label detection monitor configuration. Controls how the orchestrator polls GitHub for new labeled issues.

| Property | Type | Default | Constraints | Description |
|----------|------|---------|-------------|-------------|
| `pollIntervalMs` | integer | `30000` | min 5000 | Polling interval in milliseconds. |
| `webhookSecret` | string | — | Optional | GitHub webhook secret for signature verification. |
| `maxConcurrentPolls` | integer | `5` | 1–20 | Maximum concurrent GitHub API calls during polling. |
| `adaptivePolling` | boolean | `true` | — | Enable adaptive polling frequency. When enabled, the monitor adjusts its polling rate based on activity. |

```yaml
monitor:
  pollIntervalMs: 30000
  webhookSecret: whsec_abc123
  maxConcurrentPolls: 5
  adaptivePolling: true
```

## prMonitor

PR feedback monitor configuration. Watches for review comments and CI status on open pull requests.

| Property | Type | Default | Constraints | Description |
|----------|------|---------|-------------|-------------|
| `enabled` | boolean | `true` | — | Whether the PR feedback monitor is enabled. |
| `pollIntervalMs` | integer | `60000` | min 5000 | Polling interval in milliseconds. |
| `webhookSecret` | string | — | Optional | GitHub webhook secret for signature verification. |
| `adaptivePolling` | boolean | `true` | — | Enable adaptive polling frequency. |
| `maxConcurrentPolls` | integer | `3` | 1–20 | Maximum concurrent GitHub API calls during polling. |

```yaml
prMonitor:
  enabled: true
  pollIntervalMs: 60000
  adaptivePolling: true
  maxConcurrentPolls: 3
```

## epicMonitor

Epic completion monitor configuration. Tracks progress on epic issues and their sub-tasks.

| Property | Type | Default | Constraints | Description |
|----------|------|---------|-------------|-------------|
| `enabled` | boolean | `true` | — | Whether the epic completion monitor is enabled. |
| `pollIntervalMs` | integer | `300000` (5 min) | min 60000 (1 min) | Polling interval in milliseconds. |

```yaml
epicMonitor:
  enabled: true
  pollIntervalMs: 300000
```

## dispatch

Worker queue and dispatcher settings. Controls how tasks are queued, dispatched to workers, and retried.

| Property | Type | Default | Constraints | Description |
|----------|------|---------|-------------|-------------|
| `pollIntervalMs` | integer | `5000` | min 1000 | Interval between queue polls in milliseconds. |
| `maxConcurrentWorkers` | integer | `3` | 1–20 | Maximum number of concurrent workers. |
| `heartbeatTtlMs` | integer | `30000` | min 5000 | Worker heartbeat TTL in milliseconds. Workers that miss a heartbeat within this window are considered dead. |
| `heartbeatCheckIntervalMs` | integer | `15000` | min 5000 | Interval between heartbeat reaper checks in milliseconds. |
| `shutdownTimeoutMs` | integer | `60000` | min 5000 | Timeout for graceful shutdown of workers in milliseconds. |
| `maxRetries` | integer | `3` | min 1 | Maximum retry attempts before a task is dead-lettered. |

```yaml
dispatch:
  pollIntervalMs: 5000
  maxConcurrentWorkers: 3
  heartbeatTtlMs: 30000
  heartbeatCheckIntervalMs: 15000
  shutdownTimeoutMs: 60000
  maxRetries: 3
```

## worker

Worker execution configuration. Controls how individual workers run tasks, including timeouts, workspace setup, and gate checkpoints.

| Property | Type | Default | Constraints | Description |
|----------|------|---------|-------------|-------------|
| `phaseTimeoutMs` | integer | `600000` (10 min) | min 60000 (1 min) | Timeout per workflow phase in milliseconds. |
| `workspaceDir` | string | `"/tmp/orchestrator-workspaces"` | — | Base directory for repository checkouts. |
| `shutdownGracePeriodMs` | integer | `5000` | min 1000 | Grace period for shutdown in milliseconds. |
| `validateCommand` | string | `"pnpm test && pnpm build"` | — | Command to run during the validate phase. |
| `maxTurns` | integer | `100` | min 10 | Maximum Claude CLI turns per phase. |
| `gates` | object | See below | — | Gate definitions keyed by issue label. |

```yaml
worker:
  phaseTimeoutMs: 600000
  workspaceDir: /tmp/orchestrator-workspaces
  shutdownGracePeriodMs: 5000
  validateCommand: pnpm test && pnpm build
  maxTurns: 100
```

### worker.gates

Gates are review checkpoints that pause the workflow at specific phases. They are defined as a map of issue label to an array of gate definitions. When an issue has a matching label, the worker will pause at the specified phase and add a gate label to the issue.

Each gate definition has:

| Property | Type | Description |
|----------|------|-------------|
| `phase` | string | Workflow phase that triggers the gate. Values: `specify`, `clarify`, `plan`, `tasks`, `implement`, `validate`. |
| `gateLabel` | string | Label to add to the issue when the gate is active. |
| `condition` | string | When to activate the gate. Values: `always`, `on-questions`, `on-failure`. |

Default gates:

```yaml
worker:
  gates:
    speckit-feature:
      - phase: clarify
        gateLabel: "waiting-for:clarification"
        condition: always
    speckit-bugfix: []
    speckit-epic:
      - phase: clarify
        gateLabel: "waiting-for:clarification"
        condition: always
      - phase: tasks
        gateLabel: "waiting-for:tasks-review"
        condition: always
```

## Environment Variable Mapping

All orchestrator configuration fields can be set via environment variables. Environment variables always take precedence over config file values.

Some variables have two forms: a short form and a prefixed (`ORCHESTRATOR_`) form. When both are set, the short form takes precedence.

| Environment Variable | Config Path | Default | Notes |
|---------------------|-------------|---------|-------|
| `ORCHESTRATOR_PORT` | `server.port` | `3000` | Parsed as integer |
| `ORCHESTRATOR_HOST` | `server.host` | `"0.0.0.0"` | |
| `REDIS_URL` | `redis.url` | `"redis://localhost:6379"` | Takes precedence over `ORCHESTRATOR_REDIS_URL` |
| `ORCHESTRATOR_REDIS_URL` | `redis.url` | `"redis://localhost:6379"` | Fallback for `REDIS_URL` |
| `ORCHESTRATOR_AUTH_ENABLED` | `auth.enabled` | `true` | `"true"` to enable |
| `ORCHESTRATOR_JWT_SECRET` | `auth.jwt.secret` | — | Required, min 32 characters |
| `ORCHESTRATOR_JWT_EXPIRES_IN` | `auth.jwt.expiresIn` | `"24h"` | |
| `GITHUB_CLIENT_ID` | `auth.github.clientId` | — | Required for GitHub OAuth |
| `GITHUB_CLIENT_SECRET` | `auth.github.clientSecret` | — | Required for GitHub OAuth |
| `ORCHESTRATOR_GITHUB_CALLBACK_URL` | `auth.github.callbackUrl` | `"http://localhost:3000/auth/github/callback"` | |
| `ORCHESTRATOR_RATE_LIMIT_ENABLED` | `rateLimit.enabled` | `true` | `"true"` to enable |
| `ORCHESTRATOR_RATE_LIMIT_MAX` | `rateLimit.max` | `100` | Parsed as integer |
| `ORCHESTRATOR_RATE_LIMIT_WINDOW` | `rateLimit.timeWindow` | `"1 minute"` | |
| `LOG_LEVEL` | `logging.level` | `"info"` | Takes precedence over `ORCHESTRATOR_LOG_LEVEL` |
| `ORCHESTRATOR_LOG_LEVEL` | `logging.level` | `"info"` | Fallback for `LOG_LEVEL` |
| `ORCHESTRATOR_LOG_PRETTY` | `logging.pretty` | `false` | `"true"` to enable |
| `MONITORED_REPOS` | `repositories[]` | `[]` | Comma-separated `owner/repo`. Takes precedence over `ORCHESTRATOR_REPOSITORIES` |
| `ORCHESTRATOR_REPOSITORIES` | `repositories[]` | `[]` | Fallback for `MONITORED_REPOS` |
| `POLL_INTERVAL_MS` | `monitor.pollIntervalMs` | `30000` | Parsed as integer. Takes precedence over `ORCHESTRATOR_POLL_INTERVAL_MS` |
| `ORCHESTRATOR_POLL_INTERVAL_MS` | `monitor.pollIntervalMs` | `30000` | Fallback for `POLL_INTERVAL_MS` |
| `WEBHOOK_SECRET` | `monitor.webhookSecret` | — | Takes precedence over `ORCHESTRATOR_WEBHOOK_SECRET` |
| `ORCHESTRATOR_WEBHOOK_SECRET` | `monitor.webhookSecret` | — | Fallback for `WEBHOOK_SECRET` |
| `PR_MONITOR_ENABLED` | `prMonitor.enabled` | `true` | `"true"` to enable |
| `PR_MONITOR_POLL_INTERVAL_MS` | `prMonitor.pollIntervalMs` | `60000` | Parsed as integer |
| `PR_MONITOR_WEBHOOK_SECRET` | `prMonitor.webhookSecret` | — | |
| `PR_MONITOR_ADAPTIVE_POLLING` | `prMonitor.adaptivePolling` | `true` | `"true"` to enable |
| `PR_MONITOR_MAX_CONCURRENT_POLLS` | `prMonitor.maxConcurrentPolls` | `3` | Parsed as integer |

For the complete environment variables reference, see [Environment Variables](/docs/reference/config/environment-variables).

## Examples

### Minimal Configuration

The smallest useful configuration — server, Redis, and auth:

```yaml title="orchestrator.yaml"
auth:
  jwt:
    secret: your-secret-key-at-least-32-characters-long
```

All other fields use schema defaults: port 3000, host 0.0.0.0, Redis at localhost:6379, etc.

### Production Configuration

A full configuration for a production deployment:

```yaml title="orchestrator.yaml"
server:
  port: 3000
  host: 0.0.0.0

redis:
  url: redis://redis:6379

auth:
  enabled: true
  providers:
    - apiKey
    - github-oauth2
  jwt:
    secret: your-production-secret-at-least-32-characters
    expiresIn: 24h
  github:
    clientId: Iv1.abc123
    clientSecret: secret_abc123
    callbackUrl: https://app.example.com/auth/github/callback

rateLimit:
  enabled: true
  max: 100
  timeWindow: 1 minute

cors:
  origin:
    - https://app.example.com
  credentials: true

logging:
  level: info
  pretty: false

repositories:
  - owner: acme
    repo: main-app
  - owner: acme
    repo: api-service

monitor:
  pollIntervalMs: 30000
  webhookSecret: whsec_production_secret
  maxConcurrentPolls: 5
  adaptivePolling: true

prMonitor:
  enabled: true
  pollIntervalMs: 60000
  adaptivePolling: true
  maxConcurrentPolls: 3

epicMonitor:
  enabled: true
  pollIntervalMs: 300000

dispatch:
  pollIntervalMs: 5000
  maxConcurrentWorkers: 5
  heartbeatTtlMs: 30000
  heartbeatCheckIntervalMs: 15000
  shutdownTimeoutMs: 60000
  maxRetries: 3

worker:
  phaseTimeoutMs: 600000
  workspaceDir: /var/lib/generacy/workspaces
  shutdownGracePeriodMs: 5000
  validateCommand: pnpm test && pnpm build
  maxTurns: 100
```

## See Also

- [Generacy Configuration](/docs/reference/config/generacy) — Project-level `.generacy/config.yaml` settings
- [Environment Variables](/docs/reference/config/environment-variables) — All environment variables reference
- [Docker Compose Configuration](/docs/reference/config/docker-compose) — Service definitions and deployment options
- [CLI Commands](/docs/reference/cli/commands) — `generacy orchestrator` starts the server
