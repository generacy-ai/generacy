# Feature Specification: `generacy doctor` Command

**Branch**: `254-5-6-generacy-cli` | **Date**: 2026-02-26 | **Status**: Draft

## Summary

Implement the `generacy doctor` command — a comprehensive diagnostic tool that validates a developer's full Generacy setup and reports the health of every dependency, configuration file, credential, and service. The command runs a series of ordered checks, produces color-coded pass/fail/warning output, and provides actionable fix suggestions for every failure. This is the single command a developer runs to answer "is my environment ready to use Generacy?"

The command is implemented as `packages/generacy/src/cli/commands/doctor.ts`, registered alongside existing commands (`validate`, `setup`, `run`, etc.) in the CLI entry point, and follows the same Commander.js patterns used throughout the CLI.

### Plan Reference

[onboarding-buildout-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md) — Issue 5.6

### Dependencies

- **#248 — Define `.generacy/config.yaml` schema** (complete): Config validation, discovery, and error classes are implemented in `packages/generacy/src/config/`

### Execution

**Phase:** 2

---

## User Stories

### US1: First-Time Setup Validation

**As a** developer who just onboarded a project to Generacy,
**I want** to run a single command that checks everything is configured correctly,
**So that** I can identify and fix setup problems before attempting to run workflows.

**Acceptance Criteria**:
- [ ] Running `generacy doctor` with no arguments performs all checks
- [ ] Each check displays a clear pass, fail, or warning status
- [ ] Failed checks include a human-readable suggestion for how to fix the issue
- [ ] The command exits with code 0 when all checks pass, non-zero otherwise

### US2: Troubleshooting a Broken Environment

**As a** developer whose workflows have stopped working,
**I want** `generacy doctor` to pinpoint which part of my environment is broken,
**So that** I can fix the specific issue without debugging the entire stack.

**Acceptance Criteria**:
- [ ] Checks run in dependency order (e.g., config is validated before checking tokens referenced in env)
- [ ] A failure in an early check marks dependent checks as "skipped" rather than producing cascading false errors
- [ ] Output clearly separates each check category with headers
- [ ] Verbose mode (`--verbose`) shows additional diagnostic details (paths searched, scopes found, versions detected)

### US3: CI/Automation Integration

**As a** DevOps engineer scripting environment validation,
**I want** machine-readable output from `generacy doctor`,
**So that** I can integrate health checks into automated pipelines.

**Acceptance Criteria**:
- [ ] `--json` flag outputs results as a JSON object with status per check
- [ ] `--quiet` flag suppresses all output except the final exit code
- [ ] Exit codes distinguish between all-pass (0), any-fail (1), and runtime error (2)

### US4: Selective Check Execution

**As a** developer who only changed one thing (e.g., rotated an API key),
**I want** to run a specific subset of checks,
**So that** I get a fast answer without waiting for all checks.

**Acceptance Criteria**:
- [ ] `--check <name>` option runs only the named check (e.g., `--check github-token`)
- [ ] `--skip <name>` option skips the named check
- [ ] Available check names are listed in `--help` output

---

## Functional Requirements

### Check Execution Framework

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Implement a `DoctorCheck` interface with `name`, `run()`, `category`, and `dependsOn` | P1 | Each check is a self-contained module implementing this interface |
| FR-002 | Execute checks in dependency-resolved order within categories | P1 | Categories: Environment, Configuration, Credentials, Services |
| FR-003 | Skip dependent checks when a prerequisite fails | P1 | Mark as "skipped" with reason referencing the failed dependency |
| FR-004 | Collect all check results into a `DoctorReport` with per-check status | P1 | Statuses: `pass`, `fail`, `warn`, `skip` |
| FR-005 | Support `--check <name>` to run a single check (and its dependencies) | P2 | |
| FR-006 | Support `--skip <name>` to exclude a check | P2 | |

### Check: Docker Running

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-010 | Run `docker info` to verify Docker daemon is available | P1 | |
| FR-011 | On failure: suggest installing Docker Desktop or starting the daemon | P1 | Message: "Docker is not running. Start Docker Desktop or run `sudo systemctl start docker`." |
| FR-012 | On warn: detect Docker running but with insufficient permissions | P2 | Suggest adding user to `docker` group |

