# Implementation Plan: `generacy doctor` Command

**Feature**: 5.6 — Generacy CLI: `generacy doctor` command
**Branch**: `254-5-6-generacy-cli`
**Date**: 2026-02-26

## Summary

Implement a `generacy doctor` command that validates the full development environment setup. The command runs a series of categorized health checks (Docker, config, env file, devcontainer, GitHub token, Anthropic API key, npm packages, Agency MCP) with color-coded pass/fail/warning output and actionable fix suggestions. The architecture uses a pluggable check registry with dependency ordering and concurrent execution where possible.

## Technical Context

- **Language**: TypeScript (ESM, Node ≥ 20)
- **Framework**: Commander.js ^12 for CLI, Vitest ^4 for tests
- **Package**: `@generacy-ai/generacy` at `packages/generacy/`
- **Build**: `tsc` → `dist/`
- **Existing patterns**: Follow `validate` command structure, use `execSafe()` for shell commands, `findConfigFile()`/`loadConfig()` for config validation

### New dependency

- `dotenv` — parse `.generacy/generacy.env` files (per Q2 decision)

## Architecture Overview

```
src/cli/commands/doctor.ts          ← Command definition & CLI wiring
src/cli/commands/doctor/
  ├── types.ts                      ← Check interfaces & result types
  ├── registry.ts                   ← Check registry with dependency resolution
  ├── runner.ts                     ← Orchestrates check execution (concurrency, timeouts)
  ├── formatter.ts                  ← Color-coded output formatting
  ├── checks/
  │   ├── docker.ts                 ← Docker check (3-way failure detection)
  │   ├── config.ts                 ← .generacy/config.yaml check
  │   ├── env-file.ts               ← .generacy/generacy.env check
  │   ├── devcontainer.ts           ← .devcontainer/ check
  │   ├── github-token.ts           ← GitHub token scope validation
  │   ├── anthropic-key.ts          ← Anthropic API key validation
  │   ├── npm-packages.ts           ← Package version check
  │   └── agency-mcp.ts             ← Agency MCP reachability check
  └── index.ts                      ← Re-exports
```

### Check lifecycle

```
Register checks → Resolve dependencies → Build execution plan → Run (concurrent within category) → Collect results → Format output → Exit code
```

### Data flow

1. **CLI parses flags** (`--json`, `--verbose`, `--check`, `--skip`, `--fix`)
2. **Registry resolves** which checks to run (respecting `--check`/`--skip` + dependencies)
3. **Runner executes** checks in dependency order, running independent checks concurrently within each tier. Each network check has a 5s timeout.
4. **Formatter renders** results as color-coded text or JSON
5. **Exit code**: 0 (all pass), 1 (any check failed), 2 (internal error)

## Data Model

### Check Definition

```typescript
interface CheckDefinition {
  /** Unique identifier, e.g., 'docker', 'config', 'github-token' */
  id: string;
  /** Human-readable label for output */
  label: string;
  /** Category for grouping: 'system', 'config', 'credentials', 'packages', 'services' */
  category: CheckCategory;
  /** IDs of checks that must pass before this one runs */
  dependencies: string[];
  /** Priority: 'P1' checks always run; 'P2' can be skipped */
  priority: 'P1' | 'P2';
  /** The check function */
  run: (context: CheckContext) => Promise<CheckResult>;
}

type CheckCategory = 'system' | 'config' | 'credentials' | 'packages' | 'services';

interface CheckContext {
  /** Resolved config file path (null if not found) */
  configPath: string | null;
  /** Parsed config (null if config check failed) */
  config: GeneracyConfig | null;
  /** Parsed env vars from .generacy/generacy.env */
  envVars: Record<string, string> | null;
  /** Whether running inside a dev container */
  inDevContainer: boolean;
  /** Whether --verbose was passed */
  verbose: boolean;
}

interface CheckResult {
  status: 'pass' | 'fail' | 'warn' | 'skip';
  message: string;
  /** Actionable fix suggestion (shown on fail/warn) */
  suggestion?: string;
  /** Additional detail shown in --verbose mode */
  detail?: string;
  /** Data to pass to dependent checks via context */
  data?: Record<string, unknown>;
}
```

