# Feature Specification: Add `generacy setup` CLI Subcommands

**Branch**: `225-related-part-generacy-ai` | **Date**: 2026-02-23 | **Status**: Draft
**Parent Epic**: generacy-ai/tetrad-development#6 (Dev Container Infrastructure Refactor)

## Summary

Add a `generacy setup` command group to the CLI that replaces four bash scripts currently in `.devcontainer/` of tetrad-development. These commands run inside the dev container and handle authentication (`ensure-auth.sh`), workspace initialization (`setup-repos.sh`), package building (`setup-plugins.sh`), and service startup (`setup-cloud-services.sh`).

Moving from bash scripts to TypeScript CLI commands provides type safety, structured logging, better error handling, testability, and a consistent developer experience across all setup operations.

## User Stories

### US1: Authenticate Dev Container

**As a** developer starting a dev container,
**I want** to run `generacy setup auth` to configure my Git and GitHub credentials,
**So that** I can push, pull, and interact with GitHub repos without manual credential setup.

**Acceptance Criteria**:
- [ ] Configures `git config user.name` and `git config user.email` from CLI args or env vars (`GH_USERNAME`, `GH_EMAIL`)
- [ ] Sets up Git credential helper using `gh auth setup-git` when GitHub CLI is authenticated
- [ ] Falls back to writing `~/.git-credentials` from `GH_TOKEN` env var when `gh` is not authenticated
- [ ] Sets file permissions on `~/.git-credentials` to `0600`
- [ ] Verifies authentication by running `gh auth status`
- [ ] Logs success/warning/error status with structured Pino output
- [ ] Exits with code 0 on success, code 1 on failure
- [ ] Warns (does not fail) when optional credentials are missing

### US2: Initialize Workspace Repositories

**As a** developer setting up a fresh dev container,
**I want** to run `generacy setup workspace` to clone and configure all project repositories,
**So that** I have a fully initialized workspace with all repos, correct branches, and installed dependencies.

**Acceptance Criteria**:
- [ ] Clones missing repos from the default list (or `--repos` override) into `--workdir` (default `/workspaces`)
- [ ] Pulls latest changes for repos that already exist
- [ ] Calls `generacy setup auth` logic internally before cloning if credentials are not yet configured
- [ ] Configures `git safe.directory` for each repo
- [ ] Sets git user identity per repo from env vars
- [ ] Checks out the specified branch (`--branch`, `REPO_BRANCH` env, or default `develop`)
- [ ] Detects package manager per repo (pnpm if `pnpm-lock.yaml` exists, npm otherwise)
- [ ] Installs dependencies per repo using the detected package manager
- [ ] With `--clean` flag: runs `git reset --hard` and `git clean -fd` before pulling
- [ ] Reports summary of successes and failures at the end
- [ ] Continues processing remaining repos when one fails (does not abort)

### US3: Build Packages

**As a** developer preparing the dev environment,
**I want** to run `generacy setup build` to compile all required packages,
**So that** the Agency MCP server, Generacy CLI, and all dependencies are built and linked.

**Acceptance Criteria**:
- [ ] **Phase 1 — Cleanup**: Removes stale Claude plugin state (marketplace cache, `installed_plugins.json`, `known_marketplaces.json`, `install-counts-cache.json`, `enabledPlugins` from `~/.claude/settings.json`)
- [ ] **Phase 2 — Agency Build**: Builds latency first (`/workspaces/latency`), then installs and builds Agency packages with pnpm, creates `.agency/config.json`, verifies CLI and spec-kit plugin artifacts exist
- [ ] **Phase 3 — Generacy Build**: Installs dependencies (filtering out claude-code plugin), builds packages, links CLI globally via `npm link`
- [ ] `--skip-cleanup` skips Phase 1
- [ ] `--skip-agency` skips Phase 2
- [ ] `--skip-generacy` skips Phase 3
- [ ] Each phase logs progress and reports success/failure independently
- [ ] Exits with code 1 if any non-skipped phase fails

### US4: Start Cloud Services

**As a** developer running the full stack locally,
**I want** to run `generacy setup services` to start Firebase emulators and API servers,
**So that** I can develop and test against local backend services.

