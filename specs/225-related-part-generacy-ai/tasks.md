# Tasks: Generacy Setup CLI Subcommands

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Shared Infrastructure

### T001 [US5] Create shell execution utility (`utils/exec.ts`)
**File**: `packages/generacy/src/cli/utils/exec.ts`
- Implement `exec(cmd, options)` — synchronous execution via `execSync`, returns trimmed stdout string, throws on non-zero exit
- Implement `execSafe(cmd, options)` — synchronous execution, returns `{ ok: boolean; stdout: string; stderr: string }`, never throws
- Implement `spawnBackground(cmd, args, options)` — spawns a detached child process via `child_process.spawn`, returns `ChildProcess`
- Define `ExecOptions` interface: `cwd`, `env`, `timeout`, `stdio`
- All functions log via `getLogger()` at debug level; `exec` logs errors at error level before re-throwing
- Use `node:child_process` imports (ESM style with `.js` extensions for internal imports)

### T002 [P] [US5] Create parent `setup` command group
**File**: `packages/generacy/src/cli/commands/setup.ts`
- Export `setupCommand(): Command` factory function
- Create `setup` Commander.js command with description `'Dev container setup commands'`
- Import and add all 4 subcommands via `command.addCommand()`: `setupAuthCommand`, `setupWorkspaceCommand`, `setupBuildCommand`, `setupServicesCommand`
- Note: subcommand imports will initially fail until Phase 2–5 files exist; create stub exports first if needed

### T003 [P] [US5] Register `setup` command in CLI index
**File**: `packages/generacy/src/cli/index.ts`
- Add `import { setupCommand } from './commands/setup.js';`
- Add `program.addCommand(setupCommand());` after existing command registrations (after `orchestratorCommand()`)

---

## Phase 2: `setup auth` Command

### T004 [US1] Implement `setup auth` subcommand
**File**: `packages/generacy/src/cli/commands/setup/auth.ts`
- Define `AuthConfig` interface: `email?: string`, `username?: string`, `token?: string`
- Implement `resolveAuthConfig(cliArgs)` — three-tier merge: defaults → env vars (`GH_EMAIL`, `GH_USERNAME`, `GH_TOKEN`) → CLI args
- Export `setupAuthCommand(): Command` factory function
- Register options: `--email <email>` (git user email), `--username <name>` (git user name)
- **Action handler — Step 1: Configure git identity**
  - If email set: run `git config --global user.email <email>`
  - If username set: run `git config --global user.name <username>`
  - If either missing: log warning (non-fatal, per ensure-auth.sh behavior)
- **Action handler — Step 2: Configure git credential helper**
  - If `GH_TOKEN` available: set `git config --global credential.helper store`, write `https://<username|git>:<token>@github.com` to `~/.git-credentials` with `mode 0o600` using `fs.writeFileSync`
  - If `GH_TOKEN` not available: log warning
- **Action handler — Step 3: Configure gh CLI auth**
  - If `GH_TOKEN` available: check `gh auth status` via `execSafe`; if not OK, pipe token to `gh auth login --with-token` via `execSync` with stdin
  - If `GH_TOKEN` not available: check and log `gh auth status`
- **Action handler — Step 4: Verify authentication**
  - Run `gh auth status`; if fails, `process.exit(1)`
  - Log final success message

---

## Phase 3: `setup workspace` Command

### T005 [US2] Implement `setup workspace` subcommand
**File**: `packages/generacy/src/cli/commands/setup/workspace.ts`
- Define `WorkspaceConfig` interface: `repos: string[]`, `branch: string`, `workdir: string`, `clean: boolean`, `githubOrg: string`
- Define `DEFAULT_REPOS` constant array: `['tetrad-development', 'contracts', 'latency', 'agency', 'generacy', 'humancy', 'generacy-cloud', 'humancy-cloud']`
- Implement `resolveWorkspaceConfig(cliArgs)` — three-tier merge with env vars: `REPOS` (comma-separated → array), `REPO_BRANCH`/`DEFAULT_BRANCH`, `CLEAN_REPOS`, `GITHUB_ORG`
- Implement `detectPackageManager(repoPath): 'pnpm' | 'npm'` helper — returns `'pnpm'` if `pnpm-lock.yaml` exists in path
- Export `setupWorkspaceCommand(): Command` factory function
- Register options: `--repos <repos>`, `--branch <branch>`, `--workdir <dir>`, `--clean`
- **Action handler — Step 1: Setup**
  - `mkdirSync(workdir, { recursive: true })`
  - `git config --global --add safe.directory '*'` (wildcard for dev container)
