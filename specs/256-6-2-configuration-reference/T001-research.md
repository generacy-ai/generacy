# T001: Source Schema & Existing Docs Catalog

Research output for task T001. This file catalogs every field from the source Zod schemas, every environment variable from `loader.ts`, and the documentation conventions from existing reference docs.

---

## 1. GeneracyConfig Zod Schema

**Source:** `packages/generacy/src/config/schema.ts`

### Root: `GeneracyConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `schemaVersion` | `string` | No | `"1"` | — | Schema version for future migration support |
| `project` | `ProjectConfigSchema` | Yes | — | — | Project metadata |
| `repos` | `ReposConfigSchema` | Yes | — | — | Repository relationships |
| `defaults` | `DefaultsConfigSchema` | No | — | — | Workflow execution defaults |
| `orchestrator` | `OrchestratorSettingsSchema` | No | — | — | Runtime settings for the orchestrator |

### `ProjectConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `id` | `string` | Yes | — | Regex: `^proj_[a-z0-9]+$`, min 12 chars | Unique project ID from generacy.ai (e.g. `proj_abc123`) |
| `name` | `string` | Yes | — | min 1 char, max 255 chars | Human-readable project name |

### `ReposConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `primary` | `string` (RepositoryUrl) | Yes | — | Regex: `^github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$`, must not end with `.git` | Primary repository (receives onboarding PR) |
| `dev` | `string[]` (RepositoryUrl[]) | No | `[]` | Same URL format as primary | Development repos (cloned for active dev, can receive PRs) |
| `clone` | `string[]` (RepositoryUrl[]) | No | `[]` | Same URL format as primary | Clone-only repos (reference/reading only, no PRs) |

**RepositoryUrl format:** `github.com/{owner}/{repo}` — no protocol prefix, no `.git` suffix.

### `DefaultsConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `agent` | `string` | No | — | Regex: `^[a-z0-9]+(-[a-z0-9]+)*$` (kebab-case) | Default agent for workflow execution (e.g. `claude-code`) |
| `baseBranch` | `string` | No | — | min 1 char | Default base branch for feature branches |

### `OrchestratorSettingsSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `pollIntervalMs` | `number` (int) | No | — | min 5000 | Polling interval in milliseconds |
| `workerCount` | `number` (int) | No | — | min 1, max 20 | Maximum concurrent workers |

### Related Files

- **`validator.ts`**: `ConfigValidationError` class, `validateNoDuplicateRepos()`, `validateSemantics()` — semantic validation beyond Zod schema
- **`loader.ts`**: `loadConfig()` (filesystem discovery), `parseConfig()` (YAML parse + validate), `findConfigFile()` (walks directory tree), error classes: `ConfigNotFoundError`, `ConfigParseError`, `ConfigSchemaError`
- **`index.ts`**: Central export for all schemas, types, utilities

---

## 2. OrchestratorConfigSchema

**Source:** `packages/orchestrator/src/config/schema.ts`

### Root: `OrchestratorConfigSchema`

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `server` | `ServerConfigSchema` | No | `{}` (uses sub-defaults) | HTTP server configuration |
| `redis` | `RedisConfigSchema` | No | `{}` (uses sub-defaults) | Redis connection configuration |
| `auth` | `AuthConfigSchema` | Yes | — | Authentication configuration (requires `jwt` sub-object) |
| `rateLimit` | `RateLimitConfigSchema` | No | `{}` (uses sub-defaults) | Rate limiting configuration |
| `cors` | `CorsConfigSchema` | No | `{}` (uses sub-defaults) | CORS configuration |
| `logging` | `LoggingConfigSchema` | No | `{}` (uses sub-defaults) | Logging configuration |
| `repositories` | `RepositoryConfigSchema[]` | No | `[]` | Monitored repositories for label sync |
| `monitor` | `MonitorConfigSchema` | No | `{}` (uses sub-defaults) | Label detection monitor configuration |
| `prMonitor` | `PrMonitorConfigSchema` | No | `{}` (uses sub-defaults) | PR feedback monitor configuration |
| `epicMonitor` | `EpicMonitorConfigSchema` | No | `{}` (uses sub-defaults) | Epic completion monitor configuration |
| `dispatch` | `DispatchConfigSchema` | No | `{}` (uses sub-defaults) | Worker queue and dispatcher settings |
| `worker` | `WorkerConfigSchema` | No | `{}` (uses sub-defaults) | Worker execution configuration |

### `ServerConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `port` | `number` (int) | No | `3000` | min 0, max 65535 | Port to listen on (0 = random available port) |
| `host` | `string` | No | `"0.0.0.0"` | — | Host to bind to |

