---
sidebar_position: 1
---

# CLI Command Reference

Complete reference for Generacy CLI commands.

## Agency CLI

### agency init

Initialize Agency in a project.

```bash
agency init [options]
```

| Option | Description |
|--------|-------------|
| `--force` | Overwrite existing configuration |
| `--type <type>` | Project type (node, python, go) |
| `--minimal` | Create minimal configuration |

**Examples:**
```bash
agency init
agency init --type node
agency init --force --minimal
```

### agency status

Show Agency status.

```bash
agency status [options]
```

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

### agency tools

Manage Agency tools.

```bash
agency tools <command> [options]
```

| Command | Description |
|---------|-------------|
| `list` | List available tools |
| `info <tool>` | Show tool details |
| `enable <tool>` | Enable a tool |
| `disable <tool>` | Disable a tool |

**Examples:**
```bash
agency tools list
agency tools info file-search
agency tools enable task-management
```

### agency plugin

Manage Agency plugins.

```bash
agency plugin <command> [options]
```

| Command | Description |
|---------|-------------|
| `list` | List installed plugins |
| `install <name>` | Install a plugin |
| `uninstall <name>` | Remove a plugin |
| `create <name>` | Create new plugin |
| `test <path>` | Test a plugin |

**Examples:**
```bash
agency plugin list
agency plugin install @generacy/plugin-jest
agency plugin create my-custom-tool
agency plugin test ./plugins/my-plugin
```

### agency config

Manage Agency configuration.

```bash
agency config <command> [options]
```

| Command | Description |
|---------|-------------|
| `show` | Show effective config |
| `validate` | Validate configuration |
| `set <key> <value>` | Set config value |
| `get <key>` | Get config value |

### agency mcp

Start MCP server.

```bash
agency mcp [options]
```

| Option | Description |
|--------|-------------|
| `--stdio` | Use stdio transport |
| `--port <port>` | HTTP port |

## Humancy CLI

### humancy init

Initialize Humancy in a project.

```bash
humancy init [options]
```

| Option | Description |
|--------|-------------|
| `--force` | Overwrite existing configuration |

### humancy workflow

Manage workflows.

```bash
humancy workflow <command> [options]
```

| Command | Description |
|---------|-------------|
| `list` | List workflows |
| `show <name>` | Show workflow details |
| `validate <file>` | Validate workflow file |
| `test <file>` | Test workflow |
| `trigger <name>` | Trigger workflow |

**Examples:**
```bash
humancy workflow list
humancy workflow show deploy
humancy workflow validate ./workflows/deploy.yml
humancy workflow trigger deploy --input branch=main
```

### humancy gate

Manage review gates.

```bash
humancy gate <command> [options]
```

| Command | Description |
|---------|-------------|
| `list` | List pending gates |
| `show <id>` | Show gate details |
| `approve <id>` | Approve a gate |
| `reject <id>` | Reject a gate |

**Examples:**
```bash
humancy gate list
humancy gate show gate_123
humancy gate approve gate_123 --comment "LGTM"
humancy gate reject gate_123 --reason "Needs tests"
```

### humancy config

Manage Humancy configuration.

```bash
humancy config <command> [options]
```

| Command | Description |
|---------|-------------|
| `show` | Show effective config |
| `validate` | Validate configuration |

### humancy mcp

Start MCP server.

```bash
humancy mcp [options]
```

## Generacy CLI

### generacy start

Start Generacy services.

```bash
generacy start [options]
```

| Option | Description |
|--------|-------------|
| `--local` | Run in local mode |
| `--workers <n>` | Number of workers |
| `--port <port>` | HTTP port |
| `--detach` | Run in background |

**Examples:**
```bash
generacy start --local
generacy start --workers 4 --port 3000
generacy start --detach
```

### generacy stop

Stop Generacy services.

```bash
generacy stop [options]
```

| Option | Description |
|--------|-------------|
| `--force` | Force stop |

### generacy status

Show Generacy status.

```bash
generacy status [options]
```

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--workers` | Show worker details |
| `--queue` | Show queue stats |

### generacy job

Manage jobs.

```bash
generacy job <command> [options]
```

| Command | Description |
|---------|-------------|
| `list` | List jobs |
| `show <id>` | Show job details |
| `create <type>` | Create a job |
| `cancel <id>` | Cancel a job |
| `retry <id>` | Retry a job |

**Examples:**
```bash
generacy job list --status pending
generacy job show job_123
generacy job create process-issue --data '{"url":"..."}'
generacy job cancel job_123
generacy job retry job_456
```

### generacy workflow

Manage workflows.

```bash
generacy workflow <command> [options]
```

| Command | Description |
|---------|-------------|
| `list` | List workflows |
| `show <id>` | Show workflow |
| `trigger <name>` | Trigger workflow |
| `cancel <id>` | Cancel run |

### generacy integration

Manage integrations.

```bash
generacy integration <command> [options]
```

| Command | Description |
|---------|-------------|
| `list` | List integrations |
| `status <name>` | Show status |
| `connect <name>` | Connect integration |
| `disconnect <name>` | Disconnect integration |

**Examples:**
```bash
generacy integration list
generacy integration status github
generacy integration connect github
```

### generacy config

Manage Generacy configuration.

```bash
generacy config <command> [options]
```

| Command | Description |
|---------|-------------|
| `show` | Show effective config |
| `validate` | Validate configuration |

### generacy deploy

Deploy Generacy to cloud.

```bash
generacy deploy [options]
```

| Option | Description |
|--------|-------------|
| `--env <env>` | Target environment |
| `--dry-run` | Preview changes |

### generacy logs

View Generacy logs.

```bash
generacy logs [options]
```

| Option | Description |
|--------|-------------|
| `--follow` | Follow log output |
| `--tail <n>` | Number of lines |
| `--service <name>` | Filter by service |
| `--level <level>` | Filter by level |

**Examples:**
```bash
generacy logs --follow
generacy logs --tail 100 --service worker
generacy logs --level error
```

## Global Options

These options are available for all commands:

| Option | Description |
|--------|-------------|
| `--help` | Show help |
| `--version` | Show version |
| `--verbose` | Verbose output |
| `--quiet` | Suppress output |
| `--config <path>` | Config file path |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GENERACY_HOME` | Generacy home directory |
| `GENERACY_CONFIG` | Config file path |
| `GENERACY_LOG_LEVEL` | Log level |
| `NO_COLOR` | Disable colors |
