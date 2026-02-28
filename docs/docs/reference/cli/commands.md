---
sidebar_position: 1
---

# CLI Command Reference

Complete reference for the `generacy` CLI.

## Command Overview

```
generacy [global options] <command> [command options]

Commands:
  init                  Initialize a Generacy project
  doctor                Validate development environment
  validate              Validate .generacy/config.yaml
  run                   Execute a workflow from a file
  worker                Start a worker that processes jobs
  agent                 Start an agent worker with Agency integration
  orchestrator          Start the orchestrator server
  setup                 Dev container setup commands
    setup auth          Configure git and GitHub CLI authentication
    setup workspace     Clone repositories and install dependencies
    setup build         Clean plugins and build packages
    setup services      Start Firebase emulators and API servers
```

## Global Options

These options apply to all commands and must be placed **before** the command name:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-l, --log-level <level>` | `string` | `info` | Log verbosity. Choices: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent` |
| `--no-pretty` | `boolean` | — | Disable pretty logging and output structured JSON instead |
| `-V, --version` | — | — | Print version number |
| `-h, --help` | — | — | Show help |

```bash
generacy --log-level debug worker --url http://localhost:3100
generacy --no-pretty orchestrator
```

---

## generacy init

Initialize a Generacy project in the current repository. Creates a `.generacy/` directory with a `config.yaml` file and optional scaffolding. Runs an interactive wizard when flags are omitted, or can be fully automated with `--yes`.

### Usage

```bash
generacy init [options]
```

### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--project-id <id>` | `string` | — | Link to an existing project (`proj_xxx` format) |
| `--project-name <name>` | `string` | — | Project display name |
| `--primary-repo <repo>` | `string` | — | Primary repository (`github.com/owner/repo`) |
| `--dev-repo <repo...>` | `string[]` | — | Dev repositories (repeatable) |
| `--clone-repo <repo...>` | `string[]` | — | Clone repositories (repeatable) |
| `--agent <agent>` | `string` | `claude-code` | Default agent |
| `--base-branch <branch>` | `string` | `main` | Default base branch |
| `--release-stream <stream>` | `string` | `stable` | Release stream. Choices: `stable`, `preview` |
| `--force` | `boolean` | `false` | Overwrite existing files without prompting |
| `--dry-run` | `boolean` | `false` | Preview files without writing |
| `--skip-github-check` | `boolean` | `false` | Skip GitHub access validation |
| `-y, --yes` | `boolean` | `false` | Accept defaults without prompting |

### Examples

```bash
# Interactive wizard
generacy init

# Fully automated — single-repo project
generacy init \
  --project-id proj_abc123def \
  --project-name "My App" \
  --primary-repo github.com/acme/my-app \
  --yes

# Multi-repo with dev and clone repos
generacy init \
  --project-id proj_abc123def \
  --project-name "Platform" \
  --primary-repo github.com/acme/platform \
  --dev-repo github.com/acme/shared-lib \
  --clone-repo github.com/acme/docs \
  --base-branch develop

# Preview what would be created
generacy init --dry-run
```

---

## generacy doctor

Validate the full development environment setup. Runs a series of health checks and reports pass/fail/warning status for each.

### Usage

```bash
generacy doctor [options]
```

### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--check <name...>` | `string[]` | — | Run only specific checks (and their dependencies) |
| `--skip <name...>` | `string[]` | — | Skip specific checks |
| `-j, --json` | `boolean` | `false` | Output results as JSON |
| `-v, --verbose` | `boolean` | `false` | Show detailed diagnostic information |
| `-f, --fix` | `boolean` | `false` | Attempt to fix detected issues (not yet implemented) |

### Available Checks

| Name | Description |
|------|-------------|
| `docker` | Docker installation |
| `devcontainer` | Dev container setup |
| `config` | Generacy config file |
| `env-file` | Environment file |
| `github-token` | GitHub authentication |
| `anthropic-key` | Anthropic API key |
| `npm-packages` | Node package installation |
| `agency-mcp` | Agency MCP service |

### Examples

```bash
# Run all checks
generacy doctor

# Run only specific checks
generacy doctor --check docker config github-token

# Skip a check
generacy doctor --skip agency-mcp

# JSON output for CI
generacy doctor --json

# Verbose diagnostics
generacy doctor --verbose
```

---

## generacy validate

Validate a `.generacy/config.yaml` file against the configuration schema. Displays a summary of the parsed configuration on success.

### Usage

```bash
generacy validate [config] [options]
```

### Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `config` | No | Path to config file. Auto-discovers `.generacy/config.yaml` if omitted. |

### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-q, --quiet` | `boolean` | `false` | Only output errors |
| `--json` | `boolean` | `false` | Output results as JSON |

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Config is valid |
| `1` | Validation failed |
| `2` | Internal error |

### Examples

```bash
# Validate auto-discovered config
generacy validate

# Validate a specific file
generacy validate ./path/to/config.yaml

# Quiet mode for scripts
generacy validate --quiet

# JSON output
generacy validate --json
```

---

## generacy run

Execute a workflow from a YAML file. Loads the workflow definition, registers built-in actions, and runs each phase and step. Outputs a formatted summary when complete.

### Usage

```bash
generacy run <workflow> [options]
```

### Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `workflow` | Yes | Path to workflow YAML file |

### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-i, --input <key=value...>` | `string[]` | — | Input values for the workflow (repeatable) |
| `-w, --workdir <path>` | `string` | Current directory | Working directory for execution |
| `--dry-run` | `boolean` | `false` | Validate workflow without executing |
| `-v, --verbose` | `boolean` | `false` | Enable verbose output |

### Examples

```bash
# Run a workflow
generacy run ./workflows/deploy.yaml

# With input values
generacy run ./workflows/build.yaml --input branch=main --input target=production

# Dry run to validate
generacy run ./workflows/deploy.yaml --dry-run

# Custom working directory
generacy run ./workflows/build.yaml --workdir /path/to/project
```

---

## generacy worker

Start a worker process that polls the orchestrator for jobs and executes them. Registers with the orchestrator, sends heartbeats, and handles graceful shutdown on `SIGTERM`/`SIGINT`.

### Usage

```bash
generacy worker [options]
```

### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-u, --url <url>` | `string` | `$ORCHESTRATOR_URL` | Orchestrator URL (**required**) |
| `-i, --worker-id <id>` | `string` | Auto-generated | Worker ID |
| `-n, --worker-name <name>` | `string` | `worker-{hostname}` | Worker display name |
| `-c, --capabilities <caps...>` | `string[]` | `[]` | Worker capability tags (repeatable) |
| `-w, --workdir <path>` | `string` | Current directory | Working directory for job execution |
| `-p, --health-port <port>` | `string` | `8080` | Health check HTTP port |
| `--heartbeat-interval <ms>` | `string` | `30000` | Heartbeat interval in milliseconds |
| `--poll-interval <ms>` | `string` | `5000` | Job poll interval in milliseconds |
| `--max-concurrent <n>` | `string` | `1` | Maximum concurrent jobs |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ORCHESTRATOR_URL` | Orchestrator base URL (fallback for `--url`) |
| `HUMANCY_API_URL` | Humancy API URL for human decision handling |
| `HUMANCY_AGENT_ID` | Agent ID for Humancy (defaults to worker ID) |
| `HUMANCY_AUTH_TOKEN` | Auth token for Humancy (falls back to `ORCHESTRATOR_TOKEN`) |

### Examples

```bash
# Start a worker
generacy worker --url http://localhost:3100

# Named worker with capabilities
generacy worker \
  --url http://localhost:3100 \
  --worker-name my-worker \
  --capabilities build test deploy

# Custom poll and heartbeat intervals
generacy worker \
  --url http://localhost:3100 \
  --poll-interval 10000 \
  --heartbeat-interval 15000

# Using environment variable
export ORCHESTRATOR_URL=http://localhost:3100
generacy worker
```

---

## generacy agent

Start an agent worker with Agency integration for AI tool routing. Extends the worker with an Agency connection that provides access to AI tools during job execution.

### Usage

```bash
generacy agent [options]
```

### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-u, --url <url>` | `string` | `$ORCHESTRATOR_URL` | Orchestrator URL (**required**) |
| `-i, --worker-id <id>` | `string` | Auto-generated | Worker ID |
| `-n, --worker-name <name>` | `string` | `agent-{hostname}` | Worker display name |
| `-c, --capabilities <caps...>` | `string[]` | `['agent', 'ai']` | Worker capability tags (repeatable) |
| `-w, --workdir <path>` | `string` | Current directory | Working directory for job execution |
| `-p, --health-port <port>` | `string` | `8080` | Health check HTTP port |
| `--heartbeat-interval <ms>` | `string` | `30000` | Heartbeat interval in milliseconds |
| `--poll-interval <ms>` | `string` | `5000` | Job poll interval in milliseconds |
| `--agency-mode <mode>` | `string` | `subprocess` | Agency connection mode: `subprocess` or `network` |
| `--agency-url <url>` | `string` | `$AGENCY_URL` | Agency URL (for `network` mode) |
| `--agency-command <cmd>` | `string` | `npx @anthropic-ai/agency` | Agency command (for `subprocess` mode) |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ORCHESTRATOR_URL` | Orchestrator base URL (fallback for `--url`) |
| `AGENCY_URL` | Agency server URL for network mode |
| `AGENCY_MODE` | Agency mode preference (`subprocess` or `network`) |

### Examples

```bash
# Start agent with subprocess mode (default)
generacy agent --url http://localhost:3100