### Check: `.generacy/config.yaml` Present and Valid

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-020 | Use existing `findConfigFile()` to discover config | P1 | Reuse from `@generacy-ai/generacy/config` |
| FR-021 | Use existing `loadConfig()` for structural + semantic validation | P1 | Reuse Zod schema and semantic validators |
| FR-022 | On not-found: suggest running `generacy init` or creating config manually | P1 | Show expected path: `.generacy/config.yaml` |
| FR-023 | On parse error: show YAML syntax error location | P1 | Leverage `ConfigParseError.cause` |
| FR-024 | On schema error: list each field-level error with dotted path | P1 | Leverage `ConfigSchemaError.errors` |
| FR-025 | On pass: display project name/ID and repo count summary | P2 | |

### Check: `.generacy/generacy.env` Present with Required Values

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-030 | Check `.generacy/generacy.env` exists adjacent to config | P1 | Same parent directory as `config.yaml` |
| FR-031 | Parse the env file and verify required keys are present and non-empty: `GITHUB_TOKEN`, `ANTHROPIC_API_KEY` | P1 | Do NOT log actual values |
| FR-032 | Warn if optional keys are missing: `PROJECT_ID`, `REDIS_URL`, `LOG_LEVEL` | P2 | These have defaults but may indicate incomplete setup |
| FR-033 | On not-found: suggest copying from `generacy.env.template` | P1 | Message: "Copy `.generacy/generacy.env.template` to `.generacy/generacy.env` and fill in your values." |
| FR-034 | On missing required key: list each missing key with description of what it's for | P1 | |

### Check: `.devcontainer/` Present

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-040 | Check `.devcontainer/devcontainer.json` exists in repo root | P1 | Walk up from CWD to `.git/` boundary, same as config discovery |
| FR-041 | Validate `devcontainer.json` is parseable JSON | P1 | |
| FR-042 | Check that the Generacy dev container feature is referenced | P2 | Look for `ghcr.io/generacy-ai/generacy/generacy` in `features` |
| FR-043 | On not-found: suggest running `generacy init` or the onboarding flow | P1 | |

### Check: GitHub Token Valid with Correct Scopes

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-050 | Read `GITHUB_TOKEN` from `.generacy/generacy.env` or environment | P1 | Env var takes precedence over file |
| FR-051 | Call GitHub API (`GET /user`) to verify token is valid | P1 | Use `https://api.github.com` or `GITHUB_API_URL` if set |
| FR-052 | Check `X-OAuth-Scopes` response header for required scopes: `repo`, `workflow` | P1 | |
| FR-053 | On invalid token: suggest generating a new PAT with link to GitHub settings | P1 | Link: `https://github.com/settings/tokens/new` |
| FR-054 | On missing scopes: list exactly which scopes are missing | P1 | Message: "Token is missing scopes: workflow. Re-create with: repo, workflow" |
| FR-055 | On pass: display authenticated username and confirmed scopes | P2 | |
| FR-056 | Skip if `GITHUB_TOKEN` not set (depends on env check) | P1 | Status: `skip`, reason: "GITHUB_TOKEN not configured" |
| FR-057 | Respect `GITHUB_API_URL` for GitHub Enterprise environments | P2 | Default: `https://api.github.com` |

### Check: Anthropic API Key Valid

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-060 | Read `ANTHROPIC_API_KEY` from `.generacy/generacy.env` or environment | P1 | Env var takes precedence |
| FR-061 | Call Anthropic API to verify key is valid (e.g., `GET /v1/models` or a minimal `POST /v1/messages`) | P1 | Use a minimal request that validates auth without cost |
| FR-062 | On invalid key: suggest checking the key at `https://console.anthropic.com/settings/keys` | P1 | |
| FR-063 | On pass: display confirmation that key is valid | P1 | Do NOT display the key itself |
| FR-064 | Skip if `ANTHROPIC_API_KEY` not set (depends on env check) | P1 | Status: `skip` |

### Check: npm Packages at Expected Versions

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-070 | Verify `@generacy-ai/generacy` is installed and report its version | P1 | Check `node_modules` or use `npm ls` / `pnpm ls` |
| FR-071 | Compare installed version against expected version from `package.json` | P1 | |
| FR-072 | On mismatch: suggest running `pnpm install` | P1 | |
| FR-073 | Warn if lockfile is missing or stale | P2 | |

### Check: Agency MCP Server Reachable

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-080 | Determine if running inside a dev container (check for `REMOTE_CONTAINERS` or `CODESPACES` env vars, or `/workspaces/` path) | P1 | Only run this check inside containers |
| FR-081 | Attempt HTTP connection to Agency MCP endpoint (`/mcp/initialize`) | P1 | Use `AGENCY_URL` env var or default URL |
| FR-082 | On unreachable: suggest starting the Agency service or checking network | P1 | |
| FR-083 | On pass: display Agency version and available tool count | P2 | Use `/mcp/tools` to list tools |
| FR-084 | Skip if not in a dev container | P1 | Status: `skip`, reason: "Not running inside a dev container" |

