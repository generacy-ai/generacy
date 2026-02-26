# Tasks: `generacy doctor` Command

**Input**: Design documents from `/workspaces/generacy/specs/254-5-6-generacy-cli/`
**Prerequisites**: plan.md (required), spec.md (required), data-model.md, clarifications.md
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = primary)

---

## Phase 1: Project Setup & Core Types

### T001 Add `dotenv` dependency
**File**: `packages/generacy/package.json`
- Add `dotenv` as a runtime dependency (for parsing `.generacy/generacy.env`)
- Run `pnpm install` to update lockfile

### T002 [P] Define core type interfaces
**File**: `packages/generacy/src/cli/commands/doctor/types.ts`
- Define `CheckCategory` type (`'system' | 'config' | 'credentials' | 'packages' | 'services'`)
- Define `CheckDefinition` interface (id, label, category, dependencies, priority, run, fix?)
- Define `CheckContext` interface (configPath, config, envVars, inDevContainer, verbose, projectRoot)
- Define `CheckResult` interface (status, message, suggestion?, detail?, duration?)
- Define `DoctorOptions` interface (check?, skip?, json?, verbose?, fix?)
- Define `DoctorReport` interface (version, timestamp, summary, checks, exitCode)
- Define `FixResult` interface (future use stub)

---

## Phase 2: Core Framework

### T003 Implement check registry with dependency resolution
**File**: `packages/generacy/src/cli/commands/doctor/registry.ts`
- Implement `CheckRegistry` class with:
  - `register(check: CheckDefinition): void` — adds check to internal map
  - `getChecks(): CheckDefinition[]` — returns all registered checks
  - `resolve(options: { check?: string[], skip?: string[] }): CheckDefinition[]` — returns checks in topological order
- Implement topological sort for dependency resolution
- Auto-include dependencies when `--check` is used (e.g., `--check github-token` also includes `env-file` and `config`)
- Throw on unknown check names in `--check`/`--skip`
- Detect and throw on circular dependencies

### T004 [P] Implement check runner / execution engine
**File**: `packages/generacy/src/cli/commands/doctor/runner.ts`
- Implement `runChecks(checks: CheckDefinition[], options: DoctorOptions): Promise<DoctorReport>`
- Build execution tiers from dependency graph (checks with no unresolved deps run concurrently via `Promise.all`)
- Wrap network checks with 5-second timeout using `Promise.race`
- Populate `CheckContext` progressively as checks complete (e.g., config check sets `context.config`)
- Auto-skip dependent checks if a dependency failed (status `'skip'`, message: "Skipped — dependency '{id}' failed")
- Track duration per check
- Compute summary counts (passed, failed, warnings, skipped) and exit code (0/1/2)

### T005 [P] Implement output formatter
**File**: `packages/generacy/src/cli/commands/doctor/formatter.ts`
- Implement `formatText(report: DoctorReport, checks: CheckDefinition[], verbose: boolean): string`
  - Category-grouped output with header per category
  - Symbols: `✓` (green) = pass, `✗` (red) = fail, `!` (yellow) = warn, `-` (dim) = skip
  - Show suggestion lines indented with `→` for fail/warn results
  - Show detail lines in `--verbose` mode
  - Summary line: "N passed, N failed, N warnings, N skipped"
- Implement `formatJson(report: DoctorReport): string` — pretty-printed JSON
- Use ANSI escape codes directly (no `chalk` dependency)
- Respect `NO_COLOR` env var and `--no-pretty` flag to disable colors

### T006 Create barrel re-exports
**File**: `packages/generacy/src/cli/commands/doctor/index.ts`
- Re-export types, registry, runner, formatter for clean imports

---

## Phase 3: Individual Health Checks

