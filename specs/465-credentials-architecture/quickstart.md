# Quickstart: AgentLauncher Credentials Interceptor

## Prerequisites

- credhelper daemon running (#461) with control socket at `/run/generacy-credhelper/control.sock`
- At least one role configured in credhelper config (e.g., `developer`)
- Orchestrator workspace with spawn refactor (#423) complete

## Usage

### Launching with Credentials

Pass `credentials` in the `LaunchRequest`:

```typescript
const handle = await agentLauncher.launch({
  intent: { kind: 'phase', /* ... */ },
  cwd: '/workspace/repo',
  credentials: {
    role: 'developer',   // credhelper role
    uid: 1001,           // workflow user
    gid: 1001,           // workflow group
  },
});

// Process runs with scoped credentials
// Session auto-cleans on exit
await handle.process.exitPromise;
```

### Launching without Credentials (unchanged)

```typescript
const handle = await agentLauncher.launch({
  intent: { kind: 'shell', command: 'echo hello' },
  cwd: '/workspace/repo',
});
// No credhelper interaction — identical to current behavior
```

### AgentLauncher Setup with CredhelperClient

```typescript
import { createCredhelperClient } from './launcher/credhelper-client.js';
import { AgentLauncher } from './launcher/agent-launcher.js';

const credhelperClient = createCredhelperClient({
  socketPath: '/run/generacy-credhelper/control.sock',
  connectTimeout: 5000,
});

const launcher = new AgentLauncher(factories, credhelperClient);
```

## What Happens Under the Hood

When `credentials` is set on a `LaunchRequest`:

1. Session ID generated: `worker-7f2a-wf-42-1713052800-x9k2`
2. `POST /sessions` sent to credhelper daemon → receives `session_dir`
3. Spawn env gets 4 new variables (`GENERACY_SESSION_DIR`, `GIT_CONFIG_GLOBAL`, etc.)
4. Command wrapped: `sh -c '. "$GENERACY_SESSION_DIR/env" && exec "$@"' _ <original-cmd> <args>`
5. Process spawned with `uid`/`gid` from credentials
6. On exit: `DELETE /sessions/:id` sent to daemon (fire-and-forget)

## Error Scenarios

| Scenario | Behavior |
|----------|----------|
| Credentials set, daemon not running | `CredhelperUnavailableError` thrown (hard failure) |
| Credentials set, role not found | `CredhelperSessionError` thrown with role name |
| Credentials absent | No-op — zero behavior change |
| `endSession` fails after exit | Warning logged, no throw (daemon sweeper cleans up) |

## Troubleshooting

### "credhelper not responding at /run/generacy-credhelper/control.sock"

The credhelper daemon is not running. Check:
```bash
ls -la /run/generacy-credhelper/control.sock
# If missing, start the daemon
```

### "Role not found: <role>"

The requested role is not configured in the credhelper config. Verify role exists in `.generacy/credentials/roles/`.

### Subprocess starts but credentials not available

Check that the `env` file exists in the session directory:
```bash
cat /run/generacy-credhelper/sessions/<session-id>/env
```

## Testing

```bash
# Run unit tests
pnpm --filter @generacy-ai/orchestrator test -- --grep "credhelper"

# Run integration tests (requires daemon running)
pnpm --filter @generacy-ai/orchestrator test:integration -- --grep "credentials"
```
