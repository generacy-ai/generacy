---
sidebar_position: 7
---

# Verify Setup

Before running your first workflow, verify that your Generacy setup is correct. This page walks through the built-in verification commands, organized by adoption level.

## Level 1: Config-Only Verification

Level 1 setups only need valid configuration and credentials. Use `generacy validate` and `generacy doctor` to confirm everything is in order.

### Validate Configuration

Run `generacy validate` to check that your `.generacy/config.yaml` is syntactically and semantically valid:

```bash
generacy validate
```

Expected output for a valid configuration:

```
✓ Configuration is valid

Config file: .generacy/config.yaml

Project:
  ID: proj_myproject456
  Name: My Project

Repositories:
  Primary: github.com/myorg/main-app

Defaults:
  Agent: claude-code
  Base branch: main
```

If validation fails, the command prints specific error messages with the path to the offending field:

```
✗ Configuration is invalid

  repos.primary: must be a valid GitHub URL (github.com/{owner}/{repo})
```

Fix the reported issues and re-run `generacy validate` until the configuration passes.

### Run Doctor

Run `generacy doctor` for a comprehensive environment check that validates your entire setup — system dependencies, configuration, credentials, and services:

```bash
generacy doctor
```

Expected output when all checks pass:

```
Generacy Doctor
===============

System
  ✓ Docker           Docker daemon is running (v27.0.3)
  ✓ Dev Container    .devcontainer/devcontainer.json present

Configuration
  ✓ Config File      Config file is valid (.generacy/config.yaml)
  ✓ Env File         .generacy/generacy.env found with required keys

Credentials
  ✓ GitHub Token     Token is valid, has required scopes (repo, workflow)
  ✓ Anthropic Key    API key is valid

Packages
  ✓ NPM Packages     @generacy-ai/generacy installed (compatible version)

Services
  ✓ Agency MCP       Agency MCP server is healthy

Result: 8 passed, 0 failed, 0 warnings, 0 skipped
```

#### Check statuses

| Symbol | Status | Meaning |
|--------|--------|---------|
| ✓ | Pass | Check succeeded |
| ✗ | Fail | Check failed — an actionable suggestion is provided |
| ! | Warn | Check passed with a warning |
| - | Skip | Check was skipped (usually because a dependency failed) |

#### What the doctor checks

The doctor runs eight checks across five categories:

| Category | Check | What It Verifies |
|----------|-------|-----------------|
| **System** | Docker | Docker daemon is running and reachable |
| **System** | Dev Container | `.devcontainer/devcontainer.json` exists and includes the Generacy feature |
| **Configuration** | Config File | `.generacy/config.yaml` exists with valid YAML, schema, and semantics |
| **Configuration** | Env File | `.generacy/generacy.env` exists with `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` |
| **Credentials** | GitHub Token | Token is valid and has the required `repo` and `workflow` scopes |
| **Credentials** | Anthropic Key | API key is valid against the Anthropic API |
| **Packages** | NPM Packages | `@generacy-ai/generacy` is installed at a compatible version |
| **Services** | Agency MCP | Agency MCP server responds to health checks (if `AGENCY_URL` is set) |

Checks have dependencies — for example, credential checks depend on the env file check, so if the env file is missing, credential checks are skipped rather than failing with a confusing error.

#### Running specific checks

To run only certain checks (and their dependencies):

```bash
generacy doctor --check github-token anthropic-key
```

To skip checks that aren't relevant to your setup:

```bash
generacy doctor --skip docker dev-container
```

#### JSON output

For scripting or CI, use `--json` to get structured output:

```bash
generacy doctor --json
```

```json
{
  "version": "0.1.0",
  "timestamp": "2026-02-28T12:00:00.000Z",
  "summary": {
    "passed": 8,
    "failed": 0,
    "warnings": 0,
    "skipped": 0
  },
  "checks": [
    {
      "name": "docker",
      "category": "system",
      "status": "pass",
      "message": "Docker daemon is running (v27.0.3)",
      "duration_ms": 150
    }
  ]
}
```

### What to Do If Checks Fail

If `generacy doctor` reports failures:

1. **Read the suggestion** — each failed check includes a `→` line with a recommended fix
2. **Fix the issue** — follow the suggestion (e.g., start Docker, set a missing token)
3. **Re-run doctor** — confirm the fix resolved the issue

Common failure examples:

```
Configuration
  ✗ Env File         .generacy/generacy.env not found
    → Run `generacy init` to generate the env file
```

```
Credentials
  ✗ GitHub Token     Token is invalid or missing required scopes
    → Create a new PAT at https://github.com/settings/tokens/new with repo and workflow scopes
```

For a full list of common issues and solutions, see [Troubleshooting](./troubleshooting.md).

## Level 2+: Workflow Submission Verification

:::info
Level 2+ workflow submission requires the Humancy component. If you haven't set up Humancy yet, skip this section and proceed to [First Workflow](./first-workflow.md) for Level 1 verification.
:::

Once your Level 1 checks pass and Humancy is configured, verify that you can submit workflows to the Generacy platform.

### Verify on the Dashboard

Open the Generacy dashboard to confirm your project is accessible:

1. Go to [generacy.ai](https://generacy.ai) and sign in
2. Navigate to your project
3. Confirm the project details match your `config.yaml` settings

<!-- Screenshot placeholder: dashboard showing project overview -->

If the project does not appear, check that:
- Your `GITHUB_TOKEN` has the correct scopes (see [Authentication](./authentication.md))
- Your `config.yaml` project ID matches the project on generacy.ai (see [Configuration](./configuration.md))
- You're signed in to the correct account on the dashboard

## Next Steps

With your setup verified, proceed to [First Workflow](./first-workflow.md) to run your first real workflow with an AI agent.
