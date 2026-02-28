---
sidebar_position: 5
---

# Environment Variables Reference

Consolidated reference for all environment variables used across Generacy services.

Environment variables override config file values. For the orchestrator, the full precedence chain is: **environment variables > config file > schema defaults**. For the CLI, it is: **CLI flags > environment variables > defaults**.

## Operator Variables

These are the most commonly configured variables for running Generacy.

### Server

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `ORCHESTRATOR_PORT` | integer | `3000` | Port the orchestrator HTTP server listens on. Range: 0–65535. |
| `ORCHESTRATOR_HOST` | string | `"0.0.0.0"` | Host the orchestrator binds to. |
| `ORCHESTRATOR_URL` | string | — | Full URL of the orchestrator (e.g., `http://localhost:3000`). Used by workers and the CLI to connect. |

```bash
ORCHESTRATOR_PORT=3000
ORCHESTRATOR_HOST=0.0.0.0
ORCHESTRATOR_URL=http://localhost:3000
```

### Redis

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `REDIS_URL` | string (URL) | `"redis://localhost:6379"` | Redis connection URL. Takes precedence over `ORCHESTRATOR_REDIS_URL`. |
| `ORCHESTRATOR_REDIS_URL` | string (URL) | `"redis://localhost:6379"` | Fallback for `REDIS_URL`. |

```bash
REDIS_URL=redis://localhost:6379
```

:::note Redis in standalone worker Docker

The standalone worker Docker Compose (`docker/docker-compose.worker.yml`) uses split variables instead of a URL:

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `REDIS_HOST` | string | `"localhost"` | Redis server hostname. |
| `REDIS_PORT` | integer | `6379` | Redis server port. |
| `REDIS_PASSWORD` | string | — | Redis authentication password. |
| `REDIS_DB` | integer | `0` | Redis database number. |

The orchestrator and main Docker Compose use `REDIS_URL`. When deploying your own worker containers, prefer `REDIS_URL` for consistency.

:::