- **Action handler — Step 2: Ensure git credentials**
  - Check if `~/.git-credentials` exists or `gh auth status` succeeds
  - If not configured and `GH_TOKEN` available: run auth setup logic inline
  - Run `gh auth setup-git` if gh is authenticated
- **Action handler — Step 3: Clone/update repos**
  - Process `tetrad-development` first (explicit ordering from original script)
  - For each repo: if `.git` exists → update flow (clean if `--clean`, fetch, checkout branch, pull); if not → clone flow with branch fallback
  - Track success/failure counts
- **Action handler — Step 4: Install dependencies**
  - For each successfully cloned/updated repo with `package.json`: detect package manager, run install, continue on failure
- **Action handler — Step 5: Report summary**
  - Log success/failure counts; exit code 1 if any failures

---

## Phase 4: `setup build` Command

### T006 [US3] Implement `setup build` subcommand
**File**: `packages/generacy/src/cli/commands/setup/build.ts`
- Define `BuildConfig` interface: `skipCleanup`, `skipAgency`, `skipGeneracy`, `agencyDir`, `generacyDir`, `latencyDir`
- Implement `resolveBuildConfig(cliArgs)` — defaults point to `/workspaces/<name>` directories
- Export `setupBuildCommand(): Command` factory function
- Register options: `--skip-cleanup`, `--skip-agency`, `--skip-generacy`
- **Phase 1: Clean stale Claude plugin state** (unless `--skip-cleanup`)
  - Use Node.js `fs` (no Python dependency):
    - `rm -rf` equivalent via `fs.rmSync` for: `~/.claude/plugins/cache/painworth-marketplace/`, `~/.claude/plugins/marketplaces/painworth-marketplace/`
    - Write `{"version":2,"plugins":{}}` to `~/.claude/plugins/installed_plugins.json`
    - Remove `~/.claude/plugins/known_marketplaces.json`, `~/.claude/plugins/install-counts-cache.json`
    - Read `~/.claude/settings.json`, parse JSON, delete `enabledPlugins` key, write back
  - All operations wrapped in try/catch — log warnings, never throw
- **Phase 2: Build Agency packages** (unless `--skip-agency`)
  - Check `/workspaces/agency` exists; skip if not
  - Build latency first: `pnpm install --no-frozen-lockfile && pnpm build` in `/workspaces/latency`
  - Install + build agency: `pnpm install --no-frozen-lockfile && pnpm build` in `/workspaces/agency`
  - Create `.agency/config.json` if not exists (with `pluginPaths`, `defaultMode`, `modes`)
  - Verify artifacts exist: `packages/agency/dist/cli.js`, `packages/agency-plugin-spec-kit/dist/index.js` — hard error (exit 1) if missing
- **Phase 3: Build Generacy packages** (unless `--skip-generacy`)
  - Check `/workspaces/generacy` exists; skip if not
  - Install deps: `pnpm install --filter "!@generacy-ai/generacy-plugin-claude-code"` (hardcoded exclusion)
  - Build: `pnpm build`
  - Link globally: `npm link` in `packages/generacy`
  - Verify artifact: `packages/generacy/dist/cli/index.js`

---

## Phase 5: `setup services` Command

### T007 [US4] Implement `setup services` subcommand
**File**: `packages/generacy/src/cli/commands/setup/services.ts`
- Define `ServicesConfig` interface: `only: 'all' | 'generacy' | 'humancy'`, `skipApi: boolean`, `timeout: number`, `logDir: string`
- Define `SERVICES` constant with port allocations and directory paths for generacy and humancy
- Implement `resolveServicesConfig(cliArgs)` — defaults: `only: 'all'`, `skipApi: false`, `timeout: 60`, `logDir: '/tmp/cloud-services'`
- Implement `waitForPort(port, name, timeoutSec): Promise<boolean>` helper using `net.Socket` — retry loop with 1s intervals
- Export `setupServicesCommand(): Command` factory function
- Register options: `--only <target>`, `--skip-api`, `--timeout <seconds>`
- **Action handler — Step 1: Setup**
  - Create log directory `mkdirSync(logDir, { recursive: true })`
  - Truncate existing log files
  - Determine enabled services from `--only` filter
- **Action handler — Step 2: Ensure deps & build per service**
  - For each enabled service: check `node_modules` count ≥ 10, run `pnpm install` if needed
  - Check `services/api/dist` directory; run `pnpm run build` if missing
- **Action handler — Step 3: Start emulators**
  - For each enabled service: `spawnBackground('firebase', ['emulators:start'], { cwd, detached: true })`
  - Pipe stdout/stderr to per-service log files (e.g., `/tmp/cloud-services/generacy-emulator.log`)
  - Call `child.unref()` for fire-and-forget