### `RedisConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `url` | `string` (url) | No | `"redis://localhost:6379"` | Must be valid URL | Redis connection URL |

### `GitHubOAuthConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `clientId` | `string` | Yes | — | min 1 char | GitHub OAuth client ID |
| `clientSecret` | `string` | Yes | — | min 1 char | GitHub OAuth client secret |
| `callbackUrl` | `string` (url) | No | `"http://localhost:3000/auth/github/callback"` | Must be valid URL | OAuth callback URL |

### `JWTConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `secret` | `string` | Yes | — | min 32 chars | Secret key for signing JWTs |
| `expiresIn` | `string` | No | `"24h"` | — | Token expiration time |

### `AuthConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `enabled` | `boolean` | No | `true` | — | Whether authentication is enabled |
| `providers` | `("apiKey" \| "github-oauth2")[]` | No | `["apiKey"]` | Enum values | Enabled authentication providers |
| `github` | `GitHubOAuthConfigSchema` | No | — | Required if `github-oauth2` provider is enabled | GitHub OAuth configuration |
| `jwt` | `JWTConfigSchema` | Yes | — | — | JWT configuration |

### `RateLimitConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `enabled` | `boolean` | No | `true` | — | Whether rate limiting is enabled |
| `max` | `number` (int) | No | `100` | Must be positive | Maximum requests per time window |
| `timeWindow` | `string` | No | `"1 minute"` | — | Time window for rate limiting |

### `CorsConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `origin` | `boolean \| string \| string[]` | No | `true` | — | Allowed origins (`true` = reflect request origin) |
| `credentials` | `boolean` | No | `true` | — | Whether to include credentials |

### `LoggingConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `level` | `LogLevel` | No | `"info"` | Enum: `trace`, `debug`, `info`, `warn`, `error` | Log level |
| `pretty` | `boolean` | No | `false` | — | Pretty print logs (for development) |

### `RepositoryConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `owner` | `string` | Yes | — | min 1 char | GitHub organization or username |
| `repo` | `string` | Yes | — | min 1 char | Repository name |

### `MonitorConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `pollIntervalMs` | `number` (int) | No | `30000` | min 5000 | Polling interval in milliseconds |
| `webhookSecret` | `string` | No | — | — | GitHub webhook secret for signature verification |
| `maxConcurrentPolls` | `number` (int) | No | `5` | min 1, max 20 | Maximum concurrent GitHub API calls during polling |
| `adaptivePolling` | `boolean` | No | `true` | — | Enable adaptive polling frequency |

### `PrMonitorConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `enabled` | `boolean` | No | `true` | — | Whether the PR feedback monitor is enabled |
| `pollIntervalMs` | `number` (int) | No | `60000` | min 5000 | Polling interval in milliseconds |
| `webhookSecret` | `string` | No | — | — | GitHub webhook secret for signature verification |
| `adaptivePolling` | `boolean` | No | `true` | — | Enable adaptive polling frequency |
| `maxConcurrentPolls` | `number` (int) | No | `3` | min 1, max 20 | Maximum concurrent GitHub API calls during polling |

### `EpicMonitorConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `enabled` | `boolean` | No | `true` | — | Whether the epic completion monitor is enabled |
| `pollIntervalMs` | `number` (int) | No | `300000` (5 min) | min 60000 (1 min) | Polling interval in milliseconds |

### `DispatchConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `pollIntervalMs` | `number` (int) | No | `5000` | min 1000 | Interval between queue polls in milliseconds |
| `maxConcurrentWorkers` | `number` (int) | No | `3` | min 1, max 20 | Maximum number of concurrent workers |
| `heartbeatTtlMs` | `number` (int) | No | `30000` | min 5000 | Worker heartbeat TTL in milliseconds |
| `heartbeatCheckIntervalMs` | `number` (int) | No | `15000` | min 5000 | Interval between heartbeat/reaper checks in milliseconds |
| `shutdownTimeoutMs` | `number` (int) | No | `60000` | min 5000 | Timeout for graceful shutdown of workers in milliseconds |
| `maxRetries` | `number` (int) | No | `3` | min 1 | Maximum retry attempts before dead-lettering |

---

## 3. WorkerConfigSchema

**Source:** `packages/orchestrator/src/worker/config.ts`

### `WorkerConfigSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `phaseTimeoutMs` | `number` (int) | No | `600000` (10 min) | min 60000 (1 min) | Timeout per phase in milliseconds |
| `workspaceDir` | `string` | No | `"/tmp/orchestrator-workspaces"` | — | Base directory for repo checkouts |
| `shutdownGracePeriodMs` | `number` (int) | No | `5000` | min 1000 | Grace period for shutdown in milliseconds |
| `validateCommand` | `string` | No | `"pnpm test && pnpm build"` | — | Command to run during the validate phase |
| `maxTurns` | `number` (int) | No | `100` | min 10 | Maximum Claude CLI turns per phase |
| `gates` | `Record<string, GateDefinition[]>` | No | See below | — | Gate definitions keyed by issue label |