**Acceptance Criteria**:
- [ ] Checks that cloud package dependencies are installed; installs them if missing
- [ ] Builds cloud services if dist artifacts are missing
- [ ] Starts Firebase emulators for Generacy (Firestore :8080, Auth :9099, UI :4000)
- [ ] Starts Firebase emulators for Humancy (Firestore :8081, Auth :9199, UI :4001)
- [ ] Starts API dev servers (generacy-api :3010, humancy-api :3002) using `npx tsx watch`
- [ ] Sets emulator environment variables (`FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`)
- [ ] Waits for all services to be ready using port checks (TCP connect)
- [ ] Logs all service output to `/tmp/cloud-services/` directory
- [ ] `--only generacy` starts only Generacy services; `--only humancy` starts only Humancy services
- [ ] `--skip-api` skips API server startup (emulators only)
- [ ] `--timeout <seconds>` configures readiness wait time (default 60)
- [ ] Handles SIGTERM/SIGINT for graceful shutdown of spawned processes
- [ ] Exits with code 1 if services fail to start within the timeout

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| **Command Registration** | | | |
| FR-001 | Register `setup` as a parent command group in `cli/index.ts` | P1 | First subcommand group in the CLI; use `program.addCommand(setupCommand())` |
| FR-002 | `setup` without a subcommand prints help text listing available subcommands | P1 | Commander.js default behavior for command groups |
| **Auth Subcommand** | | | |
| FR-010 | `setup auth` reads `--email` / `GH_EMAIL` and `--username` / `GH_USERNAME` | P1 | CLI args take precedence over env vars |
| FR-011 | `setup auth` configures git user identity globally | P1 | `git config --global user.name`, `git config --global user.email` |
| FR-012 | `setup auth` sets up git credential helper via `gh auth setup-git` | P1 | Fall back to writing `~/.git-credentials` with `GH_TOKEN` |
| FR-013 | `setup auth` verifies GitHub CLI authentication status | P2 | Run `gh auth status`, log result |
| FR-014 | `setup auth` uses colored/structured Pino output for status reporting | P2 | Replace bash `echo -e` color codes with logger levels |
| **Workspace Subcommand** | | | |
| FR-020 | `setup workspace` clones repos not present in `--workdir` | P1 | `git clone` with HTTPS URL |
| FR-021 | `setup workspace` pulls updates for existing repos | P1 | `git pull` on the target branch |
| FR-022 | `setup workspace` detects pnpm vs npm from lockfile presence | P1 | Check for `pnpm-lock.yaml` |
| FR-023 | `setup workspace` installs dependencies per repo | P1 | Run detected package manager install |
| FR-024 | `setup workspace --clean` resets repos before updating | P1 | `git reset --hard && git clean -fd` |
| FR-025 | `setup workspace` configures `git safe.directory` per repo | P1 | Prevents "dubious ownership" errors in containers |
| FR-026 | `setup workspace` supports custom repo list via `--repos` or `REPOS` env | P2 | Comma-separated `org/repo` format |
| FR-027 | `setup workspace` calls auth logic internally if credentials are not configured | P2 | Reuse auth module, not subprocess call |
| **Build Subcommand** | | | |
| FR-030 | `setup build` Phase 1: cleans stale Claude plugin state | P1 | Remove marketplace cache, installed_plugins.json, enabledPlugins |
| FR-031 | `setup build` Phase 1: safely edits `~/.claude/settings.json` to remove `enabledPlugins` | P1 | Parse JSON, delete key, write back; handle missing file gracefully |
| FR-032 | `setup build` Phase 2: builds latency package first | P1 | `cd /workspaces/latency && pnpm install && pnpm build` |
| FR-033 | `setup build` Phase 2: installs and builds Agency packages | P1 | `pnpm install && pnpm build` in `/workspaces/agency` |
| FR-034 | `setup build` Phase 2: creates `.agency/config.json` for plugin discovery | P1 | JSON config pointing to built plugin paths |
| FR-035 | `setup build` Phase 2: verifies Agency CLI and spec-kit plugin artifacts exist | P1 | Check file existence, fail if missing |
| FR-036 | `setup build` Phase 3: installs Generacy deps (excluding claude-code plugin) | P1 | `pnpm install --filter '!@generacy-ai/claude-code'` or equivalent |
| FR-037 | `setup build` Phase 3: builds and links Generacy CLI globally | P1 | `pnpm build && npm link` |
| FR-038 | `setup build` supports `--skip-agency`, `--skip-generacy`, `--skip-cleanup` flags | P2 | Each flag skips the corresponding phase |
| **Services Subcommand** | | | |
| FR-040 | `setup services` starts Firebase emulators as background processes | P1 | Spawn child processes, pipe output to log files |
| FR-041 | `setup services` starts API servers with hot-reload (`npx tsx watch`) | P1 | Background process with stdout/stderr to log files |
| FR-042 | `setup services` sets emulator environment variables for child processes | P1 | `FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST` |
| FR-043 | `setup services` waits for services using TCP port checks | P1 | Retry connect until success or timeout |
| FR-044 | `setup services` supports `--only` filter (generacy/humancy/all) | P2 | Default: all |
| FR-045 | `setup services` supports `--skip-api` flag | P2 | Start only emulators |
| FR-046 | `setup services` handles SIGTERM/SIGINT to kill child processes | P1 | Follow existing worker/orchestrator shutdown pattern |
| FR-047 | `setup services` checks and installs dependencies before starting | P2 | Auto-build if dist missing |
| **Cross-Cutting** | | | |
| FR-050 | All commands use Pino structured logging via `getLogger()` | P1 | Follow existing logger pattern |
| FR-051 | All commands support env var fallbacks for every option | P1 | Use config.ts `resolveConfig()` pattern |
| FR-052 | All commands exit with code 1 on failure, 0 on success | P1 | Consistent with existing commands |
| FR-053 | Shell command execution uses `child_process.spawn` or `execFile` (not `exec`) | P2 | Avoid shell injection; use array args |
| FR-054 | All commands log the command being executed at debug level | P2 | Aids in troubleshooting |