- **Action handler — Step 4: Start API servers** (unless `--skip-api`)
  - For each enabled service: spawn `npx tsx watch src/index.ts` in `services/api/` with per-process env vars:
    - `FIRESTORE_EMULATOR_HOST=127.0.0.1:<firestore_port>`
    - `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:<auth_port>`
    - `FIREBASE_PROJECT_ID=<project_id>`
    - `PORT=<api_port>`
    - Stripe env vars passed through with fallback placeholders
  - Pipe to log files, `child.unref()`
- **Action handler — Step 5: Health checks**
  - Wait for all emulator ports, then API ports using `waitForPort`
  - Log success/failure for each; warn on timeout (non-fatal per existing script behavior)
- **Action handler — Step 6: Graceful shutdown**
  - Track all spawned child PIDs in array
  - Register SIGTERM/SIGINT handler: send SIGTERM to all children, after 5s send SIGKILL
  - Handler protects during startup+health-check window

---

## Phase 6: Unit Tests

### T008 [P] [US5] Write exec utility tests
**File**: `packages/generacy/src/__tests__/setup/exec.test.ts`
- Mock `child_process.execSync` and `child_process.spawn`
- Test `exec()` returns trimmed stdout for successful commands
- Test `exec()` throws on non-zero exit code
- Test `exec()` passes `cwd`, `env`, `timeout` options correctly
- Test `execSafe()` returns `{ ok: true, stdout, stderr }` on success
- Test `execSafe()` returns `{ ok: false, stdout: '', stderr }` on failure without throwing
- Test `spawnBackground()` returns a ChildProcess and calls spawn with correct args
- Test logger debug/error calls on exec/failure

### T009 [P] [US1] Write auth command tests
**File**: `packages/generacy/src/__tests__/setup/auth.test.ts`
- Mock `child_process.execSync`, `fs.writeFileSync`, `fs.mkdirSync`
- Test config resolution: CLI args override env vars
- Test config resolution: env vars used when no CLI args
- Test git identity: `git config --global user.name` / `user.email` called with correct values
- Test warning logged when email or username missing
- Test credential file: written to `~/.git-credentials` with correct content and `mode 0o600`
- Test credential file: skipped when `GH_TOKEN` not set
- Test gh auth: skips login if `gh auth status` already succeeds
- Test gh auth: pipes token to `gh auth login --with-token` when not authenticated
- Test exit code 1 when final `gh auth status` verification fails

### T010 [P] [US2] Write workspace command tests
**File**: `packages/generacy/src/__tests__/setup/workspace.test.ts`
- Mock `child_process.execSync`, `fs.existsSync`, `fs.mkdirSync`, `fs.readdirSync`
- Test config resolution: default 8 repos, env var `REPOS` override (comma-separated → array), CLI override
- Test config resolution: `REPO_BRANCH` and `DEFAULT_BRANCH` env var precedence
- Test `CLEAN_REPOS` env var parsed as boolean
- Test `tetrad-development` always processed first regardless of repos list order
- Test clone path: `git clone --branch` called for non-existing repos
- Test update path: `git fetch && git pull` called for existing repos (`.git` dir present)
- Test `--clean` flag: `git reset --hard HEAD && git clean -fd` called before update
- Test branch fallback: retry clone without `--branch` flag when first attempt fails
- Test `detectPackageManager`: returns `'pnpm'` when `pnpm-lock.yaml` exists, `'npm'` otherwise
- Test dependency install: correct package manager command called per repo
- Test summary: failure count > 0 triggers exit code 1

### T011 [P] [US3] Write build command tests
**File**: `packages/generacy/src/__tests__/setup/build.test.ts`
- Mock `child_process.execSync`, `fs.rmSync`, `fs.writeFileSync`, `fs.readFileSync`, `fs.existsSync`, `fs.mkdirSync`
- Test `--skip-cleanup` skips Phase 1 entirely
- Test `--skip-agency` skips Phase 2 entirely
- Test `--skip-generacy` skips Phase 3 entirely
- Test Phase 1: all Claude plugin directories removed via `fs.rmSync`
- Test Phase 1: `installed_plugins.json` reset to `{"version":2,"plugins":{}}`
- Test Phase 1: `enabledPlugins` removed from `settings.json` while preserving other keys
- Test Phase 1: cleanup errors logged as warnings, not thrown
- Test Phase 2: latency built before agency (verify `execSync` call order)
- Test Phase 2: `.agency/config.json` created only when not existing
- Test Phase 2: missing `packages/agency/dist/cli.js` causes exit code 1
- Test Phase 2: missing `packages/agency-plugin-spec-kit/dist/index.js` causes exit code 1
- Test Phase 3: `pnpm install` called with `--filter "!@generacy-ai/generacy-plugin-claude-code"`
- Test Phase 3: `npm link` called in `packages/generacy` directory
- Test Phase 3: missing `packages/generacy/dist/cli/index.js` causes exit code 1

