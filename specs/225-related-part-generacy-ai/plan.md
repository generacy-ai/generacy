# Implementation Plan: Generacy Setup CLI Subcommands

**Branch**: `225-related-part-generacy-ai` | **Date**: 2026-02-24

## Summary

Add a `generacy setup` command group with four subcommands (`auth`, `workspace`, `build`, `services`) that replace the bash scripts in `tetrad-development/.devcontainer/`. The implementation follows the existing CLI patterns exactly: Commander.js commands, Pino structured logging, and per-command config resolution with three-tier priority (defaults → env vars → CLI args).

New files:
- `packages/generacy/src/cli/commands/setup.ts` — parent command group
- `packages/generacy/src/cli/commands/setup/auth.ts` — git/gh credential setup
- `packages/generacy/src/cli/commands/setup/workspace.ts` — repo clone/update + dep install
- `packages/generacy/src/cli/commands/setup/build.ts` — plugin cleanup + agency/generacy builds
- `packages/generacy/src/cli/commands/setup/services.ts` — firebase emulators + API servers
- `packages/generacy/src/cli/utils/exec.ts` — shared shell execution utility
- `packages/generacy/src/__tests__/setup/auth.test.ts` — auth command tests
- `packages/generacy/src/__tests__/setup/workspace.test.ts` — workspace command tests
- `packages/generacy/src/__tests__/setup/build.test.ts` — build command tests
- `packages/generacy/src/__tests__/setup/services.test.ts` — services command tests
- `packages/generacy/src/__tests__/setup/exec.test.ts` — exec utility tests

Modified files:
- `packages/generacy/src/cli/index.ts` — register `setupCommand()`

## Technical Context

| Aspect | Detail |
|--------|--------|
| Language | TypeScript (ES2022, NodeNext modules) |
| CLI framework | Commander.js ^12.0.0 |
| Logging | Pino ^9.0.0 + pino-pretty ^11.0.0 |
| Testing | Vitest (globals, node environment, v8 coverage) |
| Build | `tsc` (strict mode, declaration maps) |
| Package manager | pnpm with `workspace:*` protocol |
| Runtime | Node.js (dev container Linux environment) |

No new dependencies required — `child_process`, `fs`, `path`, `net`, and `os` are all Node.js built-ins.

## Architecture Overview

```
packages/generacy/src/cli/
├── index.ts                          # Add: program.addCommand(setupCommand())
├── commands/
│   ├── setup.ts                      # Parent command: composes 4 subcommands
│   └── setup/
│       ├── auth.ts                   # generacy setup auth
│       ├── workspace.ts              # generacy setup workspace
│       ├── build.ts                  # generacy setup build
│       └── services.ts              # generacy setup services
└── utils/
    ├── exec.ts                       # NEW: shared execSync/spawn wrappers
    ├── config.ts                     # Existing (unchanged)
    └── logger.ts                     # Existing (unchanged)
```

Each subcommand file exports a factory function returning a `Command` instance, matching the pattern in `worker.ts`, `orchestrator.ts`, etc. The parent `setup.ts` composes them via `command.addCommand()`.

### Config Resolution Pattern

Per clarification Q13, each subcommand defines its own config type and resolves it inline using the same three-tier merge:

```typescript
interface AuthConfig {
  email?: string;
  username?: string;
  token?: string;
}

function resolveAuthConfig(cliArgs: Partial<AuthConfig>): AuthConfig {
  return {
    email: cliArgs.email ?? process.env['GH_EMAIL'],
    username: cliArgs.username ?? process.env['GH_USERNAME'],
    token: cliArgs.token ?? process.env['GH_TOKEN'],
  };
}
```

### Shell Execution Utility (`utils/exec.ts`)

Shared wrapper for `child_process.execSync` and `child_process.spawn`:

```typescript
import { execSync, spawn, type SpawnOptions } from 'node:child_process';
import { getLogger } from './logger.js';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeout?: number;
  stdio?: 'pipe' | 'inherit';
}

/** Run a command synchronously, return stdout. Throws on non-zero exit. */
export function exec(cmd: string, options?: ExecOptions): string {
  const logger = getLogger();
  logger.debug({ cmd, cwd: options?.cwd }, 'exec');
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      cwd: options?.cwd,
      env: options?.env ? { ...process.env, ...options.env } : undefined,
      timeout: options?.timeout,
      stdio: options?.stdio === 'inherit' ? 'inherit' : 'pipe',
    }).trim();
  } catch (error) {
    logger.error({ cmd, error: String(error) }, 'Command failed');
    throw error;
  }
}

/** Run a command synchronously, return success boolean. Does not throw. */
export function execSafe(cmd: string, options?: ExecOptions): { ok: boolean; stdout: string; stderr: string } { ... }

/** Spawn a long-running background process. Returns ChildProcess. */
export function spawnBackground(cmd: string, args: string[], options?: SpawnOptions): ChildProcess { ... }
```

