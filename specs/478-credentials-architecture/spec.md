# Feature Specification: ## Credentials Architecture — Integration Gap Fix (Phase 6)

**Context:** Part of the [credentials architecture plan](https://github

**Branch**: `478-credentials-architecture` | **Date**: 2026-04-15 | **Status**: Draft

## Summary

## Credentials Architecture — Integration Gap Fix (Phase 6)

**Context:** Part of the [credentials architecture plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md). This closes the integration gap between #459 (role field added to config schema), #465 (credentials interceptor in AgentLauncher), and the orchestrator callers that build `LaunchRequest`.

**Blocks:** End-to-end testing of the credentials architecture. Even with the daemon running, workflows launch without credentials today because no caller populates the `credentials` field.

**Related:** #459, #465

## Problem

The credentials interceptor in [packages/orchestrator/src/launcher/credentials-interceptor.ts](packages/orchestrator/src/launcher/credentials-interceptor.ts) exists and is fully functional. But nothing ever triggers it:

1. **`createAgentLauncher()` doesn't instantiate a `CredhelperClient`** — [packages/orchestrator/src/launcher/launcher-setup.ts](packages/orchestrator/src/launcher/launcher-setup.ts) creates the launcher without wiring a credhelper client, so `AgentLauncher.launch()` always has `credhelperClient === undefined`. Even if a caller did set `request.credentials`, the interceptor would be skipped.

2. **No caller reads `config.defaults.role`** — the field was added to `DefaultsConfigSchema` in #459, but no code in the orchestrator reads it. [packages/orchestrator/src/worker/cli-spawner.ts](packages/orchestrator/src/worker/cli-spawner.ts), [pr-feedback-handler.ts](packages/orchestrator/src/worker/pr-feedback-handler.ts), and [conversation-spawner.ts](packages/orchestrator/src/conversation/conversation-spawner.ts) all build `LaunchRequest` objects without ever including `credentials`.

3. **No uid/gid source** — even if a role were configured, the callers don't know what uid/gid to use. The architecture plan specifies uid 1001 (generacy-workflow) and gid 1000 (node group), but these aren't currently wired into any env var or config.

## What needs to be done

### 1. Wire `CredhelperClient` in `createAgentLauncher()`

[packages/orchestrator/src/launcher/launcher-setup.ts](packages/orchestrator/src/launcher/launcher-setup.ts) — conditionally instantiate a client when the control socket exists:

```typescript
import { CredhelperHttpClient } from './credhelper-client.js';

export function createAgentLauncher(deps: AgentLauncherDeps): AgentLauncher {
  const socketPath = process.env.GENERACY_CREDHELPER_SOCKET
    ?? '/run/generacy-credhelper/control.sock';

  // Only wire the client if the socket is actually reachable.
  const credhelperClient = existsSync(socketPath)
    ? new CredhelperHttpClient({ socketPath })
    : undefined;

  return new AgentLauncher({ ...deps, credhelperClient });
}
```

When the socket doesn't exist (no credhelper running), the launcher operates in legacy mode — matches the "backwards compatible — workflows without credentials continue to work" guarantee from the plan.

### 2. Read `defaults.role` from `.generacy/config.yaml`

Thread the generacy config through to each `LaunchRequest` build site. The config is already loaded by the orchestrator at startup (via `@generacy-ai/config`'s `loadConfig()`); it just needs to be passed to the spawn layer.

For each spawn site that represents a workflow step (phase, pr-feedback, conversation-turn), if `config.defaults.role` is set, populate `LaunchRequest.credentials`:

```typescript
const credentials = config.defaults?.role
  ? {
      role: config.defaults.role,
      uid: Number(process.env.GENERACY_WORKFLOW_UID ?? 1001),
      gid: Number(process.env.GENERACY_WORKFLOW_GID ?? 1000),
    }
  : undefined;

await agentLauncher.launch({
  pluginId: 'claude-code',
  intent: { kind: 'phase', phase, sessionId },
  params,
  cwd,
  env,
  signal,
  credentials,  // populated from config
});
```

### 3. Callers to update

- [packages/orchestrator/src/worker/cli-spawner.ts:54](packages/orchestrator/src/worker/cli-spawner.ts#L54) (`spawnPhase`)
- [packages/orchestrator/src/worker/cli-spawner.ts:89](packages/orchestrator/src/worker/cli-spawner.ts#L89) (`runValidatePhase`)
- [packages/orchestrator/src/worker/cli-spawner.ts:118](packages/orchestrator/src/worker/cli-spawner.ts#L118) (`runPreValidateInstall`)
- [packages/orchestrator/src/worker/pr-feedback-handler.ts:301](packages/orchestrator/src/worker/pr-feedback-handler.ts#L301) (PR feedback)
- [packages/orchestrator/src/conversation/conversation-spawner.ts:53](packages/orchestrator/src/conversation/conversation-spawner.ts#L53) (conversation turn)
- Generic subprocess paths ([packages/generacy/src/agency/subprocess.ts:105](packages/generacy/src/agency/subprocess.ts#L105), [packages/workflow-engine/src/actions/cli-utils.ts:123](packages/workflow-engine/src/actions/cli-utils.ts#L123)) — also populate from config per earlier discussion

All of these need access to the loaded generacy config. Plumb it through the existing dependency injection (most sites already receive the config via their constructor or a factory).

### 4. Uid/gid env vars

Document and use:
- `GENERACY_WORKFLOW_UID` — defaults to 1001 (generacy-workflow)
- `GENERACY_WORKFLOW_GID` — defaults to 1000 (node group)

These are set by the worker container's Dockerfile (from generacy-ai/tetrad-development#59) but the orchestrator reads them to know which uid/gid to pass in the interceptor. Fallback to defaults matches what the Dockerfile creates.

### 5. Tests

- **Unit test**: `createAgentLauncher()` wires a `CredhelperHttpClient` when the socket exists; wires undefined when it doesn't.
- **Unit test**: each caller populates `LaunchRequest.credentials` correctly when `config.defaults.role` is set; omits it when not.
- **Integration test** (optional, can defer): full flow with a mock credhelper daemon — config with role → spawn → session begins → env merged → process launches with uid/gid → session ends on exit.

## Acceptance criteria

- `createAgentLauncher()` instantiates a `CredhelperHttpClient` when the control socket exists
- All workflow-step spawn callers populate `LaunchRequest.credentials` from `config.defaults.role`
- Existing workflows (no `defaults.role` set) continue to work unchanged — `credentials` is `undefined`, interceptor is skipped
- Uid/gid come from env vars with sensible defaults
- Unit tests cover both configured and unconfigured paths

## Phase grouping

- **Integration Phase 6** — parallel with the daemon config loader fix and the generacy-cloud KMS fix
- **Rebuild cluster after all Phase 6 issues land**

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
