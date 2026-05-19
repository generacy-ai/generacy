# Implementation Plan: AgentLauncher Credentials Interceptor (Phase 3)

**Feature**: Wire credhelper daemon into orchestrator spawn path via credentials interceptor
**Branch**: `465-credentials-architecture`
**Status**: Complete

## Summary

Add a `credentials` field to `LaunchRequest` and implement a credentials interceptor inside `AgentLauncher.launch()` that manages credhelper sessions around each workflow subprocess. When credentials are configured, the interceptor begins a credhelper session, merges session environment variables, wraps the command in an entrypoint that sources the session env, sets uid/gid, and ends the session on subprocess exit. When credentials are absent, behavior is unchanged.

## Technical Context

- **Language**: TypeScript (ESM, Node.js)
- **Framework**: Monorepo with pnpm workspaces
- **Key packages**:
  - `packages/orchestrator` — the launcher lives here
  - `packages/credhelper` — shared types (already has `LaunchRequestCredentials`)
  - `packages/credhelper-daemon` — daemon with HTTP-over-Unix-socket API
- **Test framework**: Vitest
- **Node.js**: Built-in `http` module for Unix socket client (zero dependencies)

## Architecture

The interceptor is implemented as logic within `AgentLauncher.launch()`, not as a separate middleware class. This keeps the architecture simple since the interceptor is a single concern tightly coupled to the spawn path.

```
AgentLauncher.launch(request)
  ↓ [Resolve plugin → buildLaunch() → LaunchSpec]
  ↓ [3-layer env merge]
  ↓ [★ CREDENTIALS INTERCEPTOR (new) ★]
  │   ├─ if request.credentials:
  │   │   ├─ Generate session ID
  │   │   ├─ beginSession(role, sessionId) via control socket
  │   │   ├─ Merge session env vars into spawn env
  │   │   ├─ Wrap command in sh -c entrypoint
  │   │   ├─ Set uid/gid on spawn options
  │   │   └─ Register exit handler → endSession(sessionId)
  │   └─ else: no-op (unchanged behavior)
  ↓ [factory.spawn()]
  ↓ LaunchHandle
```

## Project Structure

### New Files

```
packages/orchestrator/src/launcher/
├── credhelper-client.ts           # HTTP-over-Unix-socket client for credhelper daemon
├── credentials-interceptor.ts     # Interceptor logic (beginSession, env merge, wrap, cleanup)
├── shell-escape.ts                # Shell argument escaping utility
└── __tests__/
    ├── credhelper-client.test.ts
    ├── credentials-interceptor.test.ts
    └── shell-escape.test.ts
```

### Modified Files

```
packages/orchestrator/src/launcher/
├── types.ts            # Add credentials field to LaunchRequest
├── agent-launcher.ts   # Wire interceptor into launch() flow
└── index.ts            # Export new types/modules

packages/orchestrator/package.json  # Add @generacy-ai/credhelper dependency
```

## Design Decisions

### D1: Interceptor as inline logic, not a class hierarchy

The credentials interceptor is a single function called within `launch()`, not a plugin or middleware chain. Rationale: there is only one interceptor, and the spec explicitly places it between plugin output and spawn. A middleware chain would be over-engineering for a single concern.

### D2: launch() becomes async

Currently `launch()` is synchronous. The interceptor needs to call `beginSession()` over HTTP, which is async. `launch()` must become `async launch(): Promise<LaunchHandle>`. All callers (3 sites: `registerProcessLauncher`, `ConversationSpawner`, tests) must be updated.

### D3: Inline sh -c wrapper (from clarification Q1)

Command wrapping uses `sh -c '. "$GENERACY_SESSION_DIR/env" && exec "$@"' _ <command> <args...>` — the positional-parameter approach from the clarification. This avoids shell-escaping issues since the original args pass through as `$@`.

### D4: Session ID generation (from clarification Q3)

Composite key format: `{agentId}-{workflowId}-{timestamp}-{random4}`. The `agentId` comes from `AGENT_ID` env var (falls back to `HOSTNAME`), `workflowId` from request metadata or a default, timestamp as epoch seconds, and a 4-char random hex suffix.

### D5: Hard failure on credhelper unavailability (from clarification Q2)

When `request.credentials` is set but credhelper is unreachable, `launch()` throws `CredhelperUnavailableError`. No graceful degradation — credentials are required if requested.

### D6: Cleanup on exit (from clarification Q5)

`endSession()` is called from the `exitPromise` handler. If the orchestrator crashes, the daemon's 30-second sweeper handles cleanup. `endSession` failures are logged but do not throw.

