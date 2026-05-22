# Research: Phase 1 Multi-Repo Workflow Support

## Technology Decisions

### 1. Injection Pattern: Caller-Injection (B) over Self-Discovery (A) or Hybrid (C)

**Decision**: The sibling map is resolved by the orchestrator and passed to the workflow engine via `ExecutionOptions.siblingWorkdirs`.

**Rationale**:
- `workflow-engine` currently has zero dependency on `@generacy-ai/config`. Adding one would create a coupling between the execution layer and the config-loading layer.
- The orchestrator already loads `WorkspaceConfig` at startup in `packages/orchestrator/src/config/loader.ts:110-125` via `findWorkspaceConfigPath()` and `tryLoadWorkspaceConfig()`.
- The hybrid approach (accept optional + self-discovery fallback) adds complexity for no real benefit — the workflow engine is always invoked by the orchestrator.

**Alternatives considered**:
- Self-discovery (A): Workflow engine imports `@generacy-ai/config`, calls `findWorkspaceConfigPath()` internally. Rejected: violates layering.
- Hybrid (C): Accept optional field, fall back to self-discovery. Rejected: unnecessary complexity.

### 2. Primary Repo Identification: Path-Match with Empty Fallback

**Decision**: Compare `realpath(getRepoWorkdir(name, basePath))` against `realpath(workdir)`. If no match, return empty map.

**Rationale**:
- `WorkspaceConfig.repos` is a flat array with no explicit "primary" marker. After `convertTemplateConfig()`, the original primary is just `repos[0]` by convention.
- Basename matching (`basename(workdir) === repo.name`) is fragile — repos could be renamed on disk.
- Empty fallback (not "all as siblings") prevents the primary from being included in downstream fan-out operations, which would corrupt multi-repo PR creation.

### 3. Base Path: Dynamic from `dirname(workdir)`

**Decision**: Derive sibling base path from `path.dirname(path.resolve(workdir))`.

**Rationale**:
- `getRepoWorkdir()` defaults to `/workspaces` which only works in cluster deployments.
- Local development, CI runners, and future hosting layouts use different directory structures.
- The parent of the primary repo's working directory is always the correct peer root.

### 4. Caching Strategy: Once per `execute()` Call

**Decision**: Resolve sibling map once at workflow execution start, thread to all steps.

**Rationale**:
- `createActionContext()` is called per step. Resolving the map there would add per-step disk I/O.
- The sibling map is static for the duration of a workflow run — repos don't appear or disappear mid-execution.
- Cache is scoped to a single `execute()` invocation, not global state.

## Implementation Patterns

### Existing Pattern: `ExecutionOptions` Extension

The `ExecutionOptions` interface (at `packages/workflow-engine/src/types/execution.ts:106`) is the standard way to pass execution-scoped configuration. It already contains `cwd`, `env`, `startPhase`, etc. Adding `siblingWorkdirs` follows this pattern exactly.

### Existing Pattern: `ActionContext` Read-Only Properties

`ActionContext` (at `packages/workflow-engine/src/types/action.ts:103`) provides step-scoped read-only data. All fields are set in `createActionContext()` and consumed by action handlers. Adding `siblingWorkdirs` is consistent — action handlers in Phase 2 will read it.

### Existing Pattern: Orchestrator Config → Worker Threading

The orchestrator already threads config values through `CliSpawnOptions` → `CliSpawner` → `AgentLauncher`. For example, `credentialRole` flows through `buildLaunchCredentials()` at each spawn site. The sibling map follows the same pattern.

### Path Resolution Pattern

Use `fs.realpathSync.native()` wrapped in try/catch for path normalization. This resolves symlinks (common in Docker/devcontainer mounts). Fallback to `path.resolve()` for non-existent paths (which are then filtered out by existence check).

## Key Sources

| Source | Location | Relevance |
|--------|----------|-----------|
| ActionContext type | `packages/workflow-engine/src/types/action.ts:103-127` | Target for `siblingWorkdirs` field |
| ExecutionOptions type | `packages/workflow-engine/src/types/execution.ts:106-119` | Target for optional `siblingWorkdirs` field |
| Executor createActionContext | `packages/workflow-engine/src/executor/index.ts:575-611` | Wiring point for threading sibling map |
| getRepoWorkdir | `packages/config/src/repos.ts:33-38` | Path construction utility |
| WorkspaceConfig schema | `packages/config/src/workspace-schema.ts:10-16` | Repos array structure |
| tryLoadWorkspaceConfig | `packages/config/src/loader.ts:13-40` | Config loading for orchestrator |
| findWorkspaceConfigPath | `packages/config/src/loader.ts:72-92` | Config path discovery |
| Orchestrator config loading | `packages/orchestrator/src/config/loader.ts:110-125` | Existing workspace config usage |
| PhaseLoop execution | `packages/orchestrator/src/worker/phase-loop.ts:185-196` | Call site for sibling injection |
| CliSpawner | `packages/orchestrator/src/worker/cli-spawner.ts:39-70` | Threading to launch request |
| RepoCheckout | `packages/orchestrator/src/worker/repo-checkout.ts:33-74` | Primary checkout path derivation |
| Multi-repo example config | `packages/generacy/examples/config-multi-repo.yaml` | Reference config format |
| Upstream plan doc | `tetrad-development/docs/multi-repo-workflows-plan.md` | Full multi-repo strategy |
