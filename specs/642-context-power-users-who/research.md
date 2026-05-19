# Research: `generacy registry-login`

## Technology Decisions

### Docker Config Format

Docker expects `config.json` at `$DOCKER_CONFIG/config.json` with structure:
```json
{
  "auths": {
    "ghcr.io": {
      "auth": "base64(username:password)"
    }
  }
}
```

The `DOCKER_CONFIG` env var points to the **directory** containing `config.json`, not the file itself. This is how Docker CLI, `docker compose pull`, and BuildKit all resolve credentials.

### `DOCKER_CONFIG` Precedence

Docker credential resolution order:
1. `DOCKER_CONFIG` env var (directory path)
2. `~/.docker/config.json`
3. Credential helpers (`credsStore`/`credHelpers` in config)

By setting `DOCKER_CONFIG` on the compose spawn, we override without touching the user's global config.

### Interactive Input: `@clack/prompts`

Already used by `launch/prompts.ts`. Provides:
- `p.text()` — standard text input with validation
- `p.password()` — masked input (no-echo)
- `p.isCancel()` — detect Ctrl+C

### Control-Plane Forwarding

Pattern established by `claude-login`:
```ts
docker compose exec orchestrator curl \
  --unix-socket /run/generacy-control-plane/control.sock \
  -X PUT \
  -H 'Content-Type: application/json' \
  -d '{"type":"docker-registry","value":"{\"username\":\"x\",\"password\":\"y\"}"}' \
  http://localhost/credentials/registry-ghcr.io
```

The credential ID convention is `registry-<host>` (e.g., `registry-ghcr.io`).

## Alternatives Considered

### Transport to Control-Plane

| Option | Pros | Cons |
|--------|------|------|
| `docker compose exec` + curl | Works offline, established pattern, no new port | Requires container running |
| Published port | Direct HTTP from host | Security exposure, compose change |
| Cloud relay | Works with remote clusters | Requires auth, adds latency, not offline |

**Decision**: Option A — `docker compose exec`. Matches `claude-login`, zero new surface area.

### Credential Storage Location

| Option | Pros | Cons |
|--------|------|------|
| `<projectDir>/.generacy/.docker/` | Clean, contained in `.generacy/` | Non-standard Docker path |
| `<projectDir>/.docker/` | Standard-ish | Pollutes project root |
| `.env` file with `DOCKER_CONFIG` | Auto-sourced by tools | Only works with compose, fragile |

**Decision**: `<projectDir>/.generacy/.docker/config.json`. Clean, contained, auto-detected by `compose.ts`.

### `execSafe` vs `spawn` for Docker Compose Exec

`execSafe` (sync) is sufficient since:
- The curl command is short-lived
- No streaming output needed
- Error handling is simpler (return `ExecResult`)

## Implementation Patterns

### Atomic File Writes

Follow existing `file-store.ts` pattern:
```ts
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
const tmpPath = configPath + '.tmp';
writeFileSync(tmpPath, JSON.stringify(config, null, 2));
renameSync(tmpPath, configPath);
```

### Cluster Running Detection

Check via `docker compose ps --format json`:
```ts
const result = runCompose(ctx, ['ps', '--format', 'json']);
if (result.ok && result.stdout.trim()) { /* running */ }
```

## Key Sources

- Docker config spec: `moby/moby` source (docker/config/configfile)
- `DOCKER_CONFIG` behavior: Docker docs "Environment variables"
- Existing patterns: `packages/generacy/src/cli/commands/claude-login/index.ts`
- Compose helper: `packages/generacy/src/cli/commands/cluster/compose.ts`
- Prompts: `packages/generacy/src/cli/commands/launch/prompts.ts`
