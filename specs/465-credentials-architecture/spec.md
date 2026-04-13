# Feature Specification: ## Credentials Architecture — Phase 3 (parallel with #463 and #464)

**Context:** Part of the [credentials architecture plan](https://github

**Branch**: `465-credentials-architecture` | **Date**: 2026-04-13 | **Status**: Draft

## Summary

## Credentials Architecture — Phase 3 (parallel with #463 and #464)

**Context:** Part of the [credentials architecture plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md). This wires the credhelper into the orchestrator's spawn path.

**Depends on:** Phase 2 (#461 daemon — provides session API)
**Also depends on:** The spawn refactor (complete — generacy-ai/generacy#423) which established the `AgentLauncher` and `LaunchRequest` types

## What needs to be done

Add a `credentials` field to `LaunchRequest` and implement a credentials interceptor inside `AgentLauncher` that manages credhelper sessions around each workflow subprocess spawn.

### LaunchRequest extension

In `packages/orchestrator/src/launcher/types.ts`, add:

```typescript
interface LaunchRequest {
  // ... existing fields (pluginId, intent, params, cwd, env, signal)

  credentials?: {
    role: string;   // which role to request from credhelper
    uid: number;    // workflow uid (1001)
    gid: number;    // workflow gid (node group)
  };
}
```

### Credentials interceptor in AgentLauncher

Inside `packages/orchestrator/src/launcher/agent-launcher.ts`, add interceptor logic in `launch()` that runs **after** the plugin has composed `{command, args, env}` and **before** `ProcessFactory.spawn()`:

When `request.credentials` is present:

1. **Begin session**: call `credhelper.beginSession(role, sessionId)` over the Unix control socket at `/run/generacy-credhelper/control.sock`
2. **Receive `session_dir`** back from the credhelper
3. **Merge session env** into the spawn env:
   - `GENERACY_SESSION_DIR=<session_dir>`
   - `GIT_CONFIG_GLOBAL=<session_dir>/git/config`
   - `GOOGLE_APPLICATION_CREDENTIALS=<session_dir>/gcp/external-account.json`
   - `DOCKER_HOST=unix://<session_dir>/docker.sock`
4. **Wrap the command** in an entrypoint script that sources `$GENERACY_SESSION_DIR/env` before exec-ing the real command
5. **Set uid/gid** on the `ProcessFactory.spawn()` call via the options added in spawn refactor Phase 6
6. **On subprocess exit** (via LaunchHandle process event): call `credhelper.endSession(sessionId)` to clean up

When `request.credentials` is absent (the default): the interceptor is a **no-op** — the launcher behaves exactly as it does today. This is the backwards-compatibility guarantee.

### Control socket client

Implement a simple client for the credhelper's Unix socket API:
- `beginSession(role: string, sessionId: string): Promise<{ sessionDir: string; expiresAt: Date }>`
- `endSession(sessionId: string): Promise<void>`
- Connect to `/run/generacy-credhelper/control.sock`
- JSON-over-Unix-socket request/response
- Timeout handling (credhelper not running → clear error)

### Role selection

The `credentials.role` value comes from:
1. `.generacy/config.yaml` → `defaults.role` (added in #459)
2. Eventually per-step role override (future — schema supports it but no caller sets it yet)

The orchestrator reads `defaults.role` from config and populates `LaunchRequest.credentials` when a role is configured. When no role is configured, `credentials` is undefined and the interceptor is skipped.

### Entrypoint wrapper

Create a small shell script (or inline script) that:
```bash
#!/bin/sh
. "$GENERACY_SESSION_DIR/env"
exec "$@"
```

This ensures env-exposed credentials are loaded before the agent binary starts.

## Acceptance criteria

- `LaunchRequest.credentials` field exists and is optional
- When credentials are set: session is begun, env is merged, uid/gid are applied, session is ended on exit
- When credentials are absent: zero behavior change from current launcher
- Control socket client handles: credhelper not running (timeout → clear error), session begin failure, session end failure
- Entrypoint wrapper correctly sources env file before exec
- Unit tests: interceptor with mock credhelper socket, no-op when credentials absent
- Integration test: full flow with real credhelper daemon from #461

## Phase grouping

- **Phase 3** — parallel with #463 and #464
- **Rebuild cluster after Phase 3 completes**

## User Stories

### US1: Orchestrator wires credentials into agent subprocess

**As a** platform operator,
**I want** the orchestrator to automatically provision credhelper sessions when launching agent subprocesses,
**So that** each workflow run gets scoped, short-lived credentials without manual configuration.

**Acceptance Criteria**:
- [ ] `LaunchRequest.credentials` optional field is available on launch requests
- [ ] When credentials are set, a credhelper session is begun before spawn and ended on process exit
- [ ] Session env vars (`GENERACY_SESSION_DIR`, `GIT_CONFIG_GLOBAL`, `GOOGLE_APPLICATION_CREDENTIALS`, `DOCKER_HOST`) are merged into spawn env
- [ ] uid/gid from the credentials config are applied to the spawned process
- [ ] Entrypoint wrapper sources `$GENERACY_SESSION_DIR/env` before exec-ing the real command

### US2: Backwards-compatible no-op when credentials are absent

**As a** developer running workflows without credential roles configured,
**I want** the launcher to behave exactly as it does today when `credentials` is undefined,
**So that** existing workflows are unaffected by the credentials interceptor.

**Acceptance Criteria**:
- [ ] When `request.credentials` is absent, the interceptor is a complete no-op
- [ ] No credhelper socket connection is attempted
- [ ] Spawn env, command, and uid/gid are unchanged

### US3: Graceful error handling for credhelper failures

**As a** platform operator,
**I want** clear error messages when the credhelper daemon is unavailable or sessions fail,
**So that** I can diagnose credential issues without digging through logs.

**Acceptance Criteria**:
- [ ] Timeout when credhelper socket is not running produces a clear error
- [ ] Session begin failure is surfaced with actionable context
- [ ] Session end failure on process exit is logged but does not crash the orchestrator

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add optional `credentials` field (`{ role, uid, gid }`) to `LaunchRequest` | P1 | In `packages/orchestrator/src/launcher/types.ts` |
| FR-002 | Implement credentials interceptor in `AgentLauncher.launch()` between plugin compose and `ProcessFactory.spawn()` | P1 | Core interceptor logic |
| FR-003 | Implement control socket client (`beginSession`, `endSession`) over Unix socket | P1 | Connect to `/run/generacy-credhelper/control.sock` |
| FR-004 | Merge session env vars into spawn env when credentials are present | P1 | `GENERACY_SESSION_DIR`, `GIT_CONFIG_GLOBAL`, `GOOGLE_APPLICATION_CREDENTIALS`, `DOCKER_HOST` |
| FR-005 | Create entrypoint wrapper script that sources `$GENERACY_SESSION_DIR/env` before exec | P1 | Shell script or inline |
| FR-006 | Set uid/gid on `ProcessFactory.spawn()` call from `credentials.uid`/`credentials.gid` | P1 | Uses options from spawn refactor Phase 6 |
| FR-007 | Call `endSession` on subprocess exit via LaunchHandle process event | P1 | Cleanup on both normal and abnormal exit |
| FR-008 | Read `defaults.role` from `.generacy/config.yaml` to populate `LaunchRequest.credentials` | P2 | Config integration from #459 |
| FR-009 | Handle credhelper timeout, begin failure, and end failure gracefully | P1 | Clear error messages |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Interceptor no-op correctness | Zero behavior change when credentials absent | Unit tests comparing spawn args with/without credentials |
| SC-002 | Session lifecycle completeness | Every beginSession has a matching endSession | Integration test with real credhelper daemon |
| SC-003 | Error handling coverage | All 3 failure modes (timeout, begin fail, end fail) handled | Unit tests with mock socket |
| SC-004 | Env var injection correctness | All 4 required env vars present in spawn env | Unit test asserting env contents |

## Assumptions

- Phase 2 credhelper daemon (#461) is complete and provides the Unix socket session API
- The spawn refactor (#423) is complete, providing `AgentLauncher`, `LaunchRequest`, `ProcessFactory`, and `LaunchHandle` types
- Config schema from #459 includes `defaults.role` field
- `/run/generacy-credhelper/control.sock` is the agreed-upon socket path
- The credhelper daemon uses JSON-over-Unix-socket request/response protocol

## Out of Scope

- Per-step role overrides (schema supports it, but no caller sets it yet — future work)
- Credential rotation during a running session (handled by credhelper daemon internally)
- Multi-role sessions (one role per subprocess spawn)
- Cluster rebuild after Phase 3 (separate operational step)

---

*Generated by speckit*
