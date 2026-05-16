# Implementation Plan: `generacy registry-login` / `registry-logout`

**Feature**: CLI commands for project-scoped private container registry authentication
**Branch**: `642-context-power-users-who`
**Status**: Complete

## Summary

Add two CLI subcommands (`registry-login` and `registry-logout`) that allow power users (Flow C) to authenticate with private container registries without the cloud UI. Credentials are scoped to `<projectDir>/.generacy/.docker/config.json` (never touching `~/.docker/config.json`) and optionally forwarded to the running cluster's control-plane. The `compose.ts` helper is extended to auto-detect scoped Docker config and set `DOCKER_CONFIG` on every compose invocation.

## Technical Context

- **Language**: TypeScript (ESM, Node >= 22)
- **Framework**: Commander.js (CLI), `@clack/prompts` (interactive input)
- **Package**: `packages/generacy` (the main CLI package)
- **Key dependencies**: `commander`, `@clack/prompts`, `zod`, `pino`
- **Existing patterns**: `claude-login` command (docker compose exec pattern), `compose.ts` helper (centralized compose invocations), `cluster-context.ts` (project discovery)

## Project Structure

```
packages/generacy/src/cli/commands/
├── registry-login/
│   ├── index.ts              # Command registration + main flow
│   ├── docker-config.ts      # Read/write scoped Docker config.json
│   ├── credential-forward.ts # Forward to control-plane via docker exec
│   └── __tests__/
│       ├── docker-config.test.ts
│       ├── credential-forward.test.ts
│       └── registry-login.test.ts
├── registry-logout/
│   ├── index.ts              # Command registration + main flow
│   └── __tests__/
│       └── registry-logout.test.ts
├── cluster/
│   └── compose.ts            # MODIFIED: auto-detect DOCKER_CONFIG
```

## Implementation Steps

### 1. Docker Config Helper (`docker-config.ts`)

Pure-function module for manipulating project-scoped Docker config:
- `readDockerConfig(generacyDir)` — reads `<generacyDir>/.docker/config.json`, returns parsed object or empty `{auths: {}}`
- `writeDockerConfig(generacyDir, config)` — atomic write (tmp + rename) to `<generacyDir>/.docker/config.json`, creates `.docker/` dir if missing
- `addAuth(config, host, username, password)` — adds `auths.<host>.auth = base64(username:password)` entry
- `removeAuth(config, host)` — removes `auths.<host>` entry
- `getDockerConfigDir(generacyDir)` — returns `<generacyDir>/.docker` path (for `DOCKER_CONFIG` env var)

### 2. Credential Forward Helper (`credential-forward.ts`)

Forwards registry credential to running cluster's control-plane:
- `forwardCredential(ctx, host, username, password)` — runs `docker compose exec orchestrator curl --unix-socket /run/generacy-control-plane/control.sock -X PUT -H 'Content-Type: application/json' -d '{"type":"docker-registry","value":"{...}"}' http://localhost/credentials/registry-<host>`
- `removeCredential(ctx, host)` — runs `docker compose exec orchestrator curl --unix-socket ... -X DELETE http://localhost/credentials/registry-<host>`
- `isClusterRunning(ctx)` — checks if compose services are up (reuses `runCompose` with `ps --format json`)

### 3. `registry-login` Command (`registry-login/index.ts`)

Commander.js subcommand:
```
generacy registry-login <host>
```
Flow:
1. Resolve cluster context (`getClusterContext()`)
2. Prompt username via `@clack/prompts` `p.text()`
3. Prompt token via `p.password()` (no-echo)
4. Write scoped Docker config via `addAuth()`
5. If cluster running, forward via `forwardCredential()`
6. Print success message

### 4. `registry-logout` Command (`registry-logout/index.ts`)

Commander.js subcommand:
```
generacy registry-logout <host>
```
Flow:
1. Resolve cluster context
2. Remove from scoped Docker config via `removeAuth()`
3. If cluster running, remove via `removeCredential()`
4. Print success message

### 5. Modify `compose.ts` — Auto-detect `DOCKER_CONFIG`

In `runCompose()` (local branch only):
- Before calling `execSafe()`, check if `<ctx.projectRoot>/.generacy/.docker/config.json` exists
- If yes, add `DOCKER_CONFIG=<ctx.projectRoot>/.generacy/.docker` to the spawn env
- Pass env via new `env` option to `execSafe()`

### 6. Register Commands in CLI Index

Add `registryLoginCommand()` and `registryLogoutCommand()` to `src/cli/index.ts`.

### 7. Tests

- **Unit**: `docker-config.test.ts` — write/read/add/remove auth entries, atomic write, never modifies `~/.docker`
- **Unit**: `credential-forward.test.ts` — mock `execSafe`, verify correct curl command structure
- **Unit**: `registry-login.test.ts` — mock prompts + helpers, verify flow
- **Unit**: `registry-logout.test.ts` — mock helpers, verify removal flow
- **Unit**: `compose.test.ts` — verify `DOCKER_CONFIG` auto-detection

## Constitution Check

No `.specify/memory/constitution.md` found — no governance constraints to verify against.

## Key Decisions

1. **Path**: `<projectDir>/.generacy/.docker/config.json` (inside `.generacy/` to keep project root clean)
2. **Transport**: `docker compose exec` + `curl --unix-socket` (follows `claude-login` pattern, works offline)
3. **Credential type**: `docker-registry` (stored in control-plane, no credhelper plugin in v1.6)
4. **Auto-detect**: `compose.ts` checks for scoped config on every invocation (no session env persistence needed)
5. **Atomic writes**: tmp + rename pattern (matches existing `file-store.ts` patterns)
