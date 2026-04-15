# Quickstart: Credentials Integration Gap Fix

## Prerequisites

- Credhelper daemon built and available (`packages/credhelper-daemon`)
- `.generacy/config.yaml` with `defaults.role` configured
- Worker container with `generacy-workflow` user (uid 1001, gid 1000)

## Configuration

### Enable credentials in `.generacy/config.yaml`

```yaml
defaults:
  role: developer
```

### Environment variables (optional overrides)

```bash
# Override the default credhelper socket path
export GENERACY_CREDHELPER_SOCKET=/custom/path/control.sock

# Override workflow uid/gid (defaults match Dockerfile)
export GENERACY_WORKFLOW_UID=1001
export GENERACY_WORKFLOW_GID=1000

# Override role via env var (takes precedence over config file)
export GENERACY_CREDENTIAL_ROLE=developer
```

## Verification

### 1. Check credhelper daemon is running

```bash
ls -la /run/generacy-credhelper/control.sock
# Should show the Unix socket file
```

### 2. Start the orchestrator

```bash
pnpm dev
```

If `defaults.role` is set but the daemon socket doesn't exist, the orchestrator will fail at startup with:

```
CredhelperUnavailableError: defaults.role is set to 'developer' in .generacy/config.yaml,
  but the credhelper daemon is not reachable at /run/generacy-credhelper/control.sock.

  To fix:
    - Run 'stack credhelper start' to start the daemon, or
    - Remove 'defaults.role' from .generacy/config.yaml to disable credentials.
```

### 3. Run a workflow

Trigger a workflow (e.g., label an issue). The orchestrator logs should show:
- `CredhelperHttpClient` created at startup
- Session begun for each spawned process
- Session ended on process exit

### Legacy mode (no credentials)

If `defaults.role` is not set, everything works exactly as before:
- No `CredhelperClient` is instantiated
- No `credentials` field on `LaunchRequest`
- Credentials interceptor is skipped
- No daemon required

## Running Tests

```bash
# Run all orchestrator tests
cd packages/orchestrator
pnpm test

# Run specific test files
pnpm test -- src/launcher/__tests__/launcher-setup.test.ts
pnpm test -- src/worker/__tests__/cli-spawner.test.ts
pnpm test -- src/worker/__tests__/pr-feedback-handler.test.ts
pnpm test -- src/conversation/__tests__/conversation-spawner.test.ts
pnpm test -- src/worker/__tests__/claude-cli-worker.test.ts
```

## Known Limitations

- **Partial coverage**: Subprocesses spawned via `cli-utils.ts` (e.g., `git push`) and MCP servers via `subprocess.ts` do not inherit credentials in this phase. Follow-up issue required.
- **Single role**: All spawn paths use the same `defaults.role`. Per-path role selection is not supported yet.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `CredhelperUnavailableError` at startup | Role configured, daemon not running | Start daemon or remove `defaults.role` |
| Workflows run without credentials | `defaults.role` not set in config | Add `defaults.role` to `.generacy/config.yaml` |
| Wrong uid/gid on spawned processes | Env var override incorrect | Check `GENERACY_WORKFLOW_UID` / `GENERACY_WORKFLOW_GID` |
| Credentials work for phases but not git push | Generic launcher paths not yet wired | Expected — deferred to follow-up |