## Technical Design

### File Structure

```
packages/generacy/src/cli/commands/
├── setup.ts                    # Parent command group, registers subcommands
└── setup/
    ├── auth.ts                 # generacy setup auth
    ├── workspace.ts            # generacy setup workspace
    ├── build.ts                # generacy setup build
    └── services.ts             # generacy setup services
```

### Command Registration Pattern

```typescript
// setup.ts
import { Command } from 'commander';
import { authCommand } from './setup/auth.js';
import { workspaceCommand } from './setup/workspace.js';
import { buildCommand } from './setup/build.js';
import { servicesCommand } from './setup/services.js';

export function setupCommand(): Command {
  const command = new Command('setup');
  command.description('Dev container setup commands');
  command.addCommand(authCommand());
  command.addCommand(workspaceCommand());
  command.addCommand(buildCommand());
  command.addCommand(servicesCommand());
  return command;
}
```

Each subcommand follows the established pattern: export a function returning a `Command` instance with options, description, and an async action handler.

### Shell Execution Helper

Create a shared utility for running shell commands since all four subcommands spawn external processes:

```typescript
// utils/shell.ts
import { spawn } from 'child_process';
import type { Logger } from 'pino';

interface ExecResult { code: number; stdout: string; stderr: string; }

function exec(cmd: string, args: string[], opts?: SpawnOptions, logger?: Logger): Promise<ExecResult>;
```

This avoids shell injection by using `spawn` with argument arrays and provides consistent logging of commands at debug level and errors at error level.

### Service Ports Reference

| Service | Port | Protocol |
|---------|------|----------|
| Generacy Firestore Emulator | 8080 | HTTP |
| Generacy Auth Emulator | 9099 | HTTP |
| Generacy Emulator UI | 4000 | HTTP |
| Humancy Firestore Emulator | 8081 | HTTP |
| Humancy Auth Emulator | 9199 | HTTP |
| Humancy Emulator UI | 4001 | HTTP |
| Generacy API | 3010 | HTTP |
| Humancy API | 3002 | HTTP |

### Environment Variables

| Variable | Used By | Description |
|----------|---------|-------------|
| `GH_EMAIL` | auth | Git user email |
| `GH_USERNAME` | auth | Git user name |
| `GH_TOKEN` | auth | GitHub personal access token (fallback credential) |
| `REPOS` | workspace | Comma-separated repo list |
| `REPO_BRANCH` | workspace | Default branch to checkout |
| `CLEAN_REPOS` | workspace | Legacy compat — treated as `--clean` if truthy |
| `FIRESTORE_EMULATOR_HOST` | services | Set for child processes |
| `FIREBASE_AUTH_EMULATOR_HOST` | services | Set for child processes |

