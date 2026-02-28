# T002: CLI Command Sources Catalog

Research output for task T002. This file catalogs every CLI command, its flags/options, global options, and all environment variables referenced in command files.

---

## 1. CLI Entry Point & Global Options

**Source:** `packages/generacy/src/cli/index.ts`

### Program Metadata

- **Name:** `generacy`
- **Description:** "Generacy CLI - Headless workflow execution engine"
- **Version:** `0.0.1` (hardcoded; comment: "will be replaced at build time")
- **Framework:** Commander.js

### Global Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-l, --log-level <level>` | `string` (choices: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`) | `'info'` | Log level |
| `--no-pretty` | `boolean` (negation flag) | `true` (pretty is on by default, `--no-pretty` disables it) | Disable pretty logging (use JSON output) |
| `-V, --version` | built-in | `0.0.1` | Display version |

**Note:** A `preAction` hook reads `logLevel` and `pretty` from global options, creates a Pino logger via `createLogger()`, and sets it as the global default logger for all commands.

---

## 2. Command Catalog

### Command Tree

```
generacy [global options]
  ├── run <workflow>             Execute a workflow from a file
  ├── worker                     Start a worker that processes jobs from the orchestrator
  ├── agent                      Start an agent worker with Agency integration
  ├── orchestrator               Start the orchestrator server
  ├── validate [config]          Validate .generacy/config.yaml file
  ├── doctor                     Validate the full development environment setup
  ├── init                       Initialize a Generacy project in the current repository
  └── setup                      Dev container setup commands
       ├── auth                  Configure git credentials and GitHub CLI authentication
       ├── workspace             Clone repositories and install dependencies
       ├── build                 Clean plugins, build Agency and Generacy packages
       └── services              Start Firebase emulators and API servers
```

---

### `generacy init`

**Source:** `packages/generacy/src/cli/commands/init/index.ts`
**Description:** "Initialize a Generacy project in the current repository"

| Flag | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `--project-id <id>` | `string` | Optional | — | Link to existing project (proj_xxx format) |
| `--project-name <name>` | `string` | Optional | — | Project display name |
| `--primary-repo <repo>` | `string` | Optional | — | Primary repository (github.com/owner/repo) |
| `--dev-repo <repo...>` | `string[]` | Optional | — | Dev repository (repeatable) |
| `--clone-repo <repo...>` | `string[]` | Optional | — | Clone repository (repeatable) |
| `--agent <agent>` | `string` | Optional | `'claude-code'` | Default agent |
| `--base-branch <branch>` | `string` | Optional | `'main'` | Default base branch |
| `--release-stream <stream>` | `string` (choices: `stable`, `preview`) | Optional | `'stable'` | Release stream |
| `--force` | `boolean` | Optional | `false` | Overwrite existing files without prompting |
| `--dry-run` | `boolean` | Optional | `false` | Preview files without writing |
| `--skip-github-check` | `boolean` | Optional | `false` | Skip GitHub access validation |
| `-y, --yes` | `boolean` | Optional | `false` | Accept defaults without prompting |

**Environment variables:**
- `GITHUB_TOKEN` — used in `init/github.ts` for GitHub API access validation (before falling back to `gh auth token`)

---

### `generacy doctor`

**Source:** `packages/generacy/src/cli/commands/doctor.ts`
**Description:** "Validate the full development environment setup"

| Flag | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `--check <name...>` | `string[]` | Optional | — | Run only specific checks (and their dependencies) |
| `--skip <name...>` | `string[]` | Optional | — | Skip specific checks |
| `-j, --json` | `boolean` | Optional | `false` | Output results as JSON |
| `-v, --verbose` | `boolean` | Optional | `false` | Show detailed diagnostic information |
| `-f, --fix` | `boolean` | Optional | `false` | Attempt to fix detected issues (not yet implemented) |

**Built-in checks** (registered in `createDefaultRegistry()`):

| Check ID | Label | Category | Priority | Dependencies |
|----------|-------|----------|----------|--------------|
| `docker` | Docker | system | — | — |
| `devcontainer` | Devcontainer | system | — | — |
| `config` | Config | config | — | — |
| `env-file` | Env File | config | — | — |
| `github-token` | GitHub Token | credentials | — | — |
| `anthropic-key` | Anthropic Key | credentials | — | — |
| `npm-packages` | NPM Packages | packages | — | — |
| `agency-mcp` | Agency MCP | services | P2 | — |