### Output Formatting

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-090 | Color-coded status symbols: green `✓` for pass, red `✗` for fail, yellow `!` for warn, gray `○` for skip | P1 | Use ANSI escape codes; respect `NO_COLOR` env var |
| FR-091 | Group checks by category with section headers | P1 | Categories: Environment, Configuration, Credentials, Services |
| FR-092 | Display fix suggestions indented below each failure | P1 | Prefixed with `→` or similar indicator |
| FR-093 | Display final summary line: "X passed, Y failed, Z warnings, W skipped" | P1 | |
| FR-094 | Support `--json` for machine-readable JSON output | P1 | JSON schema: `{ checks: [{ name, category, status, message, suggestion? }], summary: { pass, fail, warn, skip } }` |
| FR-095 | Support `--quiet` for minimal output (exit code only) | P2 | |
| FR-096 | Support `--verbose` for additional diagnostic detail per check | P2 | Show paths, versions, scopes, URLs checked |
| FR-097 | Support `--no-color` to disable color output | P2 | Also respect `NO_COLOR` env var per convention |

### CLI Registration

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-100 | Register `doctor` as a top-level subcommand in `cli/index.ts` | P1 | `program.addCommand(doctorCommand())` |
| FR-101 | Define options: `--json`, `--quiet`, `--verbose`, `--check <name>`, `--skip <name>`, `--no-color` | P1 | |
| FR-102 | Display check list in `--help` output | P2 | List all available check names |

---

## Technical Design

### Check Interface

```typescript
interface DoctorCheck {
  /** Unique check identifier (used with --check/--skip) */
  name: string;

  /** Human-readable label for display */
  label: string;

  /** Category for grouping output */
  category: 'environment' | 'configuration' | 'credentials' | 'services';

  /** Names of checks that must pass before this one runs */
  dependsOn?: string[];

  /** Execute the check and return a result */
  run(context: DoctorContext): Promise<CheckResult>;
}

interface CheckResult {
  status: 'pass' | 'fail' | 'warn' | 'skip';
  message: string;
  suggestion?: string;
  details?: string; // Shown in --verbose mode
}

interface DoctorContext {
  /** Resolved config (if config check passed) */
  config?: GeneracyConfig;
  /** Path to .generacy/ directory (if found) */
  generacyDir?: string;
  /** Parsed env file contents (if env check passed) */
  env?: Record<string, string>;
  /** Whether running inside a dev container */
  isDevContainer: boolean;
  /** Verbose mode flag */
  verbose: boolean;
}
```

### Check Execution Order

Checks execute in dependency order within these categories:

```
1. Environment
   ├── docker           — Docker daemon running
   └── node-packages    — npm packages at expected versions

2. Configuration
   ├── config           — .generacy/config.yaml present and valid
   ├── env-file         — .generacy/generacy.env present with required keys
   └── devcontainer     — .devcontainer/ present with Generacy feature

3. Credentials (depend on env-file)
   ├── github-token     — GitHub token valid with repo + workflow scopes
   └── anthropic-key    — Anthropic API key valid

4. Services (depend on docker)
   └── agency-mcp       — Agency MCP server reachable (container only)
```

### Example Output

```
Generacy Doctor
===============

Environment
  ✓ Docker            Docker Engine 24.0.7 running
  ✓ Packages          @generacy-ai/generacy@0.1.0 installed

Configuration
  ✓ Config            .generacy/config.yaml valid (project: My Project)
  ✗ Env File          .generacy/generacy.env missing required key: ANTHROPIC_API_KEY
    → Set ANTHROPIC_API_KEY in .generacy/generacy.env
      Get a key at: https://console.anthropic.com/settings/keys
  ✓ Dev Container     .devcontainer/devcontainer.json present

Credentials
  ✓ GitHub Token      Authenticated as @octocat (scopes: repo, workflow)
  ○ Anthropic Key     Skipped — ANTHROPIC_API_KEY not configured

Services
  ○ Agency MCP        Skipped — not running inside a dev container

───────────────────────────────
5 passed, 1 failed, 0 warnings, 2 skipped
```

### JSON Output Schema