---

## Implementation Phases

### Phase 1: Shared Infrastructure (utils/exec.ts + command registration)

**Files**: `utils/exec.ts`, `commands/setup.ts`, `cli/index.ts`

**Steps**:

1. **Create `packages/generacy/src/cli/utils/exec.ts`**
   - `exec(cmd, options)` — synchronous execution, returns stdout string, throws on failure
   - `execSafe(cmd, options)` — synchronous execution, returns `{ ok, stdout, stderr }`, never throws
   - `spawnBackground(cmd, args, options)` — spawns a child process, returns `ChildProcess`
   - All functions log via `getLogger()` at debug level
   - `exec` logs errors at error level before re-throwing

2. **Create `packages/generacy/src/cli/commands/setup.ts`** (parent command)
   ```typescript
   import { Command } from 'commander';
   import { setupAuthCommand } from './setup/auth.js';
   import { setupWorkspaceCommand } from './setup/workspace.js';
   import { setupBuildCommand } from './setup/build.js';
   import { setupServicesCommand } from './setup/services.js';

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

3. **Modify `packages/generacy/src/cli/index.ts`**
   - Add `import { setupCommand } from './commands/setup.js';`
   - Add `program.addCommand(setupCommand());` after existing command registrations

4. **Create `packages/generacy/src/__tests__/setup/exec.test.ts`**
   - Test `exec()` returns stdout for successful commands
   - Test `exec()` throws on command failure
   - Test `execSafe()` returns `{ ok: false }` on failure without throwing
   - Test `spawnBackground()` returns a ChildProcess

---

### Phase 2: `setup auth` Command

**File**: `packages/generacy/src/cli/commands/setup/auth.ts`

**Replaces**: `.devcontainer/ensure-auth.sh`

**Config type**:
```typescript
interface AuthConfig {
  email?: string;
  username?: string;
  token?: string;
}
```

**Implementation steps**:

1. **Define and export `setupAuthCommand(): Command`**
   - Options: `--email <email>`, `--username <name>`
   - No required options (per Q3: warn and continue)

2. **Action handler logic** (matches `ensure-auth.sh` exactly):
   - Resolve config: `email` from `--email` / `GH_EMAIL`, `username` from `--username` / `GH_USERNAME`, `token` from `GH_TOKEN`
   - **Step 1: Configure git identity**
     - If email set: `git config --global user.email <email>`
     - If username set: `git config --global user.name <username>`
     - If either missing: log warning
   - **Step 2: Configure git credential helper**
     - If `GH_TOKEN` set:
       - `git config --global credential.helper store`
       - Write `https://<username|git>:<token>@github.com` to `~/.git-credentials` (mode 0o600)
       - Log success
     - If `GH_TOKEN` not set: log warning
   - **Step 3: Configure gh CLI**
     - If `GH_TOKEN` set:
       - Check `gh auth status` — if OK, log success
       - If not OK: pipe token to `gh auth login --with-token`
     - If `GH_TOKEN` not set:
       - Check `gh auth status` — log result
   - **Step 4: Verify authentication**
     - Run `gh auth status`, log output
     - If verification fails, exit with code 1

3. **Create `packages/generacy/src/__tests__/setup/auth.test.ts`**
   - Mock `child_process.execSync` and `fs.writeFileSync`
   - Test config resolution from CLI args vs env vars
   - Test git identity configuration (called with correct args)
   - Test credential file written with correct content and permissions
   - Test gh auth flow (already authenticated vs needs login)
   - Test warning logged when email/username missing
   - Test exit code 1 when auth verification fails

---

### Phase 3: `setup workspace` Command

**File**: `packages/generacy/src/cli/commands/setup/workspace.ts`

**Replaces**: `.devcontainer/setup-repos.sh`

**Config type**:
```typescript
interface WorkspaceConfig {
  repos: string[];
  branch: string;
  workdir: string;
  clean: boolean;
  githubOrg: string;
}

const DEFAULT_REPOS = [
  'tetrad-development',
  'contracts',
  'latency',
  'agency',
  'generacy',
  'humancy',
  'generacy-cloud',
  'humancy-cloud',
];
```

