# Research: Credentials Integration Gap Fix

## Technology Decisions

### 1. Config Threading: `credentialRole` on WorkerConfig

**Decision**: Add a single `credentialRole?: string` field to `WorkerConfigSchema` rather than threading the full `GeneracyConfig`.

**Rationale**:
- `WorkerConfig` already flows to `ClaudeCliWorker` and `PrFeedbackHandler`
- Only one value needs to cross the boundary (`defaults.role`)
- Avoids coupling spawn sites to `GeneracyConfig` schema details
- Follows existing pattern: `WorkerConfig` carries worker-scoped settings

**Alternatives considered**:
- **Thread full GeneracyConfig**: More flexible, but requires wider constructor changes across 5+ sites. Over-engineers for a single field.
- **Environment variable only**: Would bypass config validation. Role should be validated as part of config loading, not scattered across env reads.

### 2. Fail-fast Strategy at Startup

**Decision**: Throw `CredhelperUnavailableError` at `ClaudeCliWorker` construction when `credentialRole` is set but the control socket doesn't exist.

**Rationale**:
- Setting `defaults.role` is an explicit opt-in to credential isolation
- Silent degradation creates confusing failure modes
- Startup check catches misconfiguration before any workflow runs
- Actionable error message guides the operator to fix

**Alternatives considered**:
- **Per-launch check**: Too late — operator might not notice until a workflow fails mid-execution
- **Warning + fallback**: Silently runs without credentials when the user expected them — security risk
- **Caller checks client availability**: Same outcome as warning, but invisible

### 3. Shared Helper for Building Credentials

**Decision**: Extract a `buildLaunchCredentials(role, env?)` helper used by all 5 spawn sites.

**Rationale**:
- DRY: the same `role + uid/gid` construction logic appears at every spawn site
- Single place to update if credential construction changes
- Keeps spawn sites focused on their own concerns

**Alternatives considered**:
- **Inline at each site**: Duplicates 5–7 lines at each call site. Error-prone if uid/gid defaults change.
- **Middleware in AgentLauncher**: Would require AgentLauncher to know about config — violates its role as a generic plugin-based launcher.

### 4. Uid/Gid Source: Environment Variables with Defaults

**Decision**: Read `GENERACY_WORKFLOW_UID` (default 1001) and `GENERACY_WORKFLOW_GID` (default 1000) from process env.

**Rationale**:
- These are set by the worker container's Dockerfile
- Defaults match what the Dockerfile creates (generacy-workflow user)
- Environment variables allow override without config file changes
- Runtime reads are appropriate since these are deployment-specific, not per-project

**Alternatives considered**:
- **Config file fields**: Uid/gid are container-level settings, not project-level. Config file is the wrong layer.
- **Hardcoded constants**: Would require code changes to override. Env vars are more flexible.

### 5. Two AgentLauncher Instances

**Observation**: `server.ts` creates two `AgentLauncher` instances:
1. One in `ClaudeCliWorker` (for workflow phases, PR feedback)
2. One directly in `createServer()` (for conversations)

**Decision**: Both instances need `CredhelperHttpClient` wired. The client is stateless (just a socket path + timeouts), so two instances are fine.

The conversation launcher path also needs `credentialRole` per clarification Q4: all spawn paths get credentials uniformly.

## Implementation Patterns

### Config Loading Pattern

The orchestrator's `loadFromEnv()` in `config/loader.ts` already reads `.generacy/config.yaml` via `@generacy-ai/config` functions. Adding a `tryLoadDefaultsRole()` follows the same pattern:

```
.generacy/config.yaml
  └─ defaults.role: "developer"
       ├─ tryLoadDefaultsRole(configPath) → "developer"
       └─ orchestrator loadFromEnv() → worker.credentialRole = "developer"
           └─ WorkerConfig.credentialRole = "developer"
               ├─ ClaudeCliWorker.constructor → fail-fast check
               ├─ CliSpawner → credentials on launch
               ├─ PrFeedbackHandler → credentials on launch
               └─ ConversationSpawner → credentials on launch
```

### Socket Existence Check Pattern

```
Startup (ClaudeCliWorker constructor):
  credentialRole set + !existsSync(socket) → throw CredhelperUnavailableError
  credentialRole set + existsSync(socket) → create client, proceed
  credentialRole unset → skip entirely (legacy mode)

Runtime (createAgentLauncher):
  client provided → pass to AgentLauncher
  client not provided → AgentLauncher operates without credentials
```

## Key References

- Credentials architecture plan: `tetrad-development/docs/credentials-architecture-plan.md`
- Existing interceptor: `packages/orchestrator/src/launcher/credentials-interceptor.ts`
- Existing client: `packages/orchestrator/src/launcher/credhelper-client.ts`
- Existing launcher: `packages/orchestrator/src/launcher/agent-launcher.ts`
- Config schema with role: `packages/generacy/src/config/schema.ts` (`DefaultsConfigSchema`)