### `GateDefinitionSchema`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `phase` | `WorkflowPhase` | Yes | — | Enum: `specify`, `clarify`, `plan`, `tasks`, `implement`, `validate` | Phase that triggers gate check |
| `gateLabel` | `string` | Yes | — | — | Label to add when gate is active |
| `condition` | `string` | Yes | — | Enum: `always`, `on-questions`, `on-failure` | When to activate the gate |

### Default `gates` Value

```json
{
  "speckit-feature": [
    { "phase": "clarify", "gateLabel": "waiting-for:clarification", "condition": "always" }
  ],
  "speckit-bugfix": [],
  "speckit-epic": [
    { "phase": "clarify", "gateLabel": "waiting-for:clarification", "condition": "always" },
    { "phase": "tasks", "gateLabel": "waiting-for:tasks-review", "condition": "always" }
  ]
}
```

---

## 4. Environment Variables from `loader.ts`

**Source:** `packages/orchestrator/src/config/loader.ts`

### Config Discovery

Config file search paths (in order):
1. `./orchestrator.yaml`
2. `./orchestrator.yml`
3. `./config/orchestrator.yaml`
4. `./config/orchestrator.yml`

### Merge Precedence

1. Environment variables (highest)
2. Configuration file
3. Schema defaults (lowest)

### Complete Environment Variable Catalog

**Total: 22 unique environment variables** (some have fallback pairs)

#### Server Configuration

| Env Variable | Config Path | Type | Description |
|-------------|-------------|------|-------------|
| `ORCHESTRATOR_PORT` | `server.port` | `number` (parseInt) | Server port |
| `ORCHESTRATOR_HOST` | `server.host` | `string` | Server host |

#### Redis Configuration

| Env Variable | Config Path | Type | Precedence | Description |
|-------------|-------------|------|------------|-------------|
| `REDIS_URL` | `redis.url` | `string` | Primary | Redis connection URL |
| `ORCHESTRATOR_REDIS_URL` | `redis.url` | `string` | Fallback | Redis connection URL (prefixed variant) |

#### Authentication Configuration

| Env Variable | Config Path | Type | Description |
|-------------|-------------|------|-------------|
| `ORCHESTRATOR_AUTH_ENABLED` | `auth.enabled` | `boolean` (`"true"` comparison) | Enable/disable authentication |
| `ORCHESTRATOR_JWT_SECRET` | `auth.jwt.secret` | `string` | JWT secret key |
| `ORCHESTRATOR_JWT_EXPIRES_IN` | `auth.jwt.expiresIn` | `string` | JWT expiration time |
| `GITHUB_CLIENT_ID` | `auth.github.clientId` | `string` | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | `auth.github.clientSecret` | `string` | GitHub OAuth client secret |
| `ORCHESTRATOR_GITHUB_CALLBACK_URL` | `auth.github.callbackUrl` | `string` | GitHub OAuth callback URL |

#### Rate Limiting Configuration

| Env Variable | Config Path | Type | Description |
|-------------|-------------|------|-------------|
| `ORCHESTRATOR_RATE_LIMIT_ENABLED` | `rateLimit.enabled` | `boolean` (`"true"` comparison) | Enable/disable rate limiting |
| `ORCHESTRATOR_RATE_LIMIT_MAX` | `rateLimit.max` | `number` (parseInt) | Maximum requests per window |
| `ORCHESTRATOR_RATE_LIMIT_WINDOW` | `rateLimit.timeWindow` | `string` | Rate limit time window |

#### Logging Configuration

| Env Variable | Config Path | Type | Precedence | Description |
|-------------|-------------|------|------------|-------------|
| `LOG_LEVEL` | `logging.level` | `string` | Primary | Log level |
| `ORCHESTRATOR_LOG_LEVEL` | `logging.level` | `string` | Fallback | Log level (prefixed variant) |
| `ORCHESTRATOR_LOG_PRETTY` | `logging.pretty` | `boolean` (`"true"` comparison) | — | Pretty print logs |

#### Repository Configuration

| Env Variable | Config Path | Type | Precedence | Description |
|-------------|-------------|------|------------|-------------|
| `MONITORED_REPOS` | `repositories[]` | `string` (comma-separated `owner/repo`) | Primary | Monitored repositories |
| `ORCHESTRATOR_REPOSITORIES` | `repositories[]` | `string` (comma-separated `owner/repo`) | Fallback | Monitored repositories (prefixed variant) |