### T007 [P] Implement Docker check
**File**: `packages/generacy/src/cli/commands/doctor/checks/docker.ts`
- id: `docker`, category: `system`, deps: `[]`, priority: `P1`
- Run `docker info` via `execSafe()`
- Three-way failure detection:
  - Command not found → fail: "Docker is not installed" / suggest "Install Docker Desktop from https://docker.com"
  - "Cannot connect to the Docker daemon" in stderr → fail: "Docker daemon is not running" / suggest "Start Docker Desktop"
  - "permission denied" in stderr → fail: "Insufficient permissions" / suggest `sudo usermod -aG docker $USER`
- On success → pass with Docker version extracted from stdout

### T008 [P] Implement config file check
**File**: `packages/generacy/src/cli/commands/doctor/checks/config.ts`
- id: `config`, category: `config`, deps: `[]`, priority: `P1`
- Use `findConfigFile()` to locate config
- Use `loadConfig()` to validate
- Catch specific error classes: `ConfigNotFoundError`, `ConfigParseError`, `ConfigSchemaError`, `ConfigValidationError`
- Provide targeted suggestion per error type
- On pass, store `configPath`, `projectRoot`, and parsed `config` in context

### T009 [P] Implement env file check
**File**: `packages/generacy/src/cli/commands/doctor/checks/env-file.ts`
- id: `env-file`, category: `config`, deps: `['config']`, priority: `P1`
- Resolve env file path: `path.dirname(context.configPath) + '/generacy.env'`
- Check file exists
- Parse with `dotenv.parse()`
- Validate required keys present: `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`
- Warn if keys are present but empty
- Store parsed env vars in `context.envVars`
- On missing: suggest "Run `generacy init` to generate the env file, or create `.generacy/generacy.env` manually with required keys: GITHUB_TOKEN, ANTHROPIC_API_KEY"

### T010 [P] Implement devcontainer check
**File**: `packages/generacy/src/cli/commands/doctor/checks/devcontainer.ts`
- id: `devcontainer`, category: `system`, deps: `[]`, priority: `P2`
- Check `.devcontainer/devcontainer.json` exists (relative to project root or CWD)
- Read and parse JSON
- Check `features` object contains a key matching `ghcr.io/generacy-ai/generacy/generacy` (presence only)
- Fail if no devcontainer.json → suggest "Run `generacy init` to generate dev container configuration"
- Warn if devcontainer exists but missing Generacy feature

### T011 [P] Implement GitHub token check
**File**: `packages/generacy/src/cli/commands/doctor/checks/github-token.ts`
- id: `github-token`, category: `credentials`, deps: `['env-file']`, priority: `P1`
- Read `GITHUB_TOKEN` from `context.envVars`
- Call `GET https://api.github.com/user` with `Authorization: Bearer <token>` using native `fetch()`
- Parse `X-OAuth-Scopes` header to check for `repo` and `workflow` scopes
- 5s timeout via `AbortSignal.timeout(5000)`
- On 401 → fail: "GitHub token is invalid" / suggest generating new token with required scopes
- On missing scopes → warn with list of missing scopes
- On network error → fail with connection error detail

### T012 [P] Implement Anthropic API key check
**File**: `packages/generacy/src/cli/commands/doctor/checks/anthropic-key.ts`
- id: `anthropic-key`, category: `credentials`, deps: `['env-file']`, priority: `P1`
- Read `ANTHROPIC_API_KEY` from `context.envVars`
- Call `GET https://api.anthropic.com/v1/models` with `x-api-key` header and `anthropic-version: 2023-06-01`
- 5s timeout via `AbortSignal.timeout(5000)`
- On 401 → fail: "Anthropic API key is invalid" / suggest setting valid key
- On success → pass
- On network error → fail with network error detail

### T013 [P] Implement npm packages check
**File**: `packages/generacy/src/cli/commands/doctor/checks/npm-packages.ts`
- id: `npm-packages`, category: `packages`, deps: `[]`, priority: `P2`
- Read `node_modules/@generacy-ai/generacy/package.json` directly (no subprocess)
- Compare installed version against expected minimum
- If `node_modules` not found → fail: "Packages not installed" / suggest "Run `pnpm install`"
- If version mismatch → warn with installed vs expected