### Output format (text mode)

```
Generacy Doctor
===============

System
  ✓ Docker           Docker daemon is running (v27.0.3)
  ✓ Dev Container    .devcontainer/devcontainer.json present with Generacy feature

Configuration
  ✓ Config File      .generacy/config.yaml is valid
  ✓ Env File         .generacy/generacy.env present with required keys

Credentials
  ✓ GitHub Token     Token valid with required scopes (repo, workflow)
  ✗ Anthropic Key    API key is invalid (401 Unauthorized)
    → Set a valid ANTHROPIC_API_KEY in .generacy/generacy.env

Packages
  ✓ @generacy-ai/generacy   v0.1.0 (expected ≥ 0.1.0)

Services
  - Agency MCP       Skipped — AGENCY_URL not set (only needed for network mode)

Result: 7 passed, 1 failed, 0 warnings, 1 skipped
```

Symbols: `✓` (green) = pass, `✗` (red) = fail, `!` (yellow) = warn, `-` (dim) = skip

## Implementation Phases

### Phase 1: Core Framework (types, registry, runner, formatter)

**Files to create:**
- `src/cli/commands/doctor/types.ts`
- `src/cli/commands/doctor/registry.ts`
- `src/cli/commands/doctor/runner.ts`
- `src/cli/commands/doctor/formatter.ts`
- `src/cli/commands/doctor/index.ts`

**Details:**

#### `types.ts`
Define `CheckDefinition`, `CheckCategory`, `CheckContext`, `CheckResult`, and `DoctorOptions` interfaces as described above.

#### `registry.ts`
- `CheckRegistry` class with:
  - `register(check: CheckDefinition): void`
  - `getChecks(): CheckDefinition[]`
  - `resolve(options: { check?: string[], skip?: string[] }): CheckDefinition[]` — returns checks to run in dependency order, automatically including dependencies when `--check` is used
- Topological sort for dependency resolution
- Throws if unknown check names are passed to `--check`/`--skip`

#### `runner.ts`
- `runChecks(checks: CheckDefinition[], options: DoctorOptions): Promise<CheckResultMap>`
- Builds execution tiers from dependency graph (checks with no unresolved deps run concurrently)
- 5-second timeout per network check (wraps check with `Promise.race`)
- Populates `CheckContext` progressively as checks complete (e.g., config check populates `context.config` for downstream checks)
- If a dependency failed, dependent checks get status `skip` with message "Skipped — dependency '{id}' failed"

#### `formatter.ts`
- `formatText(results: CheckResultMap, checks: CheckDefinition[]): string` — color-coded grouped output
- `formatJson(results: CheckResultMap, checks: CheckDefinition[]): string` — JSON output
- Uses ANSI escape codes directly (no chalk dependency needed; Node 20+ has built-in color support or we use simple escape sequences)
- Respects `NO_COLOR` env var and `--no-pretty` flag
- Summary line: "N passed, N failed, N warnings, N skipped"

### Phase 2: Individual Checks (P1)

**Files to create:**
- `src/cli/commands/doctor/checks/docker.ts`
- `src/cli/commands/doctor/checks/config.ts`
- `src/cli/commands/doctor/checks/env-file.ts`
- `src/cli/commands/doctor/checks/devcontainer.ts`
- `src/cli/commands/doctor/checks/github-token.ts`
- `src/cli/commands/doctor/checks/anthropic-key.ts`
- `src/cli/commands/doctor/checks/npm-packages.ts`
- `src/cli/commands/doctor/checks/agency-mcp.ts`

