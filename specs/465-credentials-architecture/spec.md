# Feature Specification: AgentLauncher Credentials Interceptor (Phase 3)

**Branch**: `465-credentials-architecture` | **Date**: 2026-04-13 | **Status**: Draft

## Summary

Wire the credhelper daemon into the orchestrator's spawn path by adding a `credentials` field to `LaunchRequest` and implementing a credentials interceptor in `AgentLauncher`. When credentials are configured, the interceptor manages credhelper sessions around each workflow subprocess — beginning a session before spawn, merging session environment variables, setting uid/gid, and ending the session on exit. When credentials are absent, behavior is unchanged.

**Context:** Part of the [credentials architecture plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md). Phase 3 of the credentials architecture, parallel with #463 and #464.

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

### US1: Orchestrator Spawns Agents with Scoped Credentials

**As a** platform operator,
**I want** the orchestrator to automatically provision credhelper sessions for spawned agent subprocesses,
**So that** each workflow step runs with scoped, short-lived credentials instead of ambient host credentials.

**Acceptance Criteria**:
- [ ] `LaunchRequest` accepts an optional `credentials` field with `role`, `uid`, and `gid`
- [ ] When credentials are set, a credhelper session is begun before spawn and ended on exit
- [ ] Session environment variables (`GENERACY_SESSION_DIR`, `GIT_CONFIG_GLOBAL`, `GOOGLE_APPLICATION_CREDENTIALS`, `DOCKER_HOST`) are merged into the spawn env
- [ ] The subprocess runs under the specified uid/gid

### US2: Backwards-Compatible Launches Without Credentials

**As a** developer running workflows locally or in environments without credhelper,
**I want** the launcher to work exactly as before when no credentials are configured,
**So that** existing workflows are unaffected by the credentials feature.

**Acceptance Criteria**:
- [ ] When `request.credentials` is absent, the interceptor is a no-op
- [ ] No credhelper connection is attempted
- [ ] Spawn env, command, and uid/gid are unchanged

### US3: Clear Errors When Credhelper Is Unavailable

**As an** operator debugging a failed workflow,
**I want** clear error messages when the credhelper daemon is unreachable or session creation fails,
**So that** I can quickly diagnose and resolve credential issues.

**Acceptance Criteria**:
- [ ] Timeout when credhelper socket is not available produces a descriptive error
- [ ] `beginSession` failure includes the role and session ID in the error message
- [ ] `endSession` failure is logged but does not crash the orchestrator

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add optional `credentials` field to `LaunchRequest` type | P1 | `{ role: string; uid: number; gid: number }` |
| FR-002 | Implement credentials interceptor in `AgentLauncher.launch()` | P1 | Runs after plugin composes command, before `ProcessFactory.spawn()` |
| FR-003 | Implement control socket client (`beginSession`, `endSession`) | P1 | Connects to `/run/generacy-credhelper/control.sock` |
| FR-004 | Merge session env vars into spawn environment | P1 | 4 env vars from session directory |
| FR-005 | Create entrypoint wrapper that sources `$GENERACY_SESSION_DIR/env` | P1 | Shell script or inline `-c` wrapper |
| FR-006 | Set uid/gid on spawn options from `request.credentials` | P1 | Uses spawn refactor Phase 6 options |
| FR-007 | End session on subprocess exit via LaunchHandle process event | P1 | Cleanup even on non-zero exit |
| FR-008 | Read `defaults.role` from `.generacy/config.yaml` to populate credentials | P2 | When role is configured, credentials field is set |
| FR-009 | Handle control socket timeout (credhelper not running) | P1 | Clear error message |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Backwards compatibility | Zero behavior change when credentials absent | Unit test: launch without credentials matches current behavior |
| SC-002 | Session lifecycle | Sessions begun and ended for every credentialed launch | Unit test with mock credhelper socket |
| SC-003 | Error clarity | Credhelper unavailability produces actionable error | Test: connect to non-existent socket, verify error message |
| SC-004 | Integration | Full spawn with credhelper daemon works end-to-end | Integration test with real credhelper from #461 |

## Assumptions

- The credhelper daemon from #461 is available and exposes HTTP-over-Unix-socket at `/run/generacy-credhelper/control.sock`
- The spawn refactor (#423) is complete and `AgentLauncher`, `LaunchRequest`, `ProcessFactory`, and `LaunchHandle` types are stable
- The credhelper daemon handles session expiry for orphaned sessions (orchestrator crash scenario)
- The workflow uid (1001) and gid are known at the time `LaunchRequest` is constructed

## Out of Scope

- Per-step role overrides (schema supports it, no caller sets it yet — future work)
- Orchestrator-side cleanup sweep for orphaned sessions on startup
- Credential rotation during a running session (handled by credhelper daemon internally)
- UI for credential/role management
- Multi-credhelper-daemon topologies

---

*Generated by speckit*