#### Monitor Configuration

| Env Variable | Config Path | Type | Precedence | Description |
|-------------|-------------|------|------------|-------------|
| `POLL_INTERVAL_MS` | `monitor.pollIntervalMs` | `number` (parseInt) | Primary | Monitor polling interval |
| `ORCHESTRATOR_POLL_INTERVAL_MS` | `monitor.pollIntervalMs` | `number` (parseInt) | Fallback | Monitor polling interval (prefixed variant) |
| `WEBHOOK_SECRET` | `monitor.webhookSecret` | `string` | Primary | GitHub webhook secret |
| `ORCHESTRATOR_WEBHOOK_SECRET` | `monitor.webhookSecret` | `string` | Fallback | GitHub webhook secret (prefixed variant) |

#### PR Monitor Configuration

| Env Variable | Config Path | Type | Description |
|-------------|-------------|------|-------------|
| `PR_MONITOR_ENABLED` | `prMonitor.enabled` | `boolean` (`"true"` comparison) | Enable/disable PR monitoring |
| `PR_MONITOR_POLL_INTERVAL_MS` | `prMonitor.pollIntervalMs` | `number` (parseInt) | PR monitor polling interval |
| `PR_MONITOR_WEBHOOK_SECRET` | `prMonitor.webhookSecret` | `string` | PR monitor webhook secret |
| `PR_MONITOR_ADAPTIVE_POLLING` | `prMonitor.adaptivePolling` | `boolean` (`"true"` comparison) | Enable/disable adaptive polling |
| `PR_MONITOR_MAX_CONCURRENT_POLLS` | `prMonitor.maxConcurrentPolls` | `number` (parseInt) | Maximum concurrent polls |

### Variables in `.env.example` (Current)

```
REDIS_URL=redis://localhost:6379
ORCHESTRATOR_PORT=3000
LOG_LEVEL=info
WORKER_CONCURRENCY=2
API_KEY=your-api-key-here
GITHUB_TOKEN=your-github-token
```

**Note:** `WORKER_CONCURRENCY` and `API_KEY` and `GITHUB_TOKEN` appear in `.env.example` but are NOT read by `loader.ts`. They may be consumed by other parts of the system (Docker compose, CLI, etc.).

---

## 5. Existing Reference Docs — Style & Conventions

### Files Reviewed

| File | Sidebar Position | Status per Plan |
|------|-----------------|-----------------|
| `reference/_category_.json` | position: 5 | No change |
| `reference/api/index.md` | — | No change |
| `reference/cli/commands.md` | sidebar_position: 1 | REWRITE |
| `reference/config/agency.md` | sidebar_position: 1 | REWRITE (placeholder) |
| `reference/config/generacy.md` | sidebar_position: 3 | REWRITE |
| `reference/config/humancy.md` | sidebar_position: 2 | Keep as-is |

### Frontmatter Convention

```yaml
---
sidebar_position: <number>
---
```

All docs use only `sidebar_position` in frontmatter. No `title`, `description`, `slug`, or other Docusaurus frontmatter fields are used.

### Documentation Patterns

1. **H1 title**: `# {Name} Configuration Reference` or `# CLI Command Reference`
2. **Opening line**: `Complete reference for all {X} configuration options.`
3. **Config file intro**: Shows the file path and a code block with all top-level keys
4. **Per-field documentation**:
   - H2 heading with field name (e.g., `## version`)
   - Metadata lines: `**Type**: ...`, `**Required**: ...`, `**Default**: ...`
   - Short description paragraph
   - JSON/YAML code block with example
5. **Property tables** for nested objects:
   ```
   | Property | Type | Default | Description |
   |----------|------|---------|-------------|
   ```
6. **Code blocks**: Use ` ```json title="filename.ext" ` with `title=` attribute for file-path context
7. **Complete Example** section at the end of each file
8. **Environment Variables** section at the end with table: `| Variable | Description | Default |`
9. **Cross-references**: Standard markdown links `[text](/docs/reference/config/file)`

### Key Observations for Rewrite

- **All existing config docs are speculative** — they document schemas, commands, and config surfaces that don't exist in the actual codebase
- The generacy.md references `generacy.config.json` (doesn't exist — actual file is `.generacy/config.yaml`)
- The CLI commands doc references commands like `generacy start`, `generacy stop`, `generacy deploy` that don't exist
- The agency.md documents a detailed schema that hasn't been finalized
- Existing docs use JSON examples; actual configs use YAML — new docs should use YAML code blocks
- No `_category_.json` exists inside `config/` subdirectory (Docusaurus auto-generates sidebar from filenames)