#### `docker.ts` — id: `docker`, category: `system`, deps: `[]`
- Run `docker info` via `execSafe()`
- Three-way detection (per Q3):
  - Command not found → fail: "Docker is not installed" / suggest "Install Docker Desktop"
  - "Cannot connect to the Docker daemon" in stderr → fail: "Docker daemon is not running" / suggest "Start Docker Desktop"
  - "permission denied" in stderr → fail: "Insufficient permissions" / suggest `sudo usermod -aG docker $USER`
  - Success → pass with Docker version from stdout

#### `config.ts` — id: `config`, category: `config`, deps: `[]`
- Use `findConfigFile()` to locate config
- Use `loadConfig()` to validate
- Catch specific error classes (`ConfigNotFoundError`, `ConfigParseError`, `ConfigSchemaError`, `ConfigValidationError`) for targeted suggestions
- On pass, store `configPath` and parsed `config` in context for downstream checks
- Suggestion on missing: "Create .generacy/config.yaml — see documentation for schema reference"

#### `env-file.ts` — id: `env-file`, category: `config`, deps: `[config]`
- Resolve env file path as `path.dirname(configPath) + '/generacy.env'` (per Q8)
- Check file exists
- Parse with `dotenv.parse()` (per Q2)
- Validate required keys present: `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`
- Warn if keys are present but empty
- Store parsed env vars in context for credential checks
- Suggestion on missing: "Run `generacy init` to generate the env file, or create `.generacy/generacy.env` manually with required keys: GITHUB_TOKEN, ANTHROPIC_API_KEY" (per Q11)

