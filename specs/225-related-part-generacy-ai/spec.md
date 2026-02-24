# Feature Specification: Generacy Setup CLI Subcommands

**Branch**: `225-related-part-generacy-ai` | **Date**: 2026-02-24 | **Status**: Draft
**Parent**: generacy-ai/tetrad-development#6 (Dev Container Infrastructure Refactor)

## Summary

Add a `generacy setup` command group to the CLI that replaces four bash scripts currently in `.devcontainer/` of tetrad-development. These commands run inside the dev container and handle authentication, workspace initialization, package building, and service startup. Moving from bash scripts to TypeScript CLI commands provides type safety, testability, structured logging, and a consistent developer experience across all setup operations.

## User Stories

### US1: Authenticate Development Environment

**As a** developer working in a dev container,
**I want** to run `generacy setup auth` to configure my git credentials and GitHub CLI authentication,
**So that** I can push/pull code and interact with GitHub without manual credential configuration.

**Acceptance Criteria**:
- [ ] Configures `git config user.name` and `git config user.email` from `--username`/`--email` flags or `GH_USERNAME`/`GH_EMAIL` env vars
- [ ] Sets up git credential helper via `gh auth setup-git` or writes `~/.git-credentials`
- [ ] Verifies GitHub CLI authentication status and reports result
- [ ] Logs clear success/warning/error messages via Pino logger
- [ ] Exits with non-zero code if authentication cannot be verified

### US2: Initialize Workspace Repositories

**As a** developer setting up a fresh dev container,
**I want** to run `generacy setup workspace` to clone all required repositories and install their dependencies,
**So that** I have a complete, ready-to-use development workspace without running multiple manual commands.

**Acceptance Criteria**:
- [ ] Clones repositories from the default list (or `--repos` override) into `--workdir` directory
- [ ] Detects existing repos and fetches/pulls updates instead of re-cloning
- [ ] Checks out the specified branch (default: `develop`), creating a tracking branch if needed
- [ ] Auto-detects package manager per repo (pnpm if `pnpm-lock.yaml` exists, npm otherwise) and installs dependencies
- [ ] `--clean` flag performs `git reset --hard && git clean -fd` before updating
- [ ] Calls `generacy setup auth` internally if git credentials are not configured
- [ ] Adds each repo path as a git safe directory
- [ ] Reports summary of successful and failed clones on completion

### US3: Build Development Packages

**As a** developer who needs to build Agency and Generacy packages,
**I want** to run `generacy setup build` to build all packages in the correct order with proper cleanup,
**So that** I have working CLI tools and plugins without remembering complex multi-repo build sequences.

**Acceptance Criteria**:
- [ ] Phase 1 — Cleans stale Claude plugin state (marketplace cache, `installed_plugins.json`, `enabledPlugins` in settings.json)
- [ ] Phase 2 — Builds Agency: installs latency dep, installs agency deps with pnpm, runs `pnpm build`, creates `.agency/config.json`, verifies CLI and spec-kit plugin
- [ ] Phase 3 — Builds Generacy: installs deps (excluding claude-code plugin filter), runs `pnpm build`, links CLI globally via `npm link`
- [ ] `--skip-agency`, `--skip-generacy`, `--skip-cleanup` flags allow skipping individual phases
- [ ] Logs progress for each phase with clear start/complete/error messages
- [ ] Exits with non-zero code if any critical build step fails

### US4: Start Cloud Services

**As a** developer who needs backend services running locally,
**I want** to run `generacy setup services` to start Firebase emulators and API servers,
**So that** I can develop and test frontend features against local backends without deploying to staging.

**Acceptance Criteria**:
- [ ] Starts Firebase emulators for Generacy (Firestore 8080, Auth 9099, UI 4000)
- [ ] Starts Firebase emulators for Humancy (Firestore 8081, Auth 9199, UI 4001)
- [ ] Starts API servers (generacy-api on 3010, humancy-api on 3002)
- [ ] Checks and installs missing dependencies before starting
- [ ] Builds packages if `dist/` directory is missing
- [ ] Waits for services to be ready using health checks (configurable `--timeout`, default 60s)
- [ ] `--only generacy|humancy` limits which services start
- [ ] `--skip-api` starts only emulators without API servers
- [ ] Logs output to `/tmp/cloud-services/` per service
- [ ] Handles graceful shutdown on SIGTERM/SIGINT, stopping all child processes

### US5: Full Environment Setup

**As a** developer starting a fresh dev container,
**I want** to run `generacy setup auth && generacy setup workspace && generacy setup build && generacy setup services` as a complete bootstrap sequence,
**So that** I go from an empty container to a fully operational development environment.