**Environment variables (used by doctor runner/checks):**
- `REMOTE_CONTAINERS` — detected to determine if running inside a dev container (`doctor/runner.ts`)
- `AGENCY_URL` — used by the `agency-mcp` check (`doctor/checks/agency-mcp.ts`)
- `NO_COLOR` — detected by the formatter to disable color output (`doctor/formatter.ts`)

---

### `generacy validate`

**Source:** `packages/generacy/src/cli/commands/validate.ts`
**Description:** "Validate .generacy/config.yaml file"

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `[config]` (argument) | `string` | Optional | Auto-discovered | Path to config file |
| `-q, --quiet` | `boolean` | Optional | `false` | Only output errors (no success messages) |
| `--json` | `boolean` | Optional | `false` | Output results as JSON |

**Environment variables:** None directly referenced.

---

### `generacy run`

**Source:** `packages/generacy/src/cli/commands/run.ts`
**Description:** "Execute a workflow from a file"

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `<workflow>` (argument) | `string` | **Required** | — | Path to workflow YAML file |
| `-i, --input <key=value...>` | `string[]` | Optional | `[]` | Input values for the workflow (repeatable, key=value format) |
| `-w, --workdir <path>` | `string` | Optional | `process.cwd()` | Working directory for execution |
| `--dry-run` | `boolean` | Optional | `false` | Validate workflow without executing |
| `-v, --verbose` | `boolean` | Optional | `false` | Enable verbose output |

**Environment variables:**
- `process.env` — passed in bulk as the environment for workflow execution (not specific variables; the entire env is forwarded)

---

### `generacy worker`

**Source:** `packages/generacy/src/cli/commands/worker.ts`
**Description:** "Start a worker that processes jobs from the orchestrator"

| Flag | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `-u, --url <url>` | `string` | Effectively required (validated in action) | `process.env['ORCHESTRATOR_URL']` | Orchestrator URL |
| `-i, --worker-id <id>` | `string` | Optional | Auto-generated UUID | Worker ID |
| `-n, --worker-name <name>` | `string` | Optional | `worker-{hostname}` | Worker name |
| `-c, --capabilities <caps...>` | `string[]` | Optional | `[]` | Worker capabilities/tags (variadic) |
| `-w, --workdir <path>` | `string` | Optional | `process.cwd()` | Working directory for job execution |
| `-p, --health-port <port>` | `string` (parsed as int) | Optional | `'8080'` | Health check port |
| `--heartbeat-interval <ms>` | `string` (parsed as int) | Optional | `'30000'` | Heartbeat interval in milliseconds |
| `--poll-interval <ms>` | `string` (parsed as int) | Optional | `'5000'` | Job poll interval in milliseconds |
| `--max-concurrent <n>` | `string` (parsed as int) | Optional | `'1'` | Maximum concurrent jobs |

**Environment variables:**
- `ORCHESTRATOR_URL` — default for `--url`
- `HUMANCY_API_URL` — enables Humancy API decision handler when set
- `HUMANCY_AGENT_ID` — agent ID for Humancy (defaults to workerId)
- `HUMANCY_AUTH_TOKEN` — auth token for Humancy (falls back to `ORCHESTRATOR_TOKEN`)
- `ORCHESTRATOR_TOKEN` — fallback for Humancy auth token

---

### `generacy agent`

**Source:** `packages/generacy/src/cli/commands/agent.ts`
**Description:** "Start an agent worker with Agency integration for AI tool routing"

| Flag | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `-u, --url <url>` | `string` | Effectively required (validated in action) | `process.env['ORCHESTRATOR_URL']` | Orchestrator URL |
| `-i, --worker-id <id>` | `string` | Optional | Auto-generated UUID | Worker ID |
| `-n, --worker-name <name>` | `string` | Optional | `agent-{hostname}` | Worker name |
| `-c, --capabilities <caps...>` | `string[]` | Optional | `['agent', 'ai']` | Worker capabilities/tags (variadic) |
| `-w, --workdir <path>` | `string` | Optional | `process.cwd()` | Working directory for job execution |
| `-p, --health-port <port>` | `string` (parsed as int) | Optional | `'8080'` | Health check port |
| `--heartbeat-interval <ms>` | `string` (parsed as int) | Optional | `'30000'` | Heartbeat interval in milliseconds |
| `--poll-interval <ms>` | `string` (parsed as int) | Optional | `'5000'` | Job poll interval in milliseconds |
| `--agency-mode <mode>` | `string` | Optional | `'subprocess'` | Agency mode: `subprocess` or `network` |
| `--agency-url <url>` | `string` | Optional | `process.env['AGENCY_URL']` | Agency URL for network mode |
| `--agency-command <cmd>` | `string` | Optional | `'npx @anthropic-ai/agency'` | Agency command for subprocess mode |