#### `devcontainer.ts` — id: `devcontainer`, category: `system`, deps: `[]`
- Check `.devcontainer/devcontainer.json` exists (relative to config file's project root, or CWD)
- Read and parse JSON
- Check `features` object contains a key matching `ghcr.io/generacy-ai/generacy/generacy` (presence only, per Q12)
- Fail if no devcontainer.json → suggest "Run `generacy init` to generate dev container configuration"
- Warn if devcontainer exists but missing Generacy feature

#### `github-token.ts` — id: `github-token`, category: `credentials`, deps: `[env-file]`
- Read `GITHUB_TOKEN` from context env vars
- Call GitHub API: `GET /user` with `Authorization: Bearer <token>` to validate token
- Call `GET /user` headers to check `X-OAuth-Scopes` includes `repo` and `workflow`
- 5s timeout
- On 401 → fail: "GitHub token is invalid" / suggest "Generate a new token at https://github.com/settings/tokens with repo and workflow scopes"
- On missing scopes → warn: "Token is valid but missing scopes: {missing}" / suggest "Update token scopes"
- Uses native `fetch()` (Node 20+ built-in, no extra dependency)

#### `anthropic-key.ts` — id: `anthropic-key`, category: `credentials`, deps: `[env-file]`
- Read `ANTHROPIC_API_KEY` from context env vars
- Call `GET https://api.anthropic.com/v1/models` with `x-api-key` header and `anthropic-version: 2023-06-01` (per Q1)
- 5s timeout
- On 401 → fail: "Anthropic API key is invalid"
- On success → pass
- On network error → fail with network error detail

#### `npm-packages.ts` — id: `npm-packages`, category: `packages`, deps: `[]`
- Read `node_modules/@generacy-ai/generacy/package.json` directly (per Q10)
- Compare installed version against expected minimum (from own package.json or hardcoded)
- If `node_modules` not found → fail: "Packages not installed" / suggest "Run `pnpm install`"
- If version mismatch → warn with installed vs expected

#### `agency-mcp.ts` — id: `agency-mcp`, category: `services`, deps: `[]`
- Check if `AGENCY_URL` env var is set (from process.env, not .generacy/generacy.env)
- If not set → skip: "Agency MCP check skipped — AGENCY_URL not set (only needed for network mode)" (per Q5)
- If set → HTTP GET `{AGENCY_URL}/health` with 5s timeout
- On success → pass
- On failure → fail with connection error detail

### Phase 3: Command Wiring & Registration

**Files to create:**
- `src/cli/commands/doctor.ts`

**Files to modify:**
- `src/cli/index.ts` — add `import { doctorCommand }` and `program.addCommand(doctorCommand())`

#### `doctor.ts`
```typescript
export function doctorCommand(): Command {
  const command = new Command('doctor');
  command
    .description('Validate the full development environment setup')
    .option('--check <name...>', 'Run only specific checks (and their dependencies)')
    .option('--skip <name...>', 'Skip specific checks')
    .option('-j, --json', 'Output results as JSON')
    .option('-v, --verbose', 'Show detailed diagnostic information')
    .option('-f, --fix', 'Attempt to fix detected issues (where possible)')
    .action(async (options) => { /* ... */ });
  return command;
}
```

- Instantiate registry, register all checks
- Resolve checks based on `--check`/`--skip` flags
- Run checks via runner
- Format output via formatter
- Exit with appropriate code (0/1/2)
- `--verbose` enables Pino debug output alongside formatted report (per Q6)
- `--fix` is reserved for future use — initially prints "Auto-fix not yet implemented for this check" when applicable

### Phase 4: Tests

**Files to create:**
- `src/cli/__tests__/doctor.test.ts` — Integration tests (follow validate.test.ts pattern)
- `src/cli/commands/doctor/__tests__/registry.test.ts` — Unit tests for dependency resolution
- `src/cli/commands/doctor/__tests__/runner.test.ts` — Unit tests for execution engine
- `src/cli/commands/doctor/__tests__/formatter.test.ts` — Unit tests for output formatting
- `src/cli/commands/doctor/__tests__/checks/` — Unit tests per check (mocking execSafe, fetch, fs)

#### Integration tests (`doctor.test.ts`)
Following the `validate.test.ts` pattern:
- Create temp directory with valid `.generacy/config.yaml` and `.generacy/generacy.env`
- Run `node bin/generacy.js doctor` via `execSync`
- Verify exit code 0 when all local checks pass
- Verify exit code 1 when config is missing
- Verify `--json` outputs valid JSON with expected structure
- Verify `--check config` runs only config check and its dependencies
- Verify `--skip docker` skips the Docker check
- Verify output contains expected symbols and category headers

#### Unit tests
- **Registry**: dependency resolution, cycle detection, `--check` with deps, unknown check names
- **Runner**: concurrent execution, timeout handling, dependency skip propagation, context passing
- **Formatter**: text output with colors, JSON structure, summary line math, `NO_COLOR` support
- **Individual checks**: mock `execSafe` / `fetch` / `fs` to test each failure mode

### Phase 5: Documentation & Polish

- Add `generacy doctor --help` output to match spec format
- Ensure `--no-pretty` disables colors in doctor output
- Ensure `NO_COLOR=1` environment variable disables colors
- Verify < 15 second total execution time with network checks (per SC-009)

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| API key validation | `GET /v1/models` | Free, read-only, no cost per run (Q1) |
| Env parsing | `dotenv` library | Handles quoting, comments, multiline; de facto standard (Q2) |
| Docker detection | 3-way error parsing | Distinct fixes per failure mode, minimal implementation cost (Q3) |
| Multi-value flags | `--check <name...>` | Standard CLI convention, Commander.js native support (Q4) |
| Agency MCP default | Skip if no URL | subprocess mode is default; assuming a port would be wrong (Q5) |
| Output mechanism | Direct stdout + Pino for verbose | Color-coded output conflicts with Pino JSON wrappers (Q6) |
| Network concurrency | Concurrent within tier, 5s timeout | Stays within 15s budget while maintaining deterministic output order (Q7) |
| Env file location | Relative to config file | `path.dirname(configPath)` works for both standard and custom paths (Q8) |
| Dependency visibility | Show all executed checks | Transparency is more valuable than minimal output (Q9) |
| Package version check | Read node_modules directly | Fast, no subprocess, package-manager agnostic (Q10) |
| Missing env suggestion | Suggest `generacy init` | Handlebars template can't be copied raw; init renders it properly (Q11) |
| Devcontainer version | Presence only | Version management via dependabot/renovate is out of scope (Q12) |
| Exit code 2 | Internal errors only | Clear signal: 0=healthy, 1=env needs fixing, 2=doctor is broken (Q13) |
| ANSI colors | Direct escape codes | Avoid `chalk` dependency; Node 20+ handles this fine; respect `NO_COLOR` |
| HTTP requests | Native `fetch()` | Node 20+ built-in; no `axios`/`node-fetch` dependency needed |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Network checks slow/flaky in CI | 5s timeout per check; `--skip` flag to exclude network checks; checks fail gracefully with actionable messages |
| Anthropic `GET /v1/models` endpoint changes | Simple to update; check is isolated in its own file; fail message will still be useful |
| `dotenv` parsing edge cases | Using the standard library; same parser used at runtime ensures consistency |
| Config schema evolves (dependency on 4.2) | Reuse existing `loadConfig()` which already validates; doctor just reports the error classes |
| Circular dependencies in check registry | Topological sort will detect cycles and throw at registration time |
| `--fix` scope creep | Phase 1 reserves the flag but only prints "not yet implemented"; actual fixes are future work |
| Tests require Docker/network | Integration tests focus on local checks (config, env file); network checks tested via unit tests with mocked `fetch` |
| Color output in CI environments | Respect `NO_COLOR` env var and `--no-pretty` flag; JSON mode for machine consumption |

## Files Summary

### New files (17)
| File | Purpose |
|------|---------|
| `src/cli/commands/doctor.ts` | Command definition & CLI wiring |
| `src/cli/commands/doctor/types.ts` | Interfaces and type definitions |
| `src/cli/commands/doctor/registry.ts` | Check registry with dependency resolution |
| `src/cli/commands/doctor/runner.ts` | Check execution orchestrator |
| `src/cli/commands/doctor/formatter.ts` | Color-coded output formatter |
| `src/cli/commands/doctor/index.ts` | Re-exports |
| `src/cli/commands/doctor/checks/docker.ts` | Docker health check |
| `src/cli/commands/doctor/checks/config.ts` | Config file validation check |
| `src/cli/commands/doctor/checks/env-file.ts` | Env file validation check |
| `src/cli/commands/doctor/checks/devcontainer.ts` | Devcontainer presence check |
| `src/cli/commands/doctor/checks/github-token.ts` | GitHub token validation check |
| `src/cli/commands/doctor/checks/anthropic-key.ts` | Anthropic API key validation check |
| `src/cli/commands/doctor/checks/npm-packages.ts` | Package version check |
| `src/cli/commands/doctor/checks/agency-mcp.ts` | Agency MCP health check |
| `src/cli/__tests__/doctor.test.ts` | Integration tests |
| `src/cli/commands/doctor/__tests__/registry.test.ts` | Registry unit tests |
| `src/cli/commands/doctor/__tests__/runner.test.ts` | Runner unit tests |

### Modified files (2)
| File | Change |
|------|--------|
| `src/cli/index.ts` | Import and register `doctorCommand()` |
| `package.json` | Add `dotenv` dependency |

## Dependency Graph (Check Execution Order)

```
Tier 0 (no deps, run concurrently):
  ├── docker
  ├── config
  ├── devcontainer
  ├── npm-packages
  └── agency-mcp (may skip if no AGENCY_URL)

Tier 1 (depends on config):
  └── env-file

Tier 2 (depends on env-file, run concurrently):
  ├── github-token
  └── anthropic-key
```

Total execution: ~3 tiers. With 5s timeouts on network checks running concurrently, worst-case is well under 15 seconds.