### T012 [P] [US4] Write services command tests
**File**: `packages/generacy/src/__tests__/setup/services.test.ts`
- Mock `child_process.spawn`, `fs.mkdirSync`, `fs.createWriteStream`, `net.Socket`
- Test `--only generacy` spawns only generacy emulator + API
- Test `--only humancy` spawns only humancy emulator + API
- Test `--only all` (default) spawns both service sets
- Test `--skip-api` skips API server spawns (emulators only)
- Test emulator spawn: `firebase emulators:start` called with correct `cwd` per service
- Test API spawn: correct per-process env vars set (different `FIRESTORE_EMULATOR_HOST` for generacy vs humancy)
- Test Stripe env vars passed through with fallback placeholders
- Test log directory created with `mkdirSync({ recursive: true })`
- Test health check: `waitForPort` returns `true` when socket connects
- Test health check: `waitForPort` returns `false` after timeout expires
- Test graceful shutdown: SIGTERM sent to all children on process SIGINT
- Test graceful shutdown: SIGKILL sent after 5s timeout

---

## Phase 7: Integration & Verification

### T013 [US5] Update existing CLI integration tests
**File**: `packages/generacy/src/__tests__/cli.test.ts`
- Add test: `setup` command is registered in the program
- Add test: `setup` command has 4 subcommands (`auth`, `workspace`, `build`, `services`)
- Verify `createProgram().commands.map(c => c.name())` includes `'setup'`

### T014 [US5] Build verification
**Files**:
- All new source files in `packages/generacy/src/cli/`
- Run `pnpm build` in `packages/generacy` — ensure zero TypeScript compilation errors
- Run `pnpm test` in `packages/generacy` — ensure all tests pass (existing + new)
- Verify ESM import paths all use `.js` extensions
- Verify no circular dependencies introduced

### T015 [US5] CLI help output verification
- Verify `generacy setup --help` shows description and all 4 subcommands
- Verify `generacy setup auth --help` shows `--email` and `--username` options
- Verify `generacy setup workspace --help` shows `--repos`, `--branch`, `--workdir`, `--clean` options
- Verify `generacy setup build --help` shows `--skip-cleanup`, `--skip-agency`, `--skip-generacy` options
- Verify `generacy setup services --help` shows `--only`, `--skip-api`, `--timeout` options

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (T001–T003) must complete before Phases 2–5
- T001 (`exec.ts`) is required by T004–T007 (all subcommands use `exec`/`execSafe`/`spawnBackground`)
- T002 (`setup.ts` parent) depends on T004–T007 (imports subcommand factories), but can use stub exports initially
- T003 (`index.ts` registration) depends on T002

**Phases 2–5 are independent of each other**:
- T004 (auth), T005 (workspace), T006 (build), T007 (services) can all be implemented in parallel once Phase 1 is complete
- Note: `workspace` internally calls auth logic, but this is inline code, not an import dependency

**Phase 6 tests are independent of each other but depend on their implementation**:
- T008 depends on T001
- T009 depends on T004
- T010 depends on T005
- T011 depends on T006
- T012 depends on T007
- All T008–T012 can run in parallel with each other

**Phase 7 depends on all prior phases**:
- T013 depends on T002 + T004–T007
- T014 depends on all implementation + test tasks
- T015 depends on T014 (build must succeed first)

**Parallel opportunities within phases**:
- Phase 1: T002 and T003 can start in parallel (different files), but T003 depends on T002's export
- Phases 2–5: T004, T005, T006, T007 are fully parallelizable
- Phase 6: T008, T009, T010, T011, T012 are fully parallelizable

**Critical path**:
```
T001 → T004 (or T005/T006/T007) → T009 (or corresponding test) → T013 → T014 → T015
```

**Shortest path with maximum parallelism**:
```
T001 ──→ T004 ──→ T009 ──┐
     ├─→ T005 ──→ T010 ──┤
     ├─→ T006 ──→ T011 ──├──→ T013 → T014 → T015
     ├─→ T007 ──→ T012 ──┤
     └─→ T002 → T003 ────┘
              └─→ T008 ──┘
```