### Logging

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `LOG_LEVEL` | string | `"info"` | Log level. Values: `trace`, `debug`, `info`, `warn`, `error`. Takes precedence over `ORCHESTRATOR_LOG_LEVEL`. |
| `ORCHESTRATOR_LOG_LEVEL` | string | `"info"` | Fallback for `LOG_LEVEL`. |
| `ORCHESTRATOR_LOG_PRETTY` | boolean | `false` | Enable pretty-printed logs. Set `"true"` for development. |
| `NO_COLOR` | — | — | Disable ANSI color codes in CLI output. Follows the [NO_COLOR](https://no-color.org/) convention — presence of the variable is enough, even if empty. |

```bash
LOG_LEVEL=info
ORCHESTRATOR_LOG_PRETTY=true
```

### Monitor

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `POLL_INTERVAL_MS` | integer | `30000` | Label monitor polling interval in milliseconds. Min: 5000. Takes precedence over `ORCHESTRATOR_POLL_INTERVAL_MS`. |
| `ORCHESTRATOR_POLL_INTERVAL_MS` | integer | `30000` | Fallback for `POLL_INTERVAL_MS`. |
| `MONITORED_REPOS` | string | `""` | Comma-separated `owner/repo` list of repositories to monitor. Takes precedence over `ORCHESTRATOR_REPOSITORIES`. |
| `ORCHESTRATOR_REPOSITORIES` | string | `""` | Fallback for `MONITORED_REPOS`. |
| `WEBHOOK_SECRET` | string | — | GitHub webhook secret for signature verification. Takes precedence over `ORCHESTRATOR_WEBHOOK_SECRET`. |
| `ORCHESTRATOR_WEBHOOK_SECRET` | string | — | Fallback for `WEBHOOK_SECRET`. |

```bash
MONITORED_REPOS=acme/main-app,acme/api-service
POLL_INTERVAL_MS=30000
WEBHOOK_SECRET=whsec_abc123
```

### Worker

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `WORKER_ID` | string | `"worker-${pid}"` | Unique identifier for the worker instance. Auto-generated from PID if not set. |
| `POLL_INTERVAL` | integer | `1000` | Job poll interval in milliseconds for standalone workers. Min: 1000. **Not the same as `POLL_INTERVAL_MS`** (which controls the label monitor). |
| `HEALTH_PORT` | integer | `3001` | Port for the worker health check HTTP server. |
| `HEALTH_ENABLED` | boolean | `true` | Enable the worker health check endpoint. Set `"false"` to disable. |
| `HEARTBEAT_ENABLED` | boolean | `true` | Enable worker heartbeat to Redis. Set `"false"` to disable. |
| `HEARTBEAT_INTERVAL` | integer | `5000` | Heartbeat interval in milliseconds. |
| `HEARTBEAT_TTL` | integer | `30000` | Heartbeat TTL in milliseconds. Workers that miss a heartbeat within this window are considered dead. |
| `GRACEFUL_SHUTDOWN_TIMEOUT` | integer | `30000` | Grace period in milliseconds for completing in-flight jobs before shutdown. Min: 1000. |
| `FORCE_SHUTDOWN_ON_TIMEOUT` | boolean | `false` | Force process exit if the graceful shutdown timeout is exceeded. |

```bash
WORKER_ID=worker-local-1
POLL_INTERVAL=1000
HEALTH_PORT=3001
HEARTBEAT_INTERVAL=5000
```

### Authentication

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `GITHUB_TOKEN` | string | — | GitHub Personal Access Token. Required for GitHub API operations (creating PRs, reading repos). Minimum scopes: `repo`, `workflow`. |
| `ANTHROPIC_API_KEY` | string | — | Anthropic API key (starts with `sk-ant-`). Required for Claude-powered agent tasks. Inherited by spawned agent subprocesses. |
| `ORCHESTRATOR_TOKEN` | string | — | Authentication token for orchestrator API calls. |

```bash
GITHUB_TOKEN=ghp_abc123
ANTHROPIC_API_KEY=sk-ant-abc123
ORCHESTRATOR_TOKEN=your-api-token
```

## Advanced Variables

### Auth Internals

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `ORCHESTRATOR_AUTH_ENABLED` | boolean | `true` | Enable/disable orchestrator authentication. Set `"true"` to enable. |
| `ORCHESTRATOR_JWT_SECRET` | string | — | JWT signing secret. **Required** when auth is enabled. Minimum 32 characters. |
| `ORCHESTRATOR_JWT_EXPIRES_IN` | string | `"24h"` | JWT token expiration (e.g., `24h`, `7d`, `1h`). |

### GitHub OAuth

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `GITHUB_CLIENT_ID` | string | — | GitHub OAuth application client ID. Required when using `github-oauth2` auth provider. |
| `GITHUB_CLIENT_SECRET` | string | — | GitHub OAuth application client secret. |
| `ORCHESTRATOR_GITHUB_CALLBACK_URL` | string | `"http://localhost:3000/auth/github/callback"` | OAuth callback URL. |

### GitHub App Authentication

Alternative to token-based auth. Used by the `github-issues` package.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `GITHUB_APP_ID` | string | — | GitHub App ID. |
| `GITHUB_APP_PRIVATE_KEY` | string | — | Inline private key (PEM or base64-encoded). |
| `GITHUB_APP_PRIVATE_KEY_PATH` | string | — | Path to private key file. Alternative to inline key. |
| `GITHUB_APP_INSTALLATION_ID` | integer | — | GitHub App installation ID. |

At least one of `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH` must be set when using App authentication.

### Rate Limiting

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `ORCHESTRATOR_RATE_LIMIT_ENABLED` | boolean | `true` | Enable rate limiting on the orchestrator API. |
| `ORCHESTRATOR_RATE_LIMIT_MAX` | integer | `100` | Maximum requests per time window. |
| `ORCHESTRATOR_RATE_LIMIT_WINDOW` | string | `"1 minute"` | Time window for rate limiting. |

### PR Monitor

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PR_MONITOR_ENABLED` | boolean | `true` | Enable the PR feedback monitor. |
| `PR_MONITOR_POLL_INTERVAL_MS` | integer | `60000` | PR monitor polling interval in milliseconds. Min: 5000. |
| `PR_MONITOR_WEBHOOK_SECRET` | string | — | Webhook secret for PR feedback events. |
| `PR_MONITOR_ADAPTIVE_POLLING` | boolean | `true` | Adjust polling frequency based on activity. |
| `PR_MONITOR_MAX_CONCURRENT_POLLS` | integer | `3` | Maximum concurrent GitHub API calls. Range: 1–20. |

### CLI Configuration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `NODE_ENV` | string | `"development"` | Node environment. Controls error verbosity and pretty logging defaults. |
| `GENERACY_PRETTY_LOG` | boolean | `!(NODE_ENV=production)` | Override pretty-printed log formatting. |
| `GENERACY_WORKDIR` | string | `process.cwd()` | Working directory for workflow execution. |
| `GENERACY_WORKFLOW_FILE` | string | — | Default workflow file path. |
| `GENERACY_CONFIG_PATH` | string | — | Override `.generacy/config.yaml` file location. Takes precedence over directory search. |
| `GENERACY_TIMEOUT` | integer | — | Timeout in milliseconds for CLI operations. Read by the VS Code extension when spawning CLI processes. |

### Agency Integration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `AGENCY_MODE` | string | `"subprocess"` | How to communicate with the Agency tool router. Values: `subprocess`, `network`. |
| `AGENCY_URL` | string | — | URL of the Agency service. **Required** when `AGENCY_MODE=network`. |
| `AGENCY_COMMAND` | string | `"npx @anthropic-ai/agency"` | Command to spawn the Agency subprocess. |
| `AGENCY_TOKEN` | string | — | Authentication token for the Agency service in network mode. |

### Humancy Integration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `HUMANCY_API_URL` | string | — | Humancy service URL for human decision workflows. |
| `HUMANCY_AGENT_ID` | string | Worker ID | Agent ID for the Humancy service. |
| `HUMANCY_AUTH_TOKEN` | string | — | Auth token for Humancy. Falls back to `ORCHESTRATOR_TOKEN`. |

### Webhook & Monitoring

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `LABEL_MONITOR_ENABLED` | boolean | `false` | Enable the GitHub label monitoring service on the orchestrator. Set `"true"` to enable. |
| `SMEE_CHANNEL_URL` | string | — | [Smee.io](https://smee.io/) channel URL to tunnel GitHub webhooks for local development. Must point to `smee.io`. |
| `GENERACY_AGENT_ACCOUNT` | string | `"generacy-bot"` | GitHub account used by the agent for assignee detection. |

## `.env.example`

The repository includes a `.env.example` file with common operator variables organized by section: Authentication, Redis, Server, Label Monitor, Worker, and Logging.

Copy this file to `.env` and fill in your values:

```bash
cp .env.example .env
```

Key variables to configure:

- **`GITHUB_TOKEN`** — Required for GitHub API operations
- **`REDIS_URL`** — Redis connection for the orchestrator and workers
- **`ORCHESTRATOR_PORT`** — Server port (default 3000)
- **`LOG_LEVEL`** — Logging verbosity
- **`MONITORED_REPOS`** — Repositories the label monitor watches
- **`ORCHESTRATOR_URL`** — URL workers use to connect to the orchestrator

## See Also

- [Orchestrator Configuration](/docs/reference/config/orchestrator) — Full config schema with environment variable mapping table
- [Generacy Configuration](/docs/reference/config/generacy) — Project-level `.generacy/config.yaml` settings
- [Docker Compose Configuration](/docs/reference/config/docker-compose) — Service definitions and per-service environment variables
- [CLI Commands](/docs/reference/cli/commands) — Commands that read these variables
