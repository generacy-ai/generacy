# Research: Migrate cli-spawner shell validators to AgentLauncher

## Technology Decisions

### AgentLauncher integration via optional constructor injection

**Decision**: Accept `AgentLauncher` as an optional constructor parameter in `CliSpawner`, with fallback to direct `processFactory.spawn` when absent.

**Rationale**: This matches the pattern established by SubprocessAgency migration (#429, commit `033ddc5`). Optional injection avoids breaking existing call sites that don't yet provide an AgentLauncher.

**Alternative considered**: Make `AgentLauncher` required — rejected because `CliSpawner` has other spawn sites (`spawnPhase`) not yet migrated, and forcing all callers to provide AgentLauncher would be premature.

### Shell intent kind for validators

**Decision**: Use `intent: { kind: 'shell', command }` rather than `{ kind: 'generic-subprocess', command: 'sh', args: ['-c', cmd] }`.

**Rationale**: `GenericSubprocessPlugin` already supports `shell` as a first-class intent kind that wraps the command in `sh -c` — this is the semantic intent of these spawn sites. Using `shell` kind is more readable and lets the plugin handle the `sh -c` wrapping.

### Env handling: omit rather than pass empty

**Decision**: Omit `env` from `LaunchRequest` (or pass `{}`) — both produce identical behavior.

**Rationale**: Current code passes `env: {} as Record<string, string>`. The factory merges `{ ...process.env, ...{} }` = `process.env`. After migration, AgentLauncher merges `{ ...process.env, ...pluginEnv, ...requestEnv }`. Plugin `shell` kind passes `intent.env` (undefined) as plugin env. Whether `requestEnv` is `{}` or `undefined`, the result is `process.env` only.

### Snapshot testing approach

**Decision**: Use existing `RecordingProcessFactory` + `normalizeSpawnRecords()` for deterministic snapshot tests.

**Rationale**: This infrastructure already exists in `packages/orchestrator/src/launcher/__tests__/test-utils.ts` and is proven in the launcher test suite. Reusing it ensures consistency and avoids custom snapshot helpers.

## Implementation Patterns

### Prior migration reference: SubprocessAgency (#429)

The SubprocessAgency migration demonstrates the exact pattern:

1. Accept optional `AgentLauncher` in constructor
2. Check `if (this.agentLauncher)` before spawning
3. Call `this.agentLauncher.launch(request)` to get `LaunchHandle`
4. Extract `handle.process` as `ChildProcessHandle`
5. Continue with existing lifecycle management using the handle

### Process lifecycle invariant

`manageProcess()` is the lifecycle manager — it handles timeout, abort signals, and exit code evaluation. It operates on `ChildProcessHandle` regardless of how the process was spawned. No modification needed.

## Key Sources

| Source | Purpose |
|--------|---------|
| SubprocessAgency migration (#429, commit `033ddc5`) | Pattern reference for AgentLauncher integration |
| `generic-subprocess-plugin.ts` | Shell intent → `sh -c` wrapping implementation |
| `agent-launcher.test.ts` | Env merging precedence verification |
| Spawn refactor plan (tetrad-development repo) | Phase 3d placement and dependency analysis |