**Implementation steps**:

1. **Define and export `setupWorkspaceCommand(): Command`**
   - Options:
     - `--repos <repos>` — comma-separated repo list (env: `REPOS`, default: 8 repos)
     - `--branch <branch>` — target branch (env: `REPO_BRANCH` / `DEFAULT_BRANCH`, default: `develop`)
     - `--workdir <dir>` — workspace root (default: `/workspaces`)
     - `--clean` — hard reset before update (env: `CLEAN_REPOS`, default: false)

2. **Action handler logic** (matches `setup-repos.sh` exactly):
   - Resolve config with three-tier merge
   - `mkdir -p <workdir>` if it doesn't exist
   - **Step 1: Configure git safe directories**
     - `git config --global --add safe.directory '*'` (per Q16: wildcard)
   - **Step 2: Ensure git credentials**
     - Check if `~/.git-credentials` exists or `gh auth status` succeeds
     - If not configured, call auth logic internally (check for `GH_TOKEN`)
     - Run `gh auth setup-git` if gh is authenticated (additional layer from setup-repos.sh)
   - **Step 3: Clone/update repos**
     - Always process `tetrad-development` first (explicit ordering from script)
     - For each repo in the list:
       - **If `.git` exists in target dir**: update flow
         - If `--clean`: `git reset --hard HEAD && git clean -fd`
         - `git fetch origin`
         - Check current branch vs target branch; switch if needed
         - `git pull origin <branch>` (continue on failure)
       - **If not exists**: clone flow
         - Try `git clone --branch <branch> https://github.com/<org>/<repo>.git <target>`
         - On failure: retry without `--branch` (per Q10: fall back to default branch)
         - On second failure: log error, increment failure count
     - Track successes and failures
   - **Step 4: Install dependencies**
     - For each successfully cloned/updated repo:
       - If `pnpm-lock.yaml` exists: `pnpm install`
       - Else if `package-lock.json` or `package.json` exists: `npm install`
       - Continue on install failure
   - **Step 5: Report summary**
     - Log count of successful and failed repos
     - If failures > 0: exit with code 1

3. **Helper: `detectPackageManager(repoPath)`**
   - Returns `'pnpm'` if `pnpm-lock.yaml` exists, otherwise `'npm'`

4. **Create `packages/generacy/src/__tests__/setup/workspace.test.ts`**
   - Test config resolution: default repos, env var override, CLI override
   - Test repo list parsing (comma-separated string → array)
   - Test `tetrad-development` cloned first
   - Test clone-or-update logic: existing repo goes to update path
   - Test `--clean` flag triggers hard reset
   - Test branch fallback when branch doesn't exist
   - Test package manager detection (pnpm-lock.yaml vs package-lock.json)
   - Test failure summary reporting

---

### Phase 4: `setup build` Command

**File**: `packages/generacy/src/cli/commands/setup/build.ts`

**Replaces**: `.devcontainer/setup-plugins.sh`

**Config type**:
```typescript
interface BuildConfig {
  skipCleanup: boolean;
  skipAgency: boolean;
  skipGeneracy: boolean;
  agencyDir: string;
  generacyDir: string;
  latencyDir: string;
}
```

**Implementation steps**:

1. **Define and export `setupBuildCommand(): Command`**
   - Options:
     - `--skip-cleanup` — skip Phase 1 plugin cleanup
     - `--skip-agency` — skip Phase 2 Agency build
     - `--skip-generacy` — skip Phase 3 Generacy build

2. **Phase 1: Clean stale Claude plugin state** (unless `--skip-cleanup`)
   - All operations use Node.js `fs` (per Q4: pure Node.js):
     - Remove `~/.claude/plugins/cache/painworth-marketplace/` directory
     - Remove `~/.claude/plugins/marketplaces/painworth-marketplace/` directory
     - Reset `~/.claude/plugins/installed_plugins.json` to `{"version":2,"plugins":{}}`
     - Remove `~/.claude/plugins/known_marketplaces.json`
     - Remove `~/.claude/plugins/install-counts-cache.json`
     - Read `~/.claude/settings.json`, parse JSON, delete `enabledPlugins` key, write back
     - All operations wrapped in try/catch — log warnings on failure, never throw