# Network mode connecting to a running Agency server
generacy agent \
  --url http://localhost:3100 \
  --agency-mode network \
  --agency-url http://localhost:4000

# Custom capabilities
generacy agent \
  --url http://localhost:3100 \
  --capabilities agent ai code-review
```

---

## generacy orchestrator

Start the orchestrator HTTP server that coordinates workers and distributes jobs. Optionally enables GitHub label monitoring for automatic job creation.

### Usage

```bash
generacy orchestrator [options]
```

### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-p, --port <port>` | `string` | `3100` | HTTP server port |
| `-h, --host <host>` | `string` | `0.0.0.0` | Host to bind to |
| `--worker-timeout <ms>` | `string` | `60000` | Worker heartbeat timeout in milliseconds |
| `--auth-token <token>` | `string` | `$ORCHESTRATOR_TOKEN` | Authentication token |
| `--redis-url <url>` | `string` | `$REDIS_URL` | Redis URL for persistent job queue |
| `--label-monitor` | `boolean` | `false` | Enable GitHub label monitoring |
| `--poll-interval <ms>` | `string` | `30000` | Label monitor poll interval in milliseconds |
| `--monitored-repos <repos>` | `string` | `$MONITORED_REPOS` | Comma-separated `owner/repo` list |

:::note
The CLI default port is `3100`, while the [orchestrator config schema](/docs/reference/config/orchestrator) defaults to `3000`. When running via the CLI without an orchestrator config file, port `3100` is used. When running with a config file that omits `server.port`, port `3000` is used.
:::

:::note
When no `--redis-url` is provided the orchestrator falls back to an in-memory job queue. This is fine for development but not suitable for production.
:::

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ORCHESTRATOR_TOKEN` | Authentication token |
| `REDIS_URL` | Redis connection URL |
| `LABEL_MONITOR_ENABLED` | Enable label monitoring (`true`/`false`) |
| `POLL_INTERVAL_MS` | Label monitor poll interval |
| `MONITORED_REPOS` | Comma-separated repos to monitor (`owner/repo`) |
| `SMEE_CHANNEL_URL` | Smee.io channel URL for webhook events |

### API Endpoints

The orchestrator exposes the following HTTP API:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/workers/register` | Register a worker |
| `DELETE` | `/api/workers/:workerId` | Deregister a worker |
| `POST` | `/api/workers/:workerId/heartbeat` | Worker heartbeat |
| `GET` | `/api/jobs/poll` | Poll for available jobs |
| `GET` | `/api/jobs/:jobId` | Get job details |
| `PUT` | `/api/jobs/:jobId/status` | Update job status |
| `POST` | `/api/jobs/:jobId/result` | Submit job result |
| `POST` | `/api/jobs/:jobId/cancel` | Cancel a job |

### Examples

```bash
# Start with defaults (in-memory queue, port 3100)
generacy orchestrator

# Production with Redis
generacy orchestrator \
  --port 3100 \
  --auth-token my-secret \
  --redis-url redis://localhost:6379

# With label monitoring
generacy orchestrator \
  --label-monitor \
  --monitored-repos acme/app,acme/lib \
  --poll-interval 60000

# Using environment variables
export ORCHESTRATOR_TOKEN=my-secret
export REDIS_URL=redis://localhost:6379
export LABEL_MONITOR_ENABLED=true
export MONITORED_REPOS=acme/app,acme/lib
generacy orchestrator
```

---

## generacy setup

Parent command for dev container setup subcommands. Run `generacy setup --help` to list subcommands.

### generacy setup auth

Configure git credentials and GitHub CLI authentication inside the dev container.

#### Usage

```bash
generacy setup auth [options]
```

#### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--email <email>` | `string` | `$GH_EMAIL` | Git user email |
| `--username <name>` | `string` | `$GH_USERNAME` | Git user name |

#### Environment Variables

| Variable | Description |
|----------|-------------|
| `GH_EMAIL` | Git user email |
| `GH_USERNAME` | Git user name |
| `GH_TOKEN` | GitHub token for authentication |

#### Examples

```bash
# Using environment variables (typical in dev container)
generacy setup auth

# Explicit values
generacy setup auth --email dev@example.com --username myname
```

