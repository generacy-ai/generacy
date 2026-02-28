---
sidebar_position: 3
---

# Generacy Configuration Reference

Complete reference for the `.generacy/config.yaml` project configuration file.

## Configuration File

Generacy reads project configuration from `.generacy/config.yaml` in your repository root:

```yaml title=".generacy/config.yaml"
schemaVersion: "1"
project:
  id: proj_abc123def
  name: My Project
repos:
  primary: github.com/acme/main-app
defaults:
  agent: claude-code
  baseBranch: develop
orchestrator:
  pollIntervalMs: 30000
  workerCount: 3
```

### File Discovery

The `generacy` CLI walks the directory tree upward from the current working directory looking for `.generacy/config.yaml`. This means you can run commands from any subdirectory of your project.

## Top-Level Structure

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `schemaVersion` | string | No | `"1"` | Schema version for future migration support |
| `project` | object | Yes | — | Project metadata |
| `repos` | object | Yes | — | Repository relationships |
| `defaults` | object | No | — | Workflow execution defaults |
| `orchestrator` | object | No | — | Runtime settings for the orchestrator |

## schemaVersion

**Type**: `string`
**Required**: No
**Default**: `"1"`

Schema version identifier. Used for future migration support. Currently the only valid value is `"1"`. If omitted, defaults to `"1"`.

```yaml
schemaVersion: "1"
```

## project

**Type**: `object`
**Required**: Yes

Project metadata linking this repository to your generacy.ai project.

### project.id

**Type**: `string`
**Required**: Yes
**Format**: `proj_{alphanumeric}` — must match `^proj_[a-z0-9]+$`
**Minimum length**: 12 characters

Unique project ID assigned by generacy.ai. This ID links the local configuration to your project on the platform.

```yaml
project:
  id: proj_abc123def
```

### project.name

**Type**: `string`
**Required**: Yes
**Minimum length**: 1 character
**Maximum length**: 255 characters

Human-readable project name.

```yaml
project:
  name: My Application
```

## repos

**Type**: `object`
**Required**: Yes

Defines repository relationships for the project. All repository URLs use the format `github.com/{owner}/{repo}` — no protocol prefix (`https://`), no `.git` suffix.

### repos.primary

**Type**: `string` (repository URL)
**Required**: Yes
**Format**: `github.com/{owner}/{repo}` — must match `^github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$`

The primary repository for the project. This is where the onboarding PR will be created.

```yaml
repos:
  primary: github.com/acme/main-app
```

### repos.dev

**Type**: `string[]` (array of repository URLs)
**Required**: No
**Default**: `[]`

Development repositories that are cloned for active development. These repos can receive PRs from Generacy.

```yaml
repos:
  primary: github.com/acme/main-app
  dev:
    - github.com/acme/shared-lib
    - github.com/acme/api-service
```

### repos.clone

**Type**: `string[]` (array of repository URLs)
**Required**: No
**Default**: `[]`

Clone-only repositories. These are cloned for reference and reading only — Generacy will not create PRs against them.

```yaml
repos:
  primary: github.com/acme/main-app
  clone:
    - github.com/acme/design-system
    - github.com/acme/documentation
```

### Repository URL Validation

All repository URLs (in `primary`, `dev`, and `clone`) must:

- Match the format `github.com/{owner}/{repo}`
- Not include a protocol prefix (`https://`, `ssh://`)
- Not end with `.git`
- Not contain duplicate entries across all three fields

## defaults

**Type**: `object`
**Required**: No

Default settings for workflow execution. All fields are optional.

### defaults.agent

**Type**: `string`
**Required**: No
**Format**: kebab-case — must match `^[a-z0-9]+(-[a-z0-9]+)*$`

Default agent to use for workflow execution (e.g., `claude-code`, `cursor-agent`).

```yaml
defaults:
  agent: claude-code
```

### defaults.baseBranch

**Type**: `string`
**Required**: No
**Minimum length**: 1 character

Default base branch for creating feature branches. Branch existence is not validated at config time — it is checked at runtime.

```yaml
defaults:
  baseBranch: develop
```

## orchestrator

**Type**: `object`
**Required**: No

Runtime settings for the orchestrator. These values are used when the orchestrator polls for work and manages workers. For the full orchestrator configuration reference (server, Redis, auth, etc.), see the [Orchestrator Configuration](/docs/reference/config/orchestrator).

### orchestrator.pollIntervalMs

**Type**: `integer`
**Required**: No
**Minimum**: `5000`

Polling interval in milliseconds. Controls how frequently the orchestrator checks for new work.

```yaml
orchestrator:
  pollIntervalMs: 30000
```

### orchestrator.workerCount

**Type**: `integer`
**Required**: No
**Minimum**: `1`
**Maximum**: `20`

Maximum number of concurrent workers the orchestrator will run.

```yaml
orchestrator:
  workerCount: 5
```

## Validation

The configuration file is validated against a Zod schema when loaded. Validation includes:

- **Schema validation**: All fields are checked for correct types, formats, and constraints
- **Semantic validation**: No duplicate repository URLs across `primary`, `dev`, and `clone`

If validation fails, the CLI will report the specific field and constraint that was violated.

## Examples

### Minimal Configuration

The smallest valid configuration requires only `project` and `repos`:

```yaml title=".generacy/config.yaml"
project:
  id: proj_abc123def
  name: My Project
repos:
  primary: github.com/acme/main-app
```

### Full Configuration

A configuration with all fields populated:

```yaml title=".generacy/config.yaml"
schemaVersion: "1"

project:
  id: proj_abc123def
  name: My Application

repos:
  primary: github.com/acme/main-app
  dev:
    - github.com/acme/shared-lib
    - github.com/acme/api-service
  clone:
    - github.com/acme/design-system

defaults:
  agent: claude-code
  baseBranch: develop

orchestrator:
  pollIntervalMs: 30000
  workerCount: 5
```

## See Also

- [Orchestrator Configuration](/docs/reference/config/orchestrator) — Full orchestrator server, Redis, auth, and dispatch configuration
- [Environment Variables](/docs/reference/config/environment-variables) — All environment variables reference
- [Docker Compose Configuration](/docs/reference/config/docker-compose) — Service definitions and deployment options
- [CLI Commands](/docs/reference/cli/commands) — `generacy init` generates this file, `generacy validate` checks it
