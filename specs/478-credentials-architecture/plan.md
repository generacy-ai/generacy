# Implementation Plan: Populate LaunchRequest.credentials and Wire CredhelperClient

**Feature**: Close the integration gap between config schema (#459), credentials interceptor (#465), and orchestrator callers
**Branch**: `478-credentials-architecture`
**Status**: Complete

## Summary

The credentials interceptor in `AgentLauncher` is fully functional but never triggered because:
1. `createAgentLauncher()` doesn't instantiate a `CredhelperClient`
2. No caller populates `LaunchRequest.credentials` from `config.defaults.role`
3. No uid/gid source is wired

This plan addresses all three gaps by:
- Adding `credentialRole` to `WorkerConfig` (per clarification Q1: minimal DI approach)
- Conditionally wiring `CredhelperHttpClient` in `createAgentLauncher()` when the socket exists
- Populating `LaunchRequest.credentials` in all 5 orchestrator-internal spawn sites
- Failing fast at startup when role is configured but daemon is unavailable (clarification Q3)

Generic launcher paths (`cli-utils.ts`, `subprocess.ts`) are deferred to a follow-up (clarification Q2).

## Technical Context

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js 20+
- **Build**: pnpm monorepo, Vitest for tests
- **Key packages**: `packages/orchestrator`, `packages/credhelper`, `packages/config`
- **Existing infra**: `CredhelperHttpClient` (HTTP-over-Unix-socket), `applyCredentials()` interceptor, `LaunchRequestCredentials` type

## Project Structure

### Files to modify

```
packages/orchestrator/
├── src/
│   ├── config/
│   │   └── loader.ts                    # Read defaults.role from .generacy/config.yaml
│   ├── launcher/
│   │   └── launcher-setup.ts            # Accept + wire CredhelperClient
│   ├── worker/
│   │   ├── config.ts                    # Add credentialRole to WorkerConfigSchema
│   │   ├── claude-cli-worker.ts         # Pass credentialRole, create client, fail-fast check
│   │   ├── cli-spawner.ts              # Accept config, populate credentials on launch
│   │   └── pr-feedback-handler.ts       # Populate credentials on launch (already has config)
│   ├── conversation/
│   │   └── conversation-spawner.ts      # Accept config, populate credentials on launch
│   └── server.ts                        # Pass credentialRole to conversation path
│
├── src/__tests__/ (or colocated)
│   ├── launcher/
│   │   └── launcher-setup.test.ts       # New: client wiring tests
│   ├── worker/
│   │   ├── cli-spawner.test.ts          # Add credentials population tests
│   │   ├── claude-cli-worker.test.ts    # Add fail-fast startup test
│   │   └── pr-feedback-handler.test.ts  # Add credentials population tests
│   └── conversation/
│       └── conversation-spawner.test.ts # Add credentials population tests

packages/config/
└── src/
    ├── loader.ts                        # Add tryLoadDefaultsRole() helper
    └── index.ts                         # Export new function
```

### Files to create

```
(none — all changes are modifications to existing files)
```

## Implementation Approach

### Phase 1: Config Plumbing (bottom-up)

**Step 1.1: Add `tryLoadDefaultsRole()` to `@generacy-ai/config`**
- New function in `packages/config/src/loader.ts`: reads `.generacy/config.yaml`, extracts `defaults.role` string
- Follows the pattern of existing `tryLoadWorkspaceConfig()` / `tryLoadOrchestratorSettings()`
- Returns `string | null`

**Step 1.2: Add `credentialRole` to `WorkerConfigSchema`**
- Add optional field: `credentialRole: z.string().optional()`
- This flows through existing DI — `WorkerConfig` is already passed to `ClaudeCliWorker`, `PrFeedbackHandler`

**Step 1.3: Read `defaults.role` in orchestrator config loader**
- In `packages/orchestrator/src/config/loader.ts`, call `tryLoadDefaultsRole(configPath)` and set `worker.credentialRole`
- Also support `GENERACY_CREDENTIAL_ROLE` env var override

### Phase 2: Launcher Wiring

**Step 2.1: Update `createAgentLauncher()` signature**
- Add optional `credhelperClient?: CredhelperClient` parameter
- Pass it to `AgentLauncher` constructor (which already accepts it)

```typescript
export function createAgentLauncher(factories: {
  default: ProcessFactory;
  interactive: ProcessFactory;
}, credhelperClient?: CredhelperClient): AgentLauncher {
  const launcher = new AgentLauncher(
    new Map([...]),
    credhelperClient,
  );
  // ...register plugins...
  return launcher;
}
```

**Step 2.2: Instantiate `CredhelperHttpClient` in `ClaudeCliWorker`**
- Check `existsSync(socketPath)` where `socketPath = process.env.GENERACY_CREDHELPER_SOCKET ?? '/run/generacy-credhelper/control.sock'`
- Pass client to `createAgentLauncher()`

**Step 2.3: Fail-fast startup check**
- In `ClaudeCliWorker` constructor: if `config.credentialRole` is set but socket doesn't exist, throw `CredhelperUnavailableError` with actionable message (per clarification Q3)
- This catches misconfiguration at startup, not per-launch

### Phase 3: Credential Population at Spawn Sites

**Step 3.1: Helper function for building credentials**
- Create a shared `buildLaunchCredentials()` helper (in `worker/credentials-helper.ts` or inline):

```typescript
function buildLaunchCredentials(credentialRole: string | undefined): LaunchRequestCredentials | undefined {
  if (!credentialRole) return undefined;
  return {
    role: credentialRole,
    uid: Number(process.env.GENERACY_WORKFLOW_UID ?? 1001),
    gid: Number(process.env.GENERACY_WORKFLOW_GID ?? 1000),
  };
}
```

**Step 3.2: Update `CliSpawner`**
- Add `credentialRole?: string` to constructor (or derive from a passed config)
- In `spawnPhase()`, `runValidatePhase()`, `runPreValidateInstall()`: add `credentials: buildLaunchCredentials(this.credentialRole)` to the launch request

**Step 3.3: Update `PrFeedbackHandler`**
- Already has `config: WorkerConfig` in constructor
- Add `credentials: buildLaunchCredentials(this.config.credentialRole)` to the launch request in `spawnClaudeForFeedback()`

**Step 3.4: Update `ConversationSpawner`**
- Add `credentialRole?: string` to constructor
- Add `credentials: buildLaunchCredentials(this.credentialRole)` to the launch request in `spawnTurn()`

**Step 3.5: Update `server.ts` conversation path**
- Pass `credentialRole` when constructing the conversation `AgentLauncher` + `ConversationSpawner`
- Also wire `CredhelperHttpClient` for the conversation launcher (separate instance from worker)

### Phase 4: Tests

**Step 4.1: `launcher-setup.test.ts`** (new file)
- `createAgentLauncher()` passes client to `AgentLauncher` when provided
- `createAgentLauncher()` passes undefined when no client provided

**Step 4.2: `cli-spawner.test.ts`** (extend existing)
- `spawnPhase()` includes `credentials` when `credentialRole` is set
- `spawnPhase()` omits `credentials` when `credentialRole` is undefined
- Same for `runValidatePhase()`, `runPreValidateInstall()`

**Step 4.3: `pr-feedback-handler.test.ts`** (extend existing)
- Launch request includes `credentials` when `config.credentialRole` is set
- Launch request omits `credentials` when not set

**Step 4.4: `conversation-spawner.test.ts`** (extend existing)
- `spawnTurn()` includes `credentials` when `credentialRole` is set
- `spawnTurn()` omits `credentials` when not set

**Step 4.5: `claude-cli-worker.test.ts`** (extend existing)
- Constructor throws `CredhelperUnavailableError` when `credentialRole` is set but socket doesn't exist
- Constructor succeeds when `credentialRole` is undefined (legacy mode)

## Key Design Decisions

1. **`credentialRole` on `WorkerConfig`** (not threading full `GeneracyConfig`): Minimal DI surface, single string, follows existing config pattern.

2. **Fail-fast at startup** (not per-launch or warning): `defaults.role` is an explicit security opt-in. Silent degradation defeats the security model.

3. **Uniform credential application** (including conversations): All spawn paths get credentials when configured. Different privilege per path is surprising and dangerous.

4. **Deferred generic paths**: `cli-utils.ts` and `subprocess.ts` use a different launcher abstraction. Separate follow-up issue required.

5. **Socket existence check at two levels**: (a) startup — fail-fast if role is set but no daemon; (b) `createAgentLauncher()` — conditionally create client. Both use `existsSync()` on the socket path.

## Backwards Compatibility

- No `defaults.role` set → `credentialRole` is undefined → no `credentials` on `LaunchRequest` → interceptor skipped → identical to today
- No credhelper daemon running + no role configured → no change
- This is purely additive — all new behavior is gated on `config.credentialRole` being set

## Dependencies

- `packages/credhelper` — `LaunchRequestCredentials` type (already exists)
- `packages/orchestrator/src/launcher/credhelper-client.ts` — `CredhelperHttpClient` (already exists)
- `packages/orchestrator/src/launcher/credentials-interceptor.ts` — `applyCredentials()` (already exists)
- `@generacy-ai/config` — config loader (needs minor addition for `defaults.role`)