3. **Phase 2: Build Agency packages** (unless `--skip-agency`)
   - Check agency dir exists, skip if not
   - **Build latency dependency first**:
     - `cd /workspaces/latency && pnpm install && pnpm build`
   - **Install agency deps**: `cd /workspaces/agency && pnpm install`
   - **Build agency**: `pnpm build`
   - **Create `.agency/config.json`** if it doesn't exist:
     ```json
     {
       "name": "agency",
       "pluginPaths": ["/workspaces/agency/packages"],
       "defaultMode": "coding",
       "modes": { "coding": ["*"], "research": ["*"], "default": ["*"] }
     }
     ```
   - **Verify artifacts** (per Q11: hard error):
     - Check `packages/agency/dist/cli.js` exists
     - Check `packages/agency-plugin-spec-kit/dist/index.js` exists
     - If either missing: log error with specific file path, exit code 1

4. **Phase 3: Build Generacy packages** (unless `--skip-generacy`)
   - Check generacy dir exists, skip if not
   - **Install deps**: `pnpm install --filter "!@generacy-ai/generacy-plugin-claude-code"` (per Q5: hardcoded)
   - **Build**: `pnpm build`
   - **Link globally**: `cd packages/generacy && npm link`
   - **Verify artifacts**: check `packages/generacy/dist/cli/index.js` exists

5. **Create `packages/generacy/src/__tests__/setup/build.test.ts`**
   - Test skip flags: each phase skippable independently
   - Test Phase 1 cleanup: all file operations called correctly
   - Test Phase 1 settings.json: enabledPlugins removed, other keys preserved
   - Test Phase 2 build order: latency before agency
   - Test Phase 2 config.json creation (only if not exists)
   - Test Phase 2 artifact verification: missing file → error exit
   - Test Phase 3 filter exclusion in install command
   - Test Phase 3 npm link called

---

### Phase 5: `setup services` Command

**File**: `packages/generacy/src/cli/commands/setup/services.ts`

**Replaces**: `.devcontainer/setup-cloud-services.sh`

**Config type**:
```typescript
interface ServicesConfig {
  only: 'all' | 'generacy' | 'humancy';
  skipApi: boolean;
  timeout: number;
  logDir: string;
}
```

**Service definitions** (constant data):
```typescript
const SERVICES = {
  generacy: {
    cloudDir: '/workspaces/generacy-cloud',
    emulatorPorts: { firestore: 8080, auth: 9099, ui: 4000 },
    api: { port: 3010, projectId: 'generacy-cloud' },
  },
  humancy: {
    cloudDir: '/workspaces/humancy-cloud',
    emulatorPorts: { firestore: 8081, auth: 9199, ui: 4001 },
    api: { port: 3002, projectId: 'humancy-cloud' },
  },
};
```

**Implementation steps**:

1. **Define and export `setupServicesCommand(): Command`**
   - Options:
     - `--only <target>` — `generacy`, `humancy`, or `all` (default: `all`)
     - `--skip-api` — start only emulators
     - `--timeout <seconds>` — health check timeout (default: `60`)

2. **Action handler logic** (matches `setup-cloud-services.sh` behavior):
   - Resolve config
   - Create log directory: `mkdir -p /tmp/cloud-services`
   - Truncate existing log files (per Q15)
   - Determine which services to start based on `--only`
   - **For each enabled service (generacy, humancy)**:
     - **Ensure deps**: check `node_modules` dir count ≥ 10; if not, `pnpm install`
     - **Build if needed**: check `services/api/dist` dir; if missing, `pnpm run build`
     - **Start emulators**: `spawn('firebase', ['emulators:start'], { cwd, detached: true })`
       - Pipe stdout/stderr to log file
     - **Start API** (unless `--skip-api`):
       - Spawn `npx tsx watch src/index.ts` with per-process env (per Q6):
         - `FIRESTORE_EMULATOR_HOST=127.0.0.1:<port>`
         - `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:<port>`
         - `FIREBASE_PROJECT_ID=<id>`
         - `PORT=<port>`
         - Stripe env vars passed through
       - Pipe stdout/stderr to log file

3. **Health checks using Node.js `net.Socket`** (per Q7):
   ```typescript
   async function waitForPort(port: number, name: string, timeoutSec: number): Promise<boolean> {
     const start = Date.now();
     while (Date.now() - start < timeoutSec * 1000) {
       try {
         await new Promise<void>((resolve, reject) => {
           const socket = new net.Socket();
           socket.setTimeout(1000);
           socket.connect(port, '127.0.0.1', () => { socket.destroy(); resolve(); });
           socket.on('error', reject);
           socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
         });
         return true;
       } catch {
         await new Promise(r => setTimeout(r, 1000));
       }
     }
     return false;
   }
   ```
   - Wait for emulator ports, then API ports
   - Log success/failure for each