### T014 [P] Implement Agency MCP check
**File**: `packages/generacy/src/cli/commands/doctor/checks/agency-mcp.ts`
- id: `agency-mcp`, category: `services`, deps: `[]`, priority: `P2`
- Check if `AGENCY_URL` env var is set (from `process.env`, not `.generacy/generacy.env`)
- If not set → skip: "Agency MCP check skipped — AGENCY_URL not set (only needed for network mode)"
- If set → HTTP GET `{AGENCY_URL}/health` with 5s timeout
- On success → pass
- On failure → fail with connection error detail

---

## Phase 4: Command Wiring & Registration

### T015 Implement doctor command definition
**File**: `packages/generacy/src/cli/commands/doctor.ts`
- Create `doctorCommand(): Command` function following existing command pattern
- Configure Commander.js options:
  - `--check <name...>` — run only specific checks (and dependencies)
  - `--skip <name...>` — skip specific checks
  - `-j, --json` — output as JSON
  - `-v, --verbose` — show detailed diagnostics
  - `-f, --fix` — reserved for future auto-fix (prints "not yet implemented")
- In `.action()`:
  - Instantiate `CheckRegistry` and register all 8 checks
  - Resolve checks based on `--check`/`--skip` flags
  - Run checks via runner
  - Format output via formatter (text or JSON)
  - Write to stdout
  - Exit with appropriate code (0/1/2)

### T016 Register doctor command in CLI entry point
**File**: `packages/generacy/src/cli/index.ts`
- Add `import { doctorCommand } from './commands/doctor.js'`
- Add `program.addCommand(doctorCommand())` alongside existing commands

---

## Phase 5: Unit Tests

### T017 [P] Write registry unit tests
**File**: `packages/generacy/src/cli/commands/doctor/__tests__/registry.test.ts`
- Test check registration and retrieval
- Test topological sort with valid dependency chains
- Test circular dependency detection (should throw)
- Test `--check` with auto-included dependencies
- Test `--skip` exclusion
- Test unknown check name rejection
- Test empty registry behavior

### T018 [P] Write runner unit tests
**File**: `packages/generacy/src/cli/commands/doctor/__tests__/runner.test.ts`
- Test concurrent execution of independent checks within a tier
- Test timeout handling (check exceeding 5s timeout)
- Test dependency skip propagation (dependency fails → dependent skipped)
- Test context passing between checks (config check populates context for env-file)
- Test summary computation (counts and exit codes)
- Test exit code 0 (all pass), exit code 1 (any fail), exit code 2 (internal error)
- Mock check functions to control behavior

### T019 [P] Write formatter unit tests
**File**: `packages/generacy/src/cli/commands/doctor/__tests__/formatter.test.ts`
- Test text output includes correct symbols (✓, ✗, !, -)
- Test category grouping and headers
- Test suggestion lines with `→` prefix
- Test verbose mode includes detail lines
- Test summary line math ("N passed, N failed, N warnings, N skipped")
- Test JSON output structure matches `DoctorReport` schema
- Test `NO_COLOR` disables ANSI escape codes
- Test empty results handling

### T020 [P] Write individual check unit tests
**Files**:
- `packages/generacy/src/cli/commands/doctor/__tests__/checks/docker.test.ts`
- `packages/generacy/src/cli/commands/doctor/__tests__/checks/config.test.ts`
- `packages/generacy/src/cli/commands/doctor/__tests__/checks/env-file.test.ts`
- `packages/generacy/src/cli/commands/doctor/__tests__/checks/devcontainer.test.ts`
- `packages/generacy/src/cli/commands/doctor/__tests__/checks/github-token.test.ts`
- `packages/generacy/src/cli/commands/doctor/__tests__/checks/anthropic-key.test.ts`
- `packages/generacy/src/cli/commands/doctor/__tests__/checks/npm-packages.test.ts`
- `packages/generacy/src/cli/commands/doctor/__tests__/checks/agency-mcp.test.ts`