**Note:** The `agent` command shares most flags with `worker` but adds agency-specific options and uses different defaults (`worker-name` prefix is `agent-` instead of `worker-`, default capabilities include `['agent', 'ai']`). It does **not** have `--max-concurrent`.

**Environment variables:**
- `ORCHESTRATOR_URL` — default for `--url`
- `AGENCY_URL` — default for `--agency-url`

---

### `generacy orchestrator`

**Source:** `packages/generacy/src/cli/commands/orchestrator.ts`
**Description:** "Start the orchestrator server that coordinates workers and distributes jobs"

| Flag | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `-p, --port <port>` | `string` (parsed as int) | Optional | `'3100'` | HTTP server port |
| `-h, --host <host>` | `string` | Optional | `'0.0.0.0'` | Host to bind to |
| `--worker-timeout <ms>` | `string` (parsed as int) | Optional | `'60000'` | Worker heartbeat timeout in milliseconds |
| `--auth-token <token>` | `string` | Optional | — | Authentication token (or set `ORCHESTRATOR_TOKEN` env var) |
| `--redis-url <url>` | `string` | Optional | — | Redis URL for persistent job queue (or set `REDIS_URL` env var) |
| `--label-monitor` | `boolean` | Optional | `false` | Enable GitHub label monitoring (or set `LABEL_MONITOR_ENABLED=true`) |
| `--poll-interval <ms>` | `string` (parsed as int) | Optional | — | Label monitor poll interval in milliseconds (or set `POLL_INTERVAL_MS`) |
| `--monitored-repos <repos>` | `string` | Optional | — | Comma-separated owner/repo list (or set `MONITORED_REPOS`) |

**Notable:** `-h` is used for `--host`, which shadows Commander.js's built-in `-h` for `--help`. Users must use `--help` (long form) to get help for this command.

**Notable:** CLI default port is `3100`, but the orchestrator config schema default is `3000`. This is a discrepancy — the CLI provides a different default than the config schema.

**Environment variables:**
- `REDIS_URL` — fallback for `--redis-url`
- `ORCHESTRATOR_TOKEN` — checked to determine if auth is enabled
- `LABEL_MONITOR_ENABLED` — if `'true'`, enables label monitor
- `MONITORED_REPOS` — comma-separated owner/repo list, fallback for `--monitored-repos`
- `POLL_INTERVAL_MS` — fallback for `--poll-interval` (default `'30000'` if not set)
- `SMEE_CHANNEL_URL` — if set, enables smee.io webhook receiver (reduces polling to 5-minute fallback)

---

### `generacy setup`

**Source:** `packages/generacy/src/cli/commands/setup.ts`
**Description:** "Dev container setup commands"

Parent command with 4 subcommands. No options of its own.

---

#### `generacy setup auth`

**Source:** `packages/generacy/src/cli/commands/setup/auth.ts`
**Description:** "Configure git credentials and GitHub CLI authentication"

| Flag | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `--email <email>` | `string` | Optional | `process.env['GH_EMAIL']` | Git user email |
| `--username <name>` | `string` | Optional | `process.env['GH_USERNAME']` | Git user name |

**Environment variables:**
- `GH_EMAIL` — fallback for `--email`
- `GH_USERNAME` — fallback for `--username`
- `GH_TOKEN` — used internally for git credential setup and `gh` CLI auth (not a CLI flag)

---

#### `generacy setup workspace`

**Source:** `packages/generacy/src/cli/commands/setup/workspace.ts`
**Description:** "Clone repositories and install dependencies"

| Flag | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `--repos <repos>` | `string` (comma-separated) | Optional | `REPOS` env, or hardcoded default list | Comma-separated list of repos to clone |
| `--branch <branch>` | `string` | Optional | `REPO_BRANCH` / `DEFAULT_BRANCH` env, or `'develop'` | Target branch |
| `--workdir <dir>` | `string` | Optional | `'/workspaces'` | Workspace root directory |
| `--clean` | `boolean` | Optional | `CLEAN_REPOS` env or `false` | Hard reset repos before updating |