4. **Background fire-and-forget behavior** (per Q8):
   - Services spawned with `detached: true` and `stdio` piped to log files
   - `child.unref()` so the parent process can exit
   - Command returns after health checks complete (or timeout)

5. **Graceful shutdown handler** (FR-019):
   - Track all spawned child PIDs
   - On SIGTERM/SIGINT: send SIGTERM to all children
   - After 5s (per Q12): send SIGKILL to any remaining
   - Note: in fire-and-forget mode, the shutdown handler is registered but the command exits after startup. It primarily protects during the startup+health-check window.

6. **Create `packages/generacy/src/__tests__/setup/services.test.ts`**
   - Mock `child_process.spawn`, `fs.mkdirSync`, `net.Socket`
   - Test `--only generacy` starts only generacy services
   - Test `--only humancy` starts only humancy services
   - Test `--skip-api` skips API server spawn
   - Test per-process env vars set correctly (different FIRESTORE_EMULATOR_HOST per service)
   - Test health check retry logic
   - Test health check timeout behavior
   - Test log directory creation and file truncation
   - Test graceful shutdown sends SIGTERM then SIGKILL

---

### Phase 6: Integration & Verification

1. **Update CLI program test** (`__tests__/cli.test.ts`):
   - Add assertion that `setup` command is registered
   - Verify `setup` has 4 subcommands: `auth`, `workspace`, `build`, `services`

2. **Build verification**:
   - Run `pnpm build` — ensure all new files compile without errors
   - Run `pnpm test` — ensure all tests pass

3. **Manual testing checklist** (documented in test, not automated):
   - `generacy setup auth --help` shows options
   - `generacy setup workspace --help` shows options
   - `generacy setup build --help` shows options
   - `generacy setup services --help` shows options
   - `generacy setup --help` shows all 4 subcommands

---

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Config pattern | Per-command inline resolution (Q13-C) | Each command has different options; shared type would be a grab-bag |
| Auth behavior | Match existing scripts (Q2-C) | Battle-tested dual approach: `.git-credentials` + `gh auth` |
| Missing auth fields | Warn and continue (Q3-B) | Matches `ensure-auth.sh` lenient behavior |
| Plugin cleanup | Pure Node.js (Q4-A) | No Python dependency needed for JSON parse/stringify |
| Package filter | Hardcoded (Q5-A) | Known workaround; comment documents it |
| Per-process env | spawn `env` option (Q6-A) | Clean child isolation per existing script behavior |
| Health checks | `net.Socket` (Q7-A) | Zero external deps, testable |
| Service lifecycle | Background fire-and-forget (Q8-C) | Must return for sequential entrypoint flow |
| Exec utility | Shared `utils/exec.ts` (Q9-A) | 4 commands share shell execution needs |
| Branch fallback | Clone without branch on failure (Q10-B) | Matches `setup-repos.sh` behavior |
| Artifact verification | Hard error (Q11-A) | Downstream commands depend on these files |
| Shutdown timeout | 5 seconds (Q12-A) | No persistent state in emulators |
| Idempotency | Rely on naturally idempotent operations (Q14-C) | Clone-if-not-exists, fetch-always-works, etc. |
| Log files | Truncate on restart (Q15-A) | Previous session logs are stale |
| Safe directory | Wildcard `*` (Q16-A) | Dev container, not production |

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Shell command failures break entire setup | `execSafe` for non-critical commands; only `exec` (throwing) for critical steps. Each subcommand catches and reports errors per-operation, continuing where possible. |
| Firebase emulator port conflicts | Health check timeout reports which port failed. Spec explicitly excludes port conflict detection (out of scope), but clear error messages guide debugging. |
| Missing `gh` / `firebase` / `pnpm` CLI tools | Pre-check for required binaries at command start; fail fast with message listing what's missing. Assumption: these are pre-installed in the dev container. |
| Large test surface for shell commands | Mock `child_process` at module level; test option parsing and config resolution separately from execution. Keep tests focused on argument construction, not shell output. |
| Build order dependencies (latency → agency → generacy) | Explicit sequential execution within `setup build`. Phase ordering is hardcoded, not configurable. |
| Partial clone failures leave workspace in bad state | Idempotent design: re-running `setup workspace` retries failed clones and updates existing repos. No state file to corrupt. |
| `npm link` conflicts with pnpm workspace | Matches existing script behavior. The `npm link` in `packages/generacy` makes the `generacy` binary available globally. |