## Component Details

### 1. CredhelperClient (`credhelper-client.ts`)

Thin HTTP client using Node.js built-in `http` module:

```typescript
interface CredhelperClient {
  beginSession(role: string, sessionId: string): Promise<{ sessionDir: string; expiresAt: Date }>;
  endSession(sessionId: string): Promise<void>;
}
```

- Connects to Unix socket at configurable path (default: `/run/generacy-credhelper/control.sock`)
- `POST /sessions` with `{ role, session_id }` → `{ session_dir, expires_at }`
- `DELETE /sessions/:id` → `{ ok: true }`
- Connection timeout (default: 5s) with descriptive `CredhelperUnavailableError`
- Response timeout (default: 30s) for long-running session setup

### 2. Credentials Interceptor (`credentials-interceptor.ts`)

Pure function that transforms spawn parameters:

```typescript
interface InterceptorInput {
  command: string;
  args: string[];
  env: Record<string, string>;
  credentials: LaunchRequestCredentials;
}

interface InterceptorOutput {
  command: string;       // 'sh'
  args: string[];        // ['-c', '. "$GENERACY_SESSION_DIR/env" && exec "$@"', '_', ...originalArgs]
  env: Record<string, string>;  // merged with session env vars
  uid: number;
  gid: number;
  sessionId: string;     // for cleanup registration
}
```

Session env vars merged:
- `GENERACY_SESSION_DIR=<sessionDir>`
- `GIT_CONFIG_GLOBAL=<sessionDir>/git/config`
- `GOOGLE_APPLICATION_CREDENTIALS=<sessionDir>/gcp/external-account.json`
- `DOCKER_HOST=unix://<sessionDir>/docker.sock`

### 3. Shell Escape (`shell-escape.ts`)

Not needed for the chosen approach — using positional parameters (`"$@"`) avoids shell escaping entirely. The original command and args are passed as separate arguments to `sh -c '...' _`, so the shell never interprets them.

### 4. LaunchRequest Extension (`types.ts`)

```typescript
import type { LaunchRequestCredentials } from '@generacy-ai/credhelper';

interface LaunchRequest {
  // ... existing fields
  credentials?: LaunchRequestCredentials;  // { role, uid, gid }
}
```

### 5. AgentLauncher Changes (`agent-launcher.ts`)

- Accept `CredhelperClient` in constructor (optional — when absent, credentials on a request throw)
- `launch()` becomes `async`
- After env merge, before factory.spawn(): if `request.credentials`, call interceptor
- After spawn: register exit cleanup via `process.exitPromise.then(() => endSession())`
- Return `LaunchHandle` with cleanup metadata

## Testing Strategy

### Unit Tests

1. **credhelper-client.test.ts**: Mock Unix socket HTTP server, test begin/end session, timeout handling, error responses
2. **credentials-interceptor.test.ts**: Test env merge, command wrapping, uid/gid passthrough, session ID generation
3. **agent-launcher.test.ts** (extend existing): Test launch with credentials (mock client), launch without credentials (no-op), client unavailable throws

### Integration Tests

1. **Full lifecycle**: Real credhelper daemon (from `credhelper-daemon` package) + agent launcher → begin session → spawn → exit → end session
2. **Error path**: Credentials requested but no daemon running → descriptive error

## Dependency Graph

```
@generacy-ai/credhelper (types)          ← already exists
    ↑
packages/orchestrator                     ← new dependency on credhelper types
    ├── launcher/types.ts                 ← imports LaunchRequestCredentials
    ├── launcher/credhelper-client.ts     ← HTTP client (node:http only)
    ├── launcher/credentials-interceptor.ts
    └── launcher/agent-launcher.ts        ← wires interceptor
```

## Caller Impact (launch() becoming async)

Three call sites need updating:

1. **`claude-cli-worker.ts`** (line 117): `registerProcessLauncher` callback — must `await` the launch
2. **`conversation-spawner.ts`** (line ~55): Already in async context — just add `await`
3. **Tests**: Update mock/spy expectations for async return

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| `launch()` sync→async breaks callers | Only 3 call sites, all identified above |
| Shell wrapper breaks on edge-case args | Using `"$@"` positional params avoids escaping |
| Credhelper timeout blocks spawn | Configurable timeout, clear error message |
| Session leak on orchestrator crash | Daemon's 30s sweeper handles cleanup |
| uid/gid not supported on platform | ProcessFactory already accepts uid/gid (spawn refactor #423) |