**Acceptance Criteria**:
- [ ] Each command works independently and can be re-run idempotently
- [ ] Commands compose correctly when run in sequence
- [ ] A failure in one command produces a clear error message without corrupting state for subsequent runs

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `setup` parent command group registered in CLI index | P1 | Commander.js `program.addCommand(setupCommand())` |
| FR-002 | `setup auth` configures git user identity | P1 | From `--email`/`--username` or `GH_EMAIL`/`GH_USERNAME` env |
| FR-003 | `setup auth` configures git credential helper | P1 | Via `gh auth setup-git` or `~/.git-credentials` with `GH_TOKEN` |
| FR-004 | `setup auth` verifies GitHub CLI authentication | P1 | Runs `gh auth status`, logs result |
| FR-005 | `setup workspace` clones repositories from configurable list | P1 | Default: 8 generacy-ai repos |
| FR-006 | `setup workspace` updates existing repos (fetch + checkout) | P1 | Skips clone if directory exists |
| FR-007 | `setup workspace` installs deps per repo | P1 | Auto-detect pnpm vs npm from lockfile |
| FR-008 | `setup workspace --clean` performs hard reset before update | P1 | `git reset --hard && git clean -fd` |
| FR-009 | `setup workspace` adds git safe directories | P2 | `git config --global --add safe.directory <path>` |
| FR-010 | `setup build` Phase 1: clean stale Claude plugin state | P2 | Remove marketplace cache, reset installed_plugins.json |
| FR-011 | `setup build` Phase 2: build Agency packages | P1 | Latency first, then agency install + build + config |
| FR-012 | `setup build` Phase 3: build Generacy packages | P1 | Install, build, npm link |
| FR-013 | `setup build` skip flags for each phase | P2 | `--skip-agency`, `--skip-generacy`, `--skip-cleanup` |
| FR-014 | `setup services` starts Firebase emulators | P1 | Generacy + Humancy on separate ports |
| FR-015 | `setup services` starts API servers | P1 | generacy-api:3010, humancy-api:3002 |
| FR-016 | `setup services` health checks with timeout | P1 | Netcat or TCP connect checks, default 60s timeout |
| FR-017 | `setup services --only` filters which services start | P2 | `generacy`, `humancy`, or `all` |
| FR-018 | `setup services --skip-api` starts only emulators | P2 | Skips API server startup |
| FR-019 | `setup services` graceful shutdown handler | P1 | SIGTERM/SIGINT kills child processes cleanly |
| FR-020 | `setup services` logs output to `/tmp/cloud-services/` | P2 | Separate log file per service |
| FR-021 | All commands use Pino logger from `utils/logger.ts` | P1 | Structured logging, respects `--log-level` |
| FR-022 | All commands support env var fallbacks for options | P1 | CLI args override env vars override defaults |
| FR-023 | All commands use three-tier config resolution pattern | P1 | Match existing `resolveConfig` pattern |
| FR-024 | `setup services` sets required env vars for child processes | P1 | `FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`, etc. |
| FR-025 | `setup build` creates `.agency/config.json` for plugin discovery | P1 | Must contain valid plugin paths |
| FR-026 | `setup build` verifies critical artifacts exist after build | P2 | Agency CLI binary, spec-kit plugin dist |
| FR-027 | Unit tests for option parsing and config resolution | P1 | Vitest, following existing cli.test.ts patterns |
| FR-028 | Unit tests for core logic of each subcommand | P2 | Mock child_process, fs operations |

## Technical Design

### File Structure

```
packages/generacy/src/cli/commands/
├── setup.ts                    # Parent command group, exports setupCommand()
└── setup/
    ├── auth.ts                 # generacy setup auth
    ├── workspace.ts            # generacy setup workspace
    ├── build.ts                # generacy setup build
    └── services.ts             # generacy setup services
```

### Command Registration

In `packages/generacy/src/cli/index.ts`, add:
```typescript
import { setupCommand } from './commands/setup.js';
// ...
program.addCommand(setupCommand());
```

### Pattern Compliance

Each subcommand file exports a function returning a `Command`:

```typescript
export function setupAuthCommand(): Command {
  const command = new Command('auth');
  command
    .description('Configure git credentials and GitHub authentication')
    .option('--email <email>', 'Git user email (or GH_EMAIL env)')
    .option('--username <name>', 'Git user name (or GH_USERNAME env)')
    .action(async (options) => {
      const logger = getLogger();
      // ...implementation
    });
  return command;
}
```

The parent `setup.ts` composes subcommands:

```typescript
export function setupCommand(): Command {
  const command = new Command('setup');
  command.description('Dev container setup commands');
  command.addCommand(setupAuthCommand());
  command.addCommand(setupWorkspaceCommand());
  command.addCommand(setupBuildCommand());
  command.addCommand(setupServicesCommand());
  return command;
}
```

### Shell Command Execution

Use Node.js `child_process.execSync` / `spawn` for running git, gh, pnpm, npm, and firebase commands. Wrap in utility functions for consistent error handling and logging:

```typescript
function exec(cmd: string, options?: ExecOptions): string {
  const logger = getLogger();
  logger.debug({ cmd }, 'Executing command');
  try {
    return execSync(cmd, { encoding: 'utf-8', ...options }).trim();
  } catch (error) {
    logger.error({ cmd, error }, 'Command failed');
    throw error;
  }
}
```

For long-running services (`setup services`), use `spawn` with stdout/stderr piped to log files and the Pino logger.

### Environment Variable Mapping

| CLI Option | Env Variable | Default |
|-----------|-------------|---------|
| `auth --email` | `GH_EMAIL` | — |
| `auth --username` | `GH_USERNAME` | — |
| `workspace --repos` | `REPOS` | 8 default repos |
| `workspace --branch` | `REPO_BRANCH` | `develop` |
| `workspace --clean` | `CLEAN_REPOS` | `false` |
| `workspace --workdir` | — | `/workspaces` |
| `services --only` | — | `all` |
| `services --timeout` | — | `60` |
| — | `GH_TOKEN` | — (used by auth) |
| — | `GITHUB_ORG` | `generacy-ai` |

### Service Port Allocation

| Service | Port | Env Var Set |
|---------|------|------------|
| Generacy Firestore Emulator | 8080 | `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` |
| Generacy Auth Emulator | 9099 | `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099` |
| Generacy Emulator UI | 4000 | — |
| Humancy Firestore Emulator | 8081 | `FIRESTORE_EMULATOR_HOST=127.0.0.1:8081` |
| Humancy Auth Emulator | 9199 | `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9199` |
| Humancy Emulator UI | 4001 | — |
| Generacy API | 3010 | `PORT=3010` |
| Humancy API | 3002 | `PORT=3002` |

### Testing Strategy

Tests go in `packages/generacy/src/__tests__/setup.test.ts` (or `setup/` subdirectory), using Vitest with the existing configuration.

**Unit tests** (mock `child_process`, `fs`):
- Option parsing and env var resolution for each subcommand
- Config validation (invalid email, missing token, bad port)
- Package manager detection logic (pnpm-lock.yaml vs package-lock.json)
- Repo list parsing (comma-separated, defaults)
- Build phase skip logic
- Service filtering (`--only`, `--skip-api`)

**Integration considerations**:
- Shell command execution tests should mock `execSync`/`spawn` to avoid actual git/npm operations
- Service startup tests should verify correct spawn arguments and environment variables without starting real processes

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Bash script parity | 100% of existing script functionality covered | Manual comparison of script features vs command features |
| SC-002 | Unit test coverage | All option parsing and core logic paths tested | `vitest run --coverage` on setup command files |
| SC-003 | Idempotent execution | All commands safe to re-run without errors | Run each command twice in succession |
| SC-004 | Clean container bootstrap | Full setup from empty container succeeds | Run `auth → workspace → build → services` on fresh container |
| SC-005 | Error messaging | All failure modes produce actionable log messages | Review logs for each error path |
| SC-006 | Env var fallback | All commands work with only env vars (no CLI flags) | Run commands with env vars set, no flags |
| SC-007 | Graceful shutdown | `setup services` cleans up all child processes on SIGINT | Send SIGINT, verify no orphan processes |

## Assumptions

- The dev container has `git`, `gh` (GitHub CLI), `pnpm`, `npm`, `node`, and `firebase` CLI tools pre-installed
- `GH_TOKEN` is available in the environment for authentication (injected by dev container or `agent.env`)
- The dev container has network access to GitHub and npm registry during setup
- Repositories are hosted under the `generacy-ai` GitHub organization
- The `/workspaces` directory exists and is writable
- Python3 is available for JSON manipulation during Claude plugin cleanup (Phase 1 of build) — or this is reimplemented in Node.js
- Port numbers for Firebase emulators and API servers are fixed and not configurable (matching current scripts)
- The existing `resolveConfig` pattern in `utils/config.ts` will be extended or a parallel setup config module will be created

## Out of Scope

- **VS Code extension building**: `setup-extensions.sh` functionality (VSIX packaging, `code --install-extension`) is a separate concern and not included in this feature
- **Remote/CI execution**: These commands are designed for dev container use only, not CI pipelines
- **Service orchestration/restart**: No process manager (pm2, systemd) integration — services run as foreground/background child processes
- **Port conflict detection**: Commands assume ports are available; no automatic port reassignment
- **Windows/macOS support**: Commands target the Linux dev container environment only
- **Stripe configuration**: Stripe API keys are passed through as environment variables but not managed by setup commands
- **Database seeding**: No seed data population for Firebase emulators
- **Interactive prompts**: All input comes from CLI flags or environment variables; no interactive TTY prompts
- **`generacy setup all`**: No composite command that runs all subcommands in sequence (users chain commands manually)

---

*Generated by speckit*