```json
{
  "version": 1,
  "checks": [
    {
      "name": "docker",
      "category": "environment",
      "label": "Docker",
      "status": "pass",
      "message": "Docker Engine 24.0.7 running"
    },
    {
      "name": "env-file",
      "category": "configuration",
      "label": "Env File",
      "status": "fail",
      "message": ".generacy/generacy.env missing required key: ANTHROPIC_API_KEY",
      "suggestion": "Set ANTHROPIC_API_KEY in .generacy/generacy.env"
    }
  ],
  "summary": {
    "pass": 5,
    "fail": 1,
    "warn": 0,
    "skip": 2,
    "total": 8
  }
}
```

### Key Files

| File | Purpose |
|------|---------|
| `packages/generacy/src/cli/commands/doctor.ts` | Command registration and orchestration |
| `packages/generacy/src/cli/commands/doctor/checks/` | Individual check implementations (one file per check) |
| `packages/generacy/src/cli/commands/doctor/types.ts` | `DoctorCheck`, `CheckResult`, `DoctorContext` interfaces |
| `packages/generacy/src/cli/commands/doctor/runner.ts` | Check dependency resolution and execution engine |
| `packages/generacy/src/cli/commands/doctor/formatter.ts` | Color-coded terminal and JSON output formatting |
| `packages/generacy/src/cli/index.ts` | Register `doctorCommand()` alongside other commands |

### Color Implementation

Use ANSI escape codes directly (no external dependency needed) with a helper that respects `NO_COLOR` and `--no-color`:

```typescript
const useColor = !process.env['NO_COLOR'] && options.color !== false;

const symbols = {
  pass: useColor ? '\x1b[32m✓\x1b[0m' : '✓',
  fail: useColor ? '\x1b[31m✗\x1b[0m' : '✗',
  warn: useColor ? '\x1b[33m!\x1b[0m' : '!',
  skip: useColor ? '\x1b[90m○\x1b[0m' : '○',
};
```

---

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Check coverage | All 8 checks implemented and passing in a healthy environment | Manual test with fully configured environment |
| SC-002 | Failure detection | Every check correctly detects its failure condition | Unit tests with mocked failure scenarios for each check |
| SC-003 | Fix suggestion quality | Every failure provides an actionable, copy-pasteable fix command or URL | Review each check's suggestion text |
| SC-004 | Dependency skipping | Dependent checks are skipped (not failed) when prerequisite fails | Test: fail config check → credentials checks show "skip" |
| SC-005 | JSON output validity | `--json` output parses as valid JSON and matches documented schema | JSON schema validation in tests |
| SC-006 | Exit code correctness | Exit 0 for all-pass, exit 1 for any-fail | Automated tests for both paths |
| SC-007 | Test coverage | ≥ 40 test cases across all checks, runner, and formatter | Automated test suite |
| SC-008 | Color accessibility | Respects `NO_COLOR` env var and `--no-color` flag | Test with `NO_COLOR=1` |
| SC-009 | Execution time | Full doctor run completes in < 15 seconds (network checks included) | Timed execution in CI |

---

## Assumptions

- Docker is the expected container runtime — other runtimes (Podman, etc.) are not checked
- The GitHub API at `https://api.github.com` is reachable (or `GITHUB_API_URL` for Enterprise)
- The Anthropic API key can be validated with a lightweight request that does not incur usage costs
- Dev container detection uses environment variable heuristics (`REMOTE_CONTAINERS`, `CODESPACES`, or `/workspaces/` path prefix)
- The Agency MCP server exposes `/mcp/initialize` for health probing, consistent with the existing `NetworkAgency` client
- `pnpm` is the package manager (consistent with the monorepo setup), though the check should handle `npm` fallback
- The config schema and validation from #248 is stable and can be reused as-is via `@generacy-ai/generacy/config`
- Required env vars for the doctor check (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`) match those defined in `generacy.env.template.hbs`

## Out of Scope

- **Auto-fix / repair mode** — The doctor command suggests fixes but does not automatically apply them (a future `generacy doctor --fix` could be added)
- **Continuous monitoring** — Doctor is a one-shot diagnostic, not a background health daemon
- **Network proxy configuration** — Detecting and diagnosing HTTP proxy issues is not included
- **Redis connectivity** — Redis is an orchestrator runtime dependency, not a setup prerequisite for the doctor to check
- **generacy.ai cloud account validation** — Verifying the project ID against the generacy.ai API is not included (the config check validates format only, consistent with #248)
- **VS Code extension checks** — Whether the Generacy VS Code extension is installed is not validated
- **Operating system compatibility** — Doctor does not check OS-level requirements (kernel version, architecture)
- **Firewall / network diagnostics** — Beyond basic reachability of GitHub API and Agency MCP, no deep network debugging is performed
- **Performance benchmarking** — Doctor checks presence and validity, not performance characteristics

---

*Generated by speckit*