---

### generacy setup workspace

Clone repositories and install dependencies for all projects in the workspace.

#### Usage

```bash
generacy setup workspace [options]
```

#### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--repos <repos>` | `string` | `$REPOS` or all default repos | Comma-separated list of repos to clone |
| `--branch <branch>` | `string` | `$REPO_BRANCH` / `$DEFAULT_BRANCH` / `develop` | Target branch |
| `--workdir <dir>` | `string` | `/workspaces` | Workspace root directory |
| `--clean` | `boolean` | `$CLEAN_REPOS` | Hard reset repos before updating |

#### Default Repositories

When `--repos` is omitted and `$REPOS` is not set, the following repos are cloned:

- `tetrad-development`
- `contracts`
- `latency`
- `agency`
- `generacy`
- `humancy`
- `generacy-cloud`
- `humancy-cloud`

#### Environment Variables

| Variable | Description |
|----------|-------------|
| `REPOS` | Comma-separated list of repos |
| `REPO_BRANCH` / `DEFAULT_BRANCH` | Branch to checkout |
| `CLEAN_REPOS` | Hard reset flag (`true`/`false`) |
| `GITHUB_ORG` | GitHub organization (default: `generacy-ai`) |
| `GH_TOKEN` | GitHub token |
| `GH_USERNAME` | GitHub username |

#### Examples

```bash
# Clone all default repos
generacy setup workspace

# Specific repos only
generacy setup workspace --repos generacy,agency,latency

# Different branch
generacy setup workspace --branch feature/my-feature

# Clean slate
generacy setup workspace --clean
```

---

### generacy setup build

Clean Claude plugin state and build Agency and Generacy packages. Runs three phases that can be individually skipped.

#### Usage

```bash
generacy setup build [options]
```

#### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--skip-cleanup` | `boolean` | `false` | Skip Phase 1: Claude plugin state cleanup |
| `--skip-agency` | `boolean` | `false` | Skip Phase 2: Agency package build |
| `--skip-generacy` | `boolean` | `false` | Skip Phase 3: Generacy package build |

#### Build Phases

1. **Clean Claude plugin state** — Removes marketplace caches, resets installed plugins, clears enabledPlugins from settings
2. **Build Agency packages** — Builds the `latency` dependency, installs and builds `agency`, creates `.agency/config.json` if needed
3. **Build Generacy packages** — Installs dependencies, builds all packages, links the `generacy` CLI globally

#### Examples

```bash
# Full build (all phases)
generacy setup build

# Skip plugin cleanup
generacy setup build --skip-cleanup

# Only build Generacy
generacy setup build --skip-cleanup --skip-agency
```

---

### generacy setup services

Start Firebase emulators and API dev servers for local development.

#### Usage

```bash
generacy setup services [options]
```

#### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--only <target>` | `string` | `all` | Start only specific services. Choices: `all`, `generacy`, `humancy` |
| `--skip-api` | `boolean` | `false` | Start only emulators without API servers |
| `--timeout <seconds>` | `string` | `60` | Health check timeout in seconds |

#### Service Ports

| Service | Firestore | Auth | Emulator UI | API |
|---------|-----------|------|-------------|-----|
| Generacy | 8080 | 9099 | 4000 | 3010 |
| Humancy | 8081 | 9199 | 4001 | 3002 |

#### Examples

```bash
# Start everything
generacy setup services

# Generacy only
generacy setup services --only generacy

# Emulators only, no API servers
generacy setup services --skip-api

# Longer timeout for slow machines
generacy setup services --timeout 120
```

---

## Configuration Resolution

All commands follow the same precedence order when resolving configuration values:

1. **CLI flags** — highest priority
2. **Environment variables** — when the flag is not set
3. **Schema defaults** — when neither flag nor env var is set

For example, the orchestrator port resolves as: `--port` flag > hard-coded default (`3100`).

## Signals and Shutdown

The `worker`, `agent`, `orchestrator`, and `setup services` commands handle `SIGTERM` and `SIGINT` for graceful shutdown. They will:

1. Stop accepting new work
2. Wait for in-flight operations to complete (with a timeout)
3. Deregister from the orchestrator (workers/agents)
4. Exit cleanly

## See Also

- [Generacy Configuration](/docs/reference/config/generacy) — `.generacy/config.yaml` schema reference
- [Orchestrator Configuration](/docs/reference/config/orchestrator) — Orchestrator config schema and env var mapping
- [Environment Variables](/docs/reference/config/environment-variables) — Consolidated environment variable reference
- [Docker Compose Configuration](/docs/reference/config/docker-compose) — Service definitions and deployment options
