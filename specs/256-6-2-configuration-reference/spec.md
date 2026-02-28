# Feature Specification: 6.2 — Configuration Reference

**Branch**: `256-6-2-configuration-reference` | **Date**: 2026-02-28 | **Status**: Draft

## Summary

Create a comprehensive configuration reference documenting every configurable surface in the Generacy platform. This covers five reference sections: `.generacy/config.yaml` project schema, `agency.config.json` Agency extension schema, environment variables, Docker Compose service configuration, and CLI command reference. Each section includes the full schema with field descriptions, types, defaults, constraints, and working examples. The reference serves as the canonical source of truth for developers, platform operators, and CI/CD pipeline authors.

### Dependencies

- **4.2** (#248) — `.generacy/config.yaml` schema (provides Zod schemas and validation logic)
- **5.1** (agency#294) — Agency VS Code extension MVP (provides `agency.config.json` schema)

### Plan Reference

[onboarding-buildout-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md) — Issue 6.2

---
### Execution
**Phase:** 6 — Documentation
**Blocked by:**
- [ ] generacy-ai/generacy#248 — Define .generacy/config.yaml schema
- [ ] generacy-ai/agency#294 — Agency VS Code extension MVP

---

## User Stories

### US1: Config.yaml Schema Lookup

**As a** developer writing or editing `.generacy/config.yaml`,
**I want** a complete schema reference with field descriptions, types, defaults, and constraints,
**So that** I can configure my project correctly without reading source code.

**Acceptance Criteria**:
- [ ] Every field in `GeneracyConfigSchema` is documented with type, default, constraints, and description
- [ ] Required vs optional fields are clearly indicated
- [ ] Validation rules (regex patterns, min/max values) are specified for each constrained field
- [ ] Minimal, single-repo, and multi-repo example configs are provided
- [ ] Config discovery mechanism is documented (env var → explicit path → directory walk)

### US2: Agency Config Reference

**As a** developer configuring the Agency VS Code extension,
**I want** a reference for `agency.config.json` fields,
**So that** I can set up plugins, modes, and containers correctly.

**Acceptance Criteria**:
- [ ] Every field in `agency.config.json` is documented with type and description
- [ ] The relationship between Agency config and the Generacy platform is explained
- [ ] A working example config is provided

### US3: Environment Variables Reference

**As a** platform operator deploying Generacy services,
**I want** a complete list of environment variables with descriptions and defaults,
**So that** I can configure services for production without guessing variable names.

**Acceptance Criteria**:
- [ ] Every environment variable is documented with name, description, default value, and which service consumes it
- [ ] Variables are grouped by service/concern (Redis, Orchestrator, Worker, Auth, Agency, Humancy, Label Monitor)
- [ ] The `.env.example` template is referenced as the starting point
- [ ] Required vs optional variables are distinguished

### US4: Docker Compose Reference

**As a** platform operator customizing a Generacy deployment,
**I want** documentation of all Docker Compose services, ports, volumes, and override options,
**So that** I can adapt the deployment to my infrastructure.

**Acceptance Criteria**:
- [ ] All services in `docker-compose.yml` are documented (orchestrator, worker, redis)
- [ ] Port mappings, volume mounts, and network configuration are listed
- [ ] The override file (`docker-compose.override.yml`) and worker-specific compose file are documented
- [ ] Worker scaling (replicas) and resource configuration are explained

### US5: CLI Command Reference

**As a** developer using the Generacy CLI,
**I want** a complete reference for every command, subcommand, flag, and exit code,
**So that** I can use the CLI effectively and integrate it into scripts.

**Acceptance Criteria**:
- [ ] Every CLI command is documented with synopsis, description, options, and examples
- [ ] Option types (string, boolean, repeatable) and defaults are specified
- [ ] Exit codes are documented per command
- [ ] Commands are listed with a brief description for quick scanning

---

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Document `.generacy/config.yaml` full schema: `schemaVersion`, `project` (`id`, `name`), `repos` (`primary`, `dev`, `clone`), `defaults` (`agent`, `baseBranch`), `orchestrator` (`pollIntervalMs`, `workerCount`) | P1 | Source: `packages/generacy/src/config/schema.ts` |
| FR-002 | Document config discovery chain: `GENERACY_CONFIG_PATH` env var → `--config` flag → directory walk up to `.git/` boundary | P1 | Source: `packages/generacy/src/config/loader.ts` |
| FR-003 | Document validation layers: structural (Zod), semantic (no duplicate repos), and what is not validated (branch existence, repo accessibility, agent registry) | P1 | Two-layer validation with clear error classes |
| FR-004 | Document config error classes: `ConfigNotFoundError`, `ConfigParseError`, `ConfigSchemaError`, `ConfigValidationError` | P2 | Helps developers understand error output |
| FR-005 | Document `agency.config.json` schema: `version`, `plugins`, `modes` (with `id`, `name`, `tools`), `containers` | P1 | Source: `.agency/agency.config.json` |
| FR-006 | Document all environment variables grouped by service with name, description, type, default, and required status | P1 | Source: `.env.example` and service startup code |
| FR-007 | Document `docker-compose.yml` services: orchestrator (port 3000), worker (2 replicas), redis (port 6379) | P1 | Include environment variables, volumes, networks |
| FR-008 | Document `docker/docker-compose.worker.yml` for standalone worker deployment | P2 | Separate compose for worker-only setups |
| FR-009 | Document `docker-compose.override.yml` for development overrides (hot-reloading, volume mounts) | P2 | Development-specific configuration |
| FR-010 | Document `generacy init` command with all options and interactive/non-interactive flows | P1 | Flags: `--project-id`, `--project-name`, `--primary-repo`, `--dev-repo`, `--clone-repo`, `--agent`, `--base-branch`, `--force`, `--dry-run`, `--skip-github-check`, `-y` |
| FR-011 | Document `generacy setup` command and subcommands (auth, workspace, build, services) | P1 | Dev container setup flow |
| FR-012 | Document `generacy worker` command with all options | P1 | Flags: `-u`, `-i`, `-n`, `-c`, `-w`, `-p`, `--heartbeat-interval`, `--poll-interval`, `--max-concurrent` |
| FR-013 | Document `generacy agent` command with Agency integration options | P1 | Flags: `--agency-mode`, `--agency-url`, `--agency-command` |
| FR-014 | Document `generacy orchestrator` command with server and monitor options | P1 | Flags: `-p`, `-h`, `--worker-timeout`, `--auth-token`, `--redis-url`, `--label-monitor`, `--poll-interval`, `--monitored-repos` |
| FR-015 | Document `generacy run` command for workflow execution | P1 | Flags: `-i`, `-w`, `--dry-run`, `-v` |
| FR-016 | Document `generacy validate` command for config validation | P1 | Flags: `-q`, `--json` |
| FR-017 | Document `generacy doctor` command with all checks | P1 | Checks: Docker, config, .env, devcontainer, GitHub token, Anthropic key, npm, Agency MCP |
| FR-018 | Document exit code conventions across all commands | P2 | 0 = success, 1 = user error, 2 = API error, 130 = cancelled |
| FR-019 | Provide copy-pastable examples for every configuration section | P1 | Minimal, typical, and advanced examples |
| FR-020 | Document orchestrator config schema: `server`, `redis`, `auth`, `rateLimit`, `cors`, `logging`, `repositories`, `monitor`, `prMonitor`, `epicMonitor`, `dispatch`, `worker` | P2 | Source: `packages/orchestrator/src/config/schema.ts` |

---

## Reference Content Structure

### Section 1: `.generacy/config.yaml`

```yaml
# Schema Version (optional, defaults to "1")
schemaVersion: "1"

# Project — required
project:
  id: "proj_abc123xyz"        # Format: proj_{alphanumeric}, min 12 chars
  name: "My Project"          # 1–255 characters

# Repositories — required
repos:
  primary: "github.com/acme/main-api"      # Required, format: github.com/{owner}/{repo}
  dev:                                       # Optional, default: []
    - "github.com/acme/shared-lib"
  clone:                                     # Optional, default: []
    - "github.com/acme/design-system"

# Defaults — optional
defaults:
  agent: "claude-code"         # Optional, kebab-case
  baseBranch: "main"           # Optional, min 1 char

# Orchestrator — optional
orchestrator:
  pollIntervalMs: 5000         # Optional, min 5000
  workerCount: 3               # Optional, range 1–20
```

**Field Reference:**

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `schemaVersion` | string | No | `"1"` | — | Schema version for future migration support |
| `project.id` | string | Yes | — | Regex `^proj_[a-z0-9]+$`, min 12 chars | Server-issued project identifier |
| `project.name` | string | Yes | — | 1–255 chars | Human-readable project name |
| `repos.primary` | string | Yes | — | Format `github.com/{owner}/{repo}` | Primary repository where config lives |
| `repos.dev` | string[] | No | `[]` | Each entry: `github.com/{owner}/{repo}` | Active development repositories |
| `repos.clone` | string[] | No | `[]` | Each entry: `github.com/{owner}/{repo}` | Read-only reference repositories |
| `defaults.agent` | string | No | — | Kebab-case (`^[a-z][a-z0-9-]*$`) | Default agent for workflows |
| `defaults.baseBranch` | string | No | — | Min 1 char | Default base branch for PRs |
| `orchestrator.pollIntervalMs` | number | No | — | Min 5000 | Job poll interval in milliseconds |
| `orchestrator.workerCount` | number | No | — | 1–20 | Number of concurrent workers |

**Validation Rules:**
- No repository may appear in more than one list (`primary`, `dev`, `clone`)
- No duplicates within a single list
- Repository URLs must not include protocol prefix or `.git` suffix

**Config Discovery:**
1. `GENERACY_CONFIG_PATH` environment variable (absolute path) — highest priority
2. `--config` CLI flag (explicit path) — second priority
3. Auto-discovery: walk up from current directory, check `.generacy/config.yaml` at each level, stop at `.git/` boundary

**Error Classes:**

| Error | Cause | Context Provided |
|-------|-------|------------------|
| `ConfigNotFoundError` | No config file found at any search path | List of searched paths |
| `ConfigParseError` | Invalid YAML syntax | File path, parse error details |
| `ConfigSchemaError` | Zod validation failure | Dotted field paths (e.g., `repos.primary`) |
| `ConfigValidationError` | Semantic rule violation | Conflicting repository entries |

---

### Section 2: `agency.config.json`

```json
{
  "version": "1.0.0",
  "plugins": [],
  "modes": [
    {
      "id": "default",
      "name": "Default",
      "tools": []
    }
  ],
  "containers": []
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | string | Yes | Schema version (semver) |
| `plugins` | array | Yes | List of Agency plugin configurations |
| `modes` | array | Yes | Agent operating modes with available tools |
| `modes[].id` | string | Yes | Unique mode identifier |
| `modes[].name` | string | Yes | Human-readable mode name |
| `modes[].tools` | array | Yes | Tools available in this mode |
| `containers` | array | Yes | Container configurations for isolated execution |

**File Location:** `.agency/agency.config.json` in the repository root.

---

### Section 3: Environment Variables

#### Redis

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` | No |

#### Orchestrator

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `ORCHESTRATOR_URL` | Orchestrator service URL | — | Yes (for workers) |
| `ORCHESTRATOR_TOKEN` | Authentication token for orchestrator API | — | Yes (if auth enabled) |
| `ORCHESTRATOR_PORT` | HTTP port for orchestrator server | `3000` | No |
| `LOG_LEVEL` | Logging level (`trace`, `debug`, `info`, `warn`, `error`) | `info` | No |

#### Worker

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `WORKER_CONCURRENCY` | Number of concurrent jobs | `2` | No |
| `WORKER_ID` | Worker identifier | Auto-generated | No |
| `HEALTH_PORT` | Health check endpoint port | `8080` | No |
| `HEARTBEAT_INTERVAL` | Heartbeat interval in milliseconds | `30000` | No |
| `POLL_INTERVAL` | Job poll interval in milliseconds | `5000` | No |

#### Authentication

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `API_KEY` | API key for service authentication | — | Conditional |
| `GITHUB_TOKEN` | GitHub personal access token | — | Yes (for GitHub operations) |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key | — | Yes (for agent execution) |

#### Agency

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `AGENCY_MODE` | Agency invocation mode: `subprocess` or `network` | `subprocess` | No |
| `AGENCY_URL` | Agency URL (required when `AGENCY_MODE=network`) | — | Conditional |
| `AGENCY_COMMAND` | Agency command for subprocess mode | `npx @anthropic-ai/agency` | No |

#### Humancy (Decision Handler)

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `HUMANCY_API_URL` | Humancy API endpoint | — | Yes (if using Humancy) |
| `HUMANCY_AGENT_ID` | Humancy agent identifier | — | Yes (if using Humancy) |
| `HUMANCY_AUTH_TOKEN` | Humancy authentication token | — | Yes (if using Humancy) |

#### Label Monitor

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `LABEL_MONITOR_ENABLED` | Enable GitHub label monitoring | `false` | No |
| `MONITORED_REPOS` | Comma-separated `owner/repo` list | — | Yes (if label monitor enabled) |
| `POLL_INTERVAL_MS` | Label monitor poll interval in milliseconds | `30000` | No |
| `SMEE_CHANNEL_URL` | Smee.io webhook proxy channel URL | — | No |

---

### Section 4: Docker Compose Configuration

#### Main: `docker-compose.yml`

**Services:**

| Service | Image | Ports | Description |
|---------|-------|-------|-------------|
| `orchestrator` | Built from source | `3000:3000` | API server, job dispatch, GitHub monitoring |
| `worker` | Built from source | — | Job executor (2 replicas by default) |
| `redis` | `redis:7-alpine` | `6379:6379` | Job queue and state store |

**Key Environment Variables (per service):**

| Service | Variable | Value |
|---------|----------|-------|
| orchestrator | `NODE_ENV` | `development` |
| orchestrator | `REDIS_URL` | `redis://redis:6379` |
| orchestrator | `LOG_LEVEL` | `debug` |
| worker | `ORCHESTRATOR_URL` | `http://orchestrator:3000` |
| worker | `REDIS_URL` | `redis://redis:6379` |

**Volumes:**
- `redis-data` — persistent Redis storage at `/data`

#### Worker-Only: `docker/docker-compose.worker.yml`

For standalone worker deployments without the orchestrator:

| Service | Ports | Description |
|---------|-------|-------------|
| `worker` | `3001:3001` | Single worker with health endpoint |
| `redis` | `6379:6379` | Dedicated Redis instance |

**Worker-Specific Variables:**

| Variable | Value | Description |
|----------|-------|-------------|
| `WORKER_ID` | `worker-local-1` | Explicit worker identifier |
| `HEALTH_PORT` | `3001` | Health check port |
| `HEARTBEAT_ENABLED` | `true` | Enable heartbeat reporting |
| `HEARTBEAT_INTERVAL` | `5000` | Heartbeat interval (ms) |
| `POLL_INTERVAL` | `1000` | Job poll interval (ms) |
| `GRACEFUL_SHUTDOWN_TIMEOUT` | `60000` | Shutdown grace period (ms) |

#### Development Override: `docker-compose.override.yml`

Applied automatically in development for:
- Source volume mounts for hot-reloading
- Debug port exposure
- Development-only environment variables

---

### Section 5: CLI Command Reference

#### `generacy init`

Initialize a Generacy project in the current Git repository.

```
generacy init [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--project-id <id>` | string | — | Link to existing project (`proj_` format) |
| `--project-name <name>` | string | — | Project display name |
| `--primary-repo <repo>` | string | Auto-detect | Primary repository (`github.com/owner/repo`) |
| `--dev-repo <repo>` | string[] | `[]` | Dev repository (repeatable) |
| `--clone-repo <repo>` | string[] | `[]` | Clone repository (repeatable) |
| `--agent <agent>` | string | `claude-code` | Default agent |
| `--base-branch <branch>` | string | `main` | Default base branch |
| `--release-stream <stream>` | string | `stable` | `stable` or `preview` |
| `--force` | boolean | `false` | Overwrite existing files |
| `--dry-run` | boolean | `false` | Preview without writing |
| `--skip-github-check` | boolean | `false` | Skip GitHub access validation |
| `-y, --yes` | boolean | `false` | Accept defaults without prompting |

```bash
# Interactive setup
generacy init

# Non-interactive single-repo setup
generacy init --project-name "My API" --primary-repo "github.com/acme/api" -y

# Link to existing project
generacy init --project-id proj_abc123xyz

# Multi-repo setup
generacy init \
  --project-name "Platform" \
  --primary-repo "github.com/acme/api" \
  --dev-repo "github.com/acme/shared-lib" \
  --clone-repo "github.com/acme/design-system" -y
```

---

#### `generacy setup`

Dev container setup commands.

```
generacy setup <subcommand>
```

| Subcommand | Description |
|------------|-------------|
| `auth` | Configure authentication credentials |
| `workspace` | Set up workspace directories and repos |
| `build` | Build project dependencies |
| `services` | Start background services (Redis, orchestrator) |

---

#### `generacy worker`

Start a worker that processes jobs from the orchestrator.

```
generacy worker [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-u, --url <url>` | string | `$ORCHESTRATOR_URL` | Orchestrator URL |
| `-i, --worker-id <id>` | string | Auto-generated | Worker identifier |
| `-n, --worker-name <name>` | string | `worker-{hostname}` | Worker display name |
| `-c, --capabilities <caps>` | string[] | `[]` | Worker capabilities/tags |
| `-w, --workdir <path>` | string | `process.cwd()` | Working directory |
| `-p, --health-port <port>` | number | `8080` | Health check port |
| `--heartbeat-interval <ms>` | number | `30000` | Heartbeat interval (ms) |
| `--poll-interval <ms>` | number | `5000` | Job poll interval (ms) |
| `--max-concurrent <n>` | number | `1` | Maximum concurrent jobs |

```bash
# Start with defaults
generacy worker -u http://localhost:3000

# Named worker with capabilities
generacy worker -u http://orchestrator:3000 \
  -n "gpu-worker-1" \
  -c gpu large-context \
  --max-concurrent 3
```

---

#### `generacy agent`

Start an agent worker with Agency integration.

```
generacy agent [options]
```

Inherits all `generacy worker` options, plus:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--agency-mode <mode>` | string | `subprocess` | `subprocess` or `network` |
| `--agency-url <url>` | string | — | Agency URL (required for `network` mode) |
| `--agency-command <cmd>` | string | `npx @anthropic-ai/agency` | Agency command for subprocess mode |

```bash
# Subprocess mode (default)
generacy agent -u http://localhost:3000

# Network mode
generacy agent -u http://localhost:3000 \
  --agency-mode network \
  --agency-url http://agency:8000
```

---

#### `generacy orchestrator`

Start the orchestrator server.

```
generacy orchestrator [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-p, --port <port>` | number | `3100` | HTTP port |
| `-h, --host <host>` | string | `0.0.0.0` | Host to bind |
| `--worker-timeout <ms>` | number | `60000` | Worker heartbeat timeout (ms) |
| `--auth-token <token>` | string | — | Authentication token |
| `--redis-url <url>` | string | — | Redis URL for job queue |
| `--label-monitor` | boolean | `false` | Enable GitHub label monitoring |
| `--poll-interval <ms>` | number | `30000` | Label monitor poll interval (ms) |
| `--monitored-repos <repos>` | string | — | Comma-separated `owner/repo` list |

```bash
# Basic start
generacy orchestrator --redis-url redis://localhost:6379

# With label monitoring
generacy orchestrator \
  --redis-url redis://localhost:6379 \
  --label-monitor \
  --monitored-repos "acme/api,acme/web" \
  --auth-token "$ORCHESTRATOR_TOKEN"
```

---

#### `generacy run`

Execute a workflow from a file.

```
generacy run <workflow-file> [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-i, --input <key=value>` | string[] | `[]` | Input values (repeatable) |
| `-w, --workdir <path>` | string | `process.cwd()` | Working directory |
| `--dry-run` | boolean | `false` | Validate without executing |
| `-v, --verbose` | boolean | `false` | Verbose output |

```bash
# Run a workflow
generacy run .generacy/workflows/deploy.yaml

# With inputs
generacy run .generacy/workflows/feature.yaml \
  -i branch=feature/auth \
  -i reviewer=@alice

# Dry run to validate
generacy run .generacy/workflows/deploy.yaml --dry-run
```

---

#### `generacy validate`

Validate `.generacy/config.yaml`.

```
generacy validate [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-q, --quiet` | boolean | `false` | Only output errors |
| `--json` | boolean | `false` | Output as JSON |

```bash
# Validate config
generacy validate

# JSON output for CI
generacy validate --json
```

---

#### `generacy doctor`

Validate the full development environment.

```
generacy doctor [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--check <name>` | string[] | All | Run specific checks only |
| `--skip <name>` | string[] | None | Skip specific checks |
| `-j, --json` | boolean | `false` | Output as JSON |
| `-v, --verbose` | boolean | `false` | Show detailed diagnostics |
| `-f, --fix` | boolean | `false` | Attempt to fix issues (not yet implemented) |

**Available Checks:**

| Check Name | Description |
|------------|-------------|
| `docker` | Docker installation and daemon status |
| `config` | `.generacy/config.yaml` validity |
| `env` | `.env` file presence and required variables |
| `devcontainer` | Dev container configuration |
| `github-token` | GitHub token availability and validity |
| `anthropic-key` | Anthropic API key availability |
| `npm` | NPM packages and dependencies |
| `agency-mcp` | Agency MCP server availability |

```bash
# Full environment check
generacy doctor

# Specific checks only
generacy doctor --check docker config github-token

# JSON output for CI
generacy doctor --json
```

---

#### Exit Codes

All CLI commands follow consistent exit code conventions:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | User error or validation failure |
| `2` | API or service error |
| `130` | User cancelled (Ctrl+C) |

---

### Orchestrator Config Schema

The orchestrator uses a separate configuration loaded from environment variables and `OrchestratorConfigSchema`:

| Section | Field | Type | Default | Description |
|---------|-------|------|---------|-------------|
| `server` | `port` | number | `3000` | HTTP port (0–65535) |
| `server` | `host` | string | `0.0.0.0` | Bind host |
| `redis` | `url` | string | `redis://localhost:6379` | Redis connection URL |
| `auth` | `enabled` | boolean | `true` | Enable authentication |
| `auth` | `providers` | string[] | — | `apiKey`, `github-oauth2` |
| `auth.github` | `clientId` | string | — | GitHub OAuth client ID |
| `auth.github` | `clientSecret` | string | — | GitHub OAuth client secret |
| `auth.github` | `callbackUrl` | string | — | OAuth callback URL |
| `auth.jwt` | `secret` | string | — | JWT signing secret (min 32 chars) |
| `auth.jwt` | `expiresIn` | string | `24h` | JWT token expiry |
| `rateLimit` | `enabled` | boolean | `true` | Enable rate limiting |
| `rateLimit` | `max` | number | `100` | Max requests per time window |
| `rateLimit` | `timeWindow` | string | `1 minute` | Rate limit window |
| `cors` | `origin` | boolean/string/string[] | — | Allowed origins |
| `cors` | `credentials` | boolean | `true` | Allow credentials |
| `logging` | `level` | string | `info` | Log level |
| `logging` | `pretty` | boolean | `false` | Pretty-print logs |
| `monitor` | `pollIntervalMs` | number | `30000` | Label monitor poll (min 5000) |
| `monitor` | `maxConcurrentPolls` | number | `5` | Concurrent polls (1–20) |
| `monitor` | `adaptivePolling` | boolean | `true` | Adaptive poll intervals |
| `prMonitor` | `enabled` | boolean | `true` | Enable PR monitoring |
| `prMonitor` | `pollIntervalMs` | number | `60000` | PR poll interval (min 5000) |
| `epicMonitor` | `enabled` | boolean | `true` | Enable epic monitoring |
| `epicMonitor` | `pollIntervalMs` | number | `300000` | Epic poll interval (min 60000) |
| `dispatch` | `pollIntervalMs` | number | `5000` | Dispatch poll (min 1000) |
| `dispatch` | `maxConcurrentWorkers` | number | `3` | Max concurrent workers (1–20) |
| `dispatch` | `heartbeatTtlMs` | number | `30000` | Heartbeat TTL (min 5000) |
| `dispatch` | `maxRetries` | number | `3` | Max job retries (min 1) |
| `dispatch` | `shutdownTimeoutMs` | number | `60000` | Graceful shutdown timeout (min 5000) |

---

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Schema field coverage | 100% of fields in `GeneracyConfigSchema` documented | Cross-reference spec tables against Zod schema source |
| SC-002 | Environment variable coverage | 100% of variables in `.env.example` documented | Cross-reference spec tables against `.env.example` |
| SC-003 | CLI command coverage | 100% of registered commands and flags documented | Cross-reference spec against Commander.js command registrations |
| SC-004 | Example coverage | Every configuration section has at least one working example | Review each section for copy-pastable examples |
| SC-005 | Accuracy | 0 discrepancies between documentation and implementation | Automated validation or manual audit against source code |
| SC-006 | Docker Compose coverage | All services, ports, and volumes documented | Cross-reference against `docker-compose.yml` and related files |

---

## Assumptions

- The Zod schemas in `packages/generacy/src/config/schema.ts` and `packages/orchestrator/src/config/schema.ts` are the canonical source of truth for config validation
- The `.env.example` file is kept up to date with all supported environment variables
- CLI commands are registered via Commander.js and the source in `packages/generacy/src/cli/` reflects the current command surface
- The `agency.config.json` schema is still evolving and may require updates after Agency extension MVP (#294) ships
- Docker Compose files in the repository root represent the canonical deployment topology
- This reference will be published as part of the documentation site (tracked separately)

## Out of Scope

- **Tutorials and guides** — this is a reference, not a getting-started guide (covered by other documentation issues)
- **API endpoint documentation** — REST/SSE API docs for the orchestrator are a separate concern
- **Workflow YAML schema** — workflow definition files (`.generacy/workflows/*.yaml`) have their own schema reference
- **VS Code extension settings** — extension-specific `settings.json` keys are documented in the extension's marketplace page
- **Infrastructure provisioning** — Terraform, Kubernetes, or cloud deployment configs are not part of this reference
- **Version migration guides** — documenting how to migrate between schema versions is deferred until schema v2

---

*Generated by speckit*