For each check, test:
- **docker.ts**: mock `execSafe()` for three failure modes (not installed, daemon not running, permission denied) + success with version extraction
- **config.ts**: mock `findConfigFile()`/`loadConfig()` for each error class + success with context population
- **env-file.ts**: mock `fs.readFileSync` and `dotenv.parse()` for missing file, missing keys, empty keys, valid file
- **devcontainer.ts**: mock `fs.existsSync`/`fs.readFileSync` for missing file, missing feature, valid config
- **github-token.ts**: mock `fetch()` for 401, missing scopes, timeout, success
- **anthropic-key.ts**: mock `fetch()` for 401, timeout, network error, success
- **npm-packages.ts**: mock `fs.readFileSync` for missing node_modules, version mismatch, valid version
- **agency-mcp.ts**: mock `process.env.AGENCY_URL` and `fetch()` for skip (no URL), health failure, success

---

## Phase 6: Integration Tests

### T021 Write integration tests
**File**: `packages/generacy/src/cli/__tests__/doctor.test.ts`
- Follow `validate.test.ts` pattern: temp directory with `beforeEach`/`afterEach`, run CLI via `execSync`
- Test: valid setup → exit code 0
- Test: missing config → exit code 1
- Test: `--json` outputs valid JSON matching `DoctorReport` structure
- Test: `--check config` runs only config check (and its dependencies)
- Test: `--skip docker` skips Docker check
- Test: output contains expected symbols and category headers
- Test: output contains summary line with correct counts
- Note: skip network checks in integration tests (mock or use `--skip`)

---

## Phase 7: Build Verification & Polish

### T022 Verify TypeScript compilation
**Files**: All new files
- Run `pnpm build` in `packages/generacy/` — ensure zero compilation errors
- Verify `dist/` output includes all new doctor files

### T023 Run full test suite
**Files**: All test files
- Run `pnpm test` in `packages/generacy/`
- Ensure all existing tests still pass (no regressions)
- Ensure all new doctor tests pass
- Check coverage for new code

### T024 Manual verification of `--help` output
**File**: `packages/generacy/src/cli/commands/doctor.ts`
- Run `node bin/generacy.js doctor --help` and verify output matches spec
- Verify `--no-pretty` disables colors
- Verify `NO_COLOR=1` environment variable disables colors

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (setup + types) must complete before Phase 2 (framework)
- Phase 2 (framework: registry, runner, formatter) must complete before Phase 3 (checks) — checks depend on types and register with registry
- Phase 3 (checks) must complete before Phase 4 (command wiring) — command registers all checks
- Phase 4 (wiring) must complete before Phase 6 (integration tests) — integration tests run the CLI binary
- Phase 5 (unit tests) can begin as soon as corresponding Phase 2/3 files are written
- Phase 7 (build/polish) runs after all implementation and tests

**Parallel opportunities within phases**:
- Phase 1: T001 and T002 can run in parallel
- Phase 2: T003, T004, T005 can run in parallel (independent modules)
- Phase 3: All check implementations (T007–T014) can run in parallel (independent files)
- Phase 4: T015 must complete before T016
- Phase 5: All unit test tasks (T017–T020) can run in parallel
- Phase 7: T022, T023, T024 are sequential (build → test → manual verify)

**Critical path**:
```
T001 → T002 → T003 → T015 → T016 → T021 → T022 → T023 → T024
              ↘ T004 ↗         ↑
              ↘ T005 ↗         |
              ↘ T007–T014 ─────┘
```

**Estimated new files**: 19 (8 checks, 4 framework, 1 command, 1 barrel, ~5 test files/dirs)
**Estimated modified files**: 2 (`src/cli/index.ts`, `package.json`)