### Default Repository List

```typescript
const DEFAULT_REPOS = [
  'generacy-ai/tetrad-development',
  'generacy-ai/agency',
  'generacy-ai/generacy',
  'generacy-ai/generacy-cloud',
  'generacy-ai/humancy',
  'generacy-ai/humancy-cloud',
  'generacy-ai/latency',
  'generacy-ai/contracts',
];
```

## Testing Strategy

### Unit Tests

Location: `packages/generacy/src/cli/commands/__tests__/setup/`

| Test File | Covers |
|-----------|--------|
| `auth.test.ts` | Option parsing, env var fallback, credential file generation |
| `workspace.test.ts` | Repo list parsing, lockfile detection, clean flag behavior |
| `build.test.ts` | Phase skip flags, settings.json editing, artifact verification |
| `services.test.ts` | Port configuration, `--only` filtering, timeout handling |
| `shell.test.ts` | Shell execution helper, exit code propagation, output capture |

**Approach**: Mock `child_process.spawn` and filesystem operations. Test option parsing by constructing Commander `Command` instances and invoking `.parseAsync()` with argument arrays. Use Vitest's `vi.mock()` for module-level mocks.

### Integration Tests

Manual verification in a dev container:

1. `generacy setup auth` — run, then verify `git config user.name` and `gh auth status`
2. `generacy setup workspace --clean` — run in a fresh container, verify all repos cloned with deps installed
3. `generacy setup build` — run, verify `generacy --version` works globally
4. `generacy setup services` — run, verify `curl localhost:3010` and `curl localhost:8080` respond

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Script parity | 100% | All behaviors from the four bash scripts are replicated |
| SC-002 | `generacy setup auth` completes | < 5s | Time from invocation to exit on a configured container |
| SC-003 | `generacy setup workspace` completes (existing repos) | < 120s | Pull + install for 8 repos with warm caches |
| SC-004 | `generacy setup build` completes | < 180s | Full build of latency + agency + generacy |
| SC-005 | `generacy setup services` readiness | < 60s | All ports responding after invocation (default timeout) |
| SC-006 | Unit test coverage | > 80% | Line coverage across setup command modules |
| SC-007 | Zero shell injection vectors | 0 | All external commands use `spawn` with arg arrays, not `exec` with string interpolation |

## Assumptions

- The dev container has `git`, `gh` (GitHub CLI), `node`, `pnpm`, and `npm` available on `$PATH`
- `GH_TOKEN`, `GH_EMAIL`, and `GH_USERNAME` are set in the container environment (via Docker secrets or `.env`)
- The workspace root is `/workspaces` (standard devcontainer layout)
- Firebase CLI (`npx firebase`) is available within cloud service packages
- The existing Commander.js version (^12.0.0) supports nested subcommand groups (it does)
- Pino logger is already initialized by the pre-action hook in `cli/index.ts` before subcommands run
- `npm link` works inside the container (no permission issues with global installs)
- Services subcommand runs in the foreground (keeps the process alive) while spawning child processes in the background

## Out of Scope

- **VS Code extension setup** — `setup-extensions.sh` is not included in this feature; it will be a separate command
- **Docker-in-Docker setup** — `setup-docker-dind.sh` and `setup-docker-contexts.sh` are not included
- **Windows/macOS support** — These commands are designed for the Linux dev container environment only
- **Remote service startup** — Only local emulators and API servers; no cloud deployment
- **Service orchestration / process management** — No restart-on-crash, no systemd/pm2 integration; simple background processes with signal forwarding
- **Configuration file** — No `setup.yaml` or `setup.json` config file; all configuration via CLI args and env vars
- **Removing the original bash scripts** — Deprecation and removal of `.devcontainer/` scripts is a separate task after migration is verified
- **Entrypoint script migration** — Container entrypoint scripts that call the bash scripts will be updated separately
- **Port conflict detection** — If a port is already in use, the service will fail naturally; no pre-check or auto-port-assignment

---

*Generated by speckit*
