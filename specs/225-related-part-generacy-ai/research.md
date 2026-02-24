# Research: Bash Script → TypeScript CLI Mapping

## Script-to-Command Mapping

| Bash Script | CLI Command | Key Differences |
|-------------|-------------|-----------------|
| `ensure-auth.sh` | `generacy setup auth` | Structured logging replaces colored echo; exit code on failure |
| `setup-repos.sh` | `generacy setup workspace` | Package manager auto-detection; config resolution pattern |
| `setup-plugins.sh` | `generacy setup build` | Node.js JSON manipulation replaces Python3; hard error on missing artifacts |
| `setup-cloud-services.sh` | `generacy setup services` | `net.Socket` replaces `nc -z`; per-process env via `spawn` options |

## Detailed Script Analysis

### ensure-auth.sh → setup auth

**Operations preserved**:
1. `git config --global user.name` / `user.email` from env vars
2. `git config --global credential.helper store`
3. Write `~/.git-credentials` with `https://<user>:<token>@github.com`
4. `chmod 600 ~/.git-credentials`
5. `gh auth status` check → `gh auth login --with-token` fallback
6. Final `gh auth status` verification

**Behavior changes**:
- Colored echo (`\033[1;33m`) → Pino structured logging
- Silent continuation → explicit warning logs for missing env vars
- No exit code → exits non-zero when auth cannot be verified

### setup-repos.sh → setup workspace

**Operations preserved**:
1. `git config --global --add safe.directory '*'`
2. `gh auth setup-git` (from setup_git_credentials function)
3. `tetrad-development` cloned first
4. Clone-or-update logic with branch switching
5. `git reset --hard && git clean -fd` when `CLEAN_REPOS=true`
6. Branch fallback: try `--branch develop`, then no-branch clone
7. Dependency installation per repo (`pnpm install || npm install`)
8. Failure summary

**Behavior changes**:
- `pnpm install 2>/dev/null || npm install 2>/dev/null` → explicit lockfile detection (`pnpm-lock.yaml` → pnpm, else npm)
- bash `IFS=',' read -ra` → TypeScript `string.split(',').filter(Boolean)`
- Exit code on failures (original script always exits 0)

### setup-plugins.sh → setup build

**Operations preserved (Phase 1 — cleanup)**:
1. Remove `~/.claude/plugins/cache/painworth-marketplace/`
2. Remove `~/.claude/plugins/marketplaces/painworth-marketplace/`
3. Reset `~/.claude/plugins/installed_plugins.json` to `{"version":2,"plugins":{}}`
4. Remove `~/.claude/plugins/known_marketplaces.json`
5. Remove `~/.claude/plugins/install-counts-cache.json`
6. Remove `enabledPlugins` from `~/.claude/settings.json`

**Operations preserved (Phase 2 — Agency)**:
1. Build latency first: `cd /workspaces/latency && pnpm install && pnpm build`
2. `cd /workspaces/agency && pnpm install && pnpm build`
3. Create `.agency/config.json` if missing
4. Verify `packages/agency/dist/cli.js`
5. Verify `packages/agency-plugin-spec-kit/dist/index.js`

**Operations preserved (Phase 3 — Generacy)**:
1. `pnpm install --filter "!@generacy-ai/generacy-plugin-claude-code"`
2. `pnpm build`
3. `cd packages/generacy && npm link`

**Behavior changes**:
- Python3 JSON manipulation → Node.js `JSON.parse/stringify` (Q4-A)
- `pnpm install --no-frozen-lockfile` fallback removed (initial attempt should work)
- Missing artifacts → hard error exit (original script warns and continues)

### setup-cloud-services.sh → setup services

**Operations preserved**:
1. `mkdir -p /tmp/cloud-services`
2. `ensure_deps` (check node_modules, install if needed)
3. `build_if_needed` (check dist/, build if missing)
4. `firebase emulators:start` backgrounded per project
5. API servers with per-process env vars:
   - `FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`
   - `FIREBASE_PROJECT_ID`, `PORT`
   - `STRIPE_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
6. `npx tsx watch src/index.ts` for API servers
7. Wait for ports with timeout

**Behavior changes**:
- `nc -z` → `net.Socket.connect()` (Q7-A)
- `&` (bash background) → `spawn` with `detached: true` + `unref()` (Q8-C)
- Log file overwrite on restart (Q15-A)
- Configurable `--timeout` (default 60s vs mixed 30s/60s in script)
- `--only` and `--skip-api` flags for selective startup

## Existing CLI Patterns Reference

### Command Factory Pattern
```
export function fooCommand(): Command {
  const command = new Command('foo');
  command
    .description('...')
    .option(...)
    .action(async (options) => {
      const logger = getLogger();
      // implementation
    });
  return command;
}
```

### Graceful Shutdown Pattern (from orchestrator.ts)
```
let isShuttingDown = false;
const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'Shutting down...');
  // cleanup
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

### Env Var Fallback Pattern (from orchestrator.ts)
```
const redisUrl = (options['redisUrl'] as string | undefined) ?? process.env['REDIS_URL'];
```

### Test Pattern (from cli.test.ts)
```
describe('Config Resolution', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = { ...originalEnv }; });
  afterEach(() => { process.env = originalEnv; });
  // tests
});
```