**Default repos list:** `tetrad-development`, `contracts`, `latency`, `agency`, `generacy`, `humancy`, `generacy-cloud`, `humancy-cloud`

**Environment variables:**
- `REPOS` — comma-separated list of repos (fallback for `--repos`)
- `REPO_BRANCH` — target branch (fallback for `--branch`)
- `DEFAULT_BRANCH` — secondary fallback for branch
- `CLEAN_REPOS` — if `'true'`, enables clean mode
- `GITHUB_ORG` — GitHub organization (default: `'generacy-ai'`)
- `GH_TOKEN` — used internally for git credential setup
- `GH_USERNAME` — used internally for credential user (default: `'git'`)

---

#### `generacy setup build`

**Source:** `packages/generacy/src/cli/commands/setup/build.ts`
**Description:** "Clean plugins, build Agency and Generacy packages"

| Flag | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `--skip-cleanup` | `boolean` | Optional | `false` | Skip Phase 1: Claude plugin state cleanup |
| `--skip-agency` | `boolean` | Optional | `false` | Skip Phase 2: Agency package build |
| `--skip-generacy` | `boolean` | Optional | `false` | Skip Phase 3: Generacy package build |

**Environment variables:** None directly referenced (paths are hardcoded defaults: `/workspaces/agency`, `/workspaces/generacy`, `/workspaces/latency`).

---

#### `generacy setup services`

**Source:** `packages/generacy/src/cli/commands/setup/services.ts`
**Description:** "Start Firebase emulators and API servers"

| Flag | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `--only <target>` | `string` (choices: `all`, `generacy`, `humancy`) | Optional | `'all'` | Start only generacy or humancy services |
| `--skip-api` | `boolean` | Optional | `false` | Start only emulators without API servers |
| `--timeout <seconds>` | `string` (parsed as number) | Optional | `'60'` | Health check timeout in seconds |

**Environment variables (passed when spawning API servers):**
- `STRIPE_API_KEY` — passed to API server (default: `'sk_test_dev_placeholder'`)
- `STRIPE_SECRET_KEY` — passed to API server (default: `'sk_test_dev_placeholder'`)
- `STRIPE_WEBHOOK_SECRET` — passed to API server (default: `'whsec_test_dev_placeholder'`)

---

## 3. CLI Utility: Config Resolution

**Source:** `packages/generacy/src/cli/utils/config.ts`

Defines the `CLIConfig` interface and `readEnvConfig()` function which reads environment variables as a middle layer between defaults and CLI args.

**Priority order:** CLI args > env vars > defaults

---

## 4. Complete Environment Variable Summary (CLI Only)

All `process.env` references found across CLI command files and utilities:

| Variable | Used In | Purpose |
|----------|---------|---------|
| `DEBUG` | `cli/index.ts` | Show stack traces on errors |
| `LOG_LEVEL` | `utils/config.ts`, `utils/logger.ts` | Override log level |
| `NODE_ENV` | `utils/config.ts`, `utils/logger.ts` | If `'production'`, disables pretty logging |
| `GENERACY_PRETTY_LOG` | `utils/config.ts` | Override pretty log setting (`'true'`/`'false'`) |
| `GENERACY_WORKFLOW_FILE` | `utils/config.ts` | Default workflow file path |
| `GENERACY_WORKDIR` | `utils/config.ts` | Default working directory |
| `ORCHESTRATOR_URL` | `utils/config.ts`, `commands/worker.ts`, `commands/agent.ts` | Orchestrator URL default |
| `ORCHESTRATOR_TOKEN` | `commands/orchestrator.ts`, `commands/worker.ts` | Authentication token |
| `WORKER_ID` | `utils/config.ts` | Worker ID |
| `HEALTH_PORT` | `utils/config.ts` | Health check port |
| `HEARTBEAT_INTERVAL` | `utils/config.ts` | Heartbeat interval (ms) |
| `POLL_INTERVAL` | `utils/config.ts` | Job poll interval (ms) |
| `AGENCY_MODE` | `utils/config.ts` | Agency mode (subprocess/network) |
| `AGENCY_URL` | `utils/config.ts`, `commands/agent.ts`, `doctor/checks/agency-mcp.ts` | Agency URL for network mode |
| `AGENCY_COMMAND` | `utils/config.ts` | Agency command for subprocess mode |
| `REDIS_URL` | `commands/orchestrator.ts` | Redis URL for job queue |
| `LABEL_MONITOR_ENABLED` | `commands/orchestrator.ts` | Enable label monitoring (`'true'`) |
| `MONITORED_REPOS` | `commands/orchestrator.ts` | Comma-separated owner/repo list |
| `POLL_INTERVAL_MS` | `commands/orchestrator.ts` | Label monitor poll interval |
| `SMEE_CHANNEL_URL` | `commands/orchestrator.ts` | Smee.io webhook channel URL |
| `GH_EMAIL` | `commands/setup/auth.ts` | Git user email |
| `GH_USERNAME` | `commands/setup/auth.ts`, `commands/setup/workspace.ts` | Git user name |
| `GH_TOKEN` | `commands/setup/auth.ts`, `commands/setup/workspace.ts` | GitHub token for credentials |
| `REPOS` | `commands/setup/workspace.ts` | Comma-separated repos list |
| `REPO_BRANCH` | `commands/setup/workspace.ts` | Target branch |
| `DEFAULT_BRANCH` | `commands/setup/workspace.ts` | Fallback target branch |
| `CLEAN_REPOS` | `commands/setup/workspace.ts` | Clean mode (`'true'`) |
| `GITHUB_ORG` | `commands/setup/workspace.ts` | GitHub organization (default: `'generacy-ai'`) |
| `GITHUB_TOKEN` | `commands/init/github.ts` | GitHub API token for repo access validation |
| `HUMANCY_API_URL` | `commands/worker.ts` | Enables Humancy API decision handler |
| `HUMANCY_AGENT_ID` | `commands/worker.ts` | Agent ID for Humancy |
| `HUMANCY_AUTH_TOKEN` | `commands/worker.ts` | Auth token for Humancy |
| `STRIPE_API_KEY` | `commands/setup/services.ts` | Passed to API server processes |
| `STRIPE_SECRET_KEY` | `commands/setup/services.ts` | Passed to API server processes |
| `STRIPE_WEBHOOK_SECRET` | `commands/setup/services.ts` | Passed to API server processes |
| `REMOTE_CONTAINERS` | `commands/doctor/runner.ts` | Detects dev container environment |
| `NO_COLOR` | `commands/doctor/formatter.ts` | Disables color output |

**Total: 36 unique environment variables referenced across CLI code.**

---

## 5. Observations & Discrepancies

1. **Port default mismatch:** The `generacy orchestrator` CLI defaults to port `3100`, but the `OrchestratorConfigSchema` server.port default is `3000`. The plan flagged this for verification — confirmed: CLI default is `3100`.

2. **`-h` shadowing:** The `orchestrator` command uses `-h` for `--host`, which shadows Commander's built-in `-h` for `--help`. Users must type `generacy orchestrator --help` instead of `generacy orchestrator -h`.

3. **`agent` vs `worker` overlap:** The `agent` command duplicates most of `worker`'s flags but adds `--agency-mode`, `--agency-url`, `--agency-command`, and omits `--max-concurrent`. Default `worker-name` prefix differs (`agent-` vs `worker-`), and default capabilities differ (`['agent', 'ai']` vs `[]`).

4. **Environment variable coverage gaps:** Several variables in the CLI (`DEBUG`, `NODE_ENV`, `GENERACY_PRETTY_LOG`, `GENERACY_WORKFLOW_FILE`, `GENERACY_WORKDIR`, `WORKER_ID`, `HEALTH_PORT`, `HEARTBEAT_INTERVAL`, `POLL_INTERVAL`, `AGENCY_MODE`, `AGENCY_COMMAND`) are read via `utils/config.ts` but not documented in the plan's env var list. These should be included in the environment variables reference doc.

5. **`POLL_INTERVAL` vs `POLL_INTERVAL_MS`:** Two different variables — `POLL_INTERVAL` (in `utils/config.ts`, for job poll interval) and `POLL_INTERVAL_MS` (in `commands/orchestrator.ts`, for label monitor poll interval). Easy to confuse.

6. **Undocumented `--max-concurrent` flag:** The `worker` command has `--max-concurrent <n>` which is not mentioned in the plan's T009 sub-task for the worker command.
