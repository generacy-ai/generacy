# Implementation Plan: Phase 1 Multi-Repo Workflow Support

**Feature**: Sibling-repo discovery and `ActionContext` widening
**Branch**: `687-phase-1-multi-repo`
**Status**: Complete

## Summary

Widen the workflow engine's execution context to carry a map of sibling repositories cloned alongside the primary repo. This is a foundational, non-user-visible change that enables future phases to fan out GitHub operations across multiple repos.

Three packages are modified:
1. **workflow-engine** — Add `siblingWorkdirs` field to `ExecutionOptions` and `ActionContext` types; thread the value through the executor.
2. **orchestrator** — Resolve the sibling map from workspace config at the call site and inject it into the workflow engine via `ExecutionOptions`.
3. **config** — Add a new `resolveSiblingWorkdirs()` helper that builds the `Record<string, string>` map from `WorkspaceConfig.repos`.

## Technical Context

- **Language**: TypeScript (ESM, strict mode)
- **Runtime**: Node >= 22
- **Monorepo**: pnpm workspaces
- **Relevant packages**: `packages/workflow-engine`, `packages/orchestrator`, `packages/config`
- **Build**: `pnpm build` per package; `pnpm -r build` for all
- **Test**: Vitest (`pnpm test` per package)
- **Key dependencies**: `zod` (schema validation), `@generacy-ai/config` (workspace config loading)

## Architecture Decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| AD-1 | Caller-injection pattern (Q2 answer: B) | `workflow-engine` stays decoupled from `@generacy-ai/config`. Orchestrator already loads workspace config; it resolves the sibling map and passes it via `ExecutionOptions.siblingWorkdirs`. |
| AD-2 | Dynamic base path from `path.dirname(workdir)` (Q3 answer: A) | Hardcoding `/workspaces` breaks non-cluster deployments. Parent of primary workdir is the correct peer directory. |
| AD-3 | Path-match primary identification, empty fallback (Q1 answer: B) | Compare resolved paths via `fs.realpath`. If primary can't be identified, return `siblingWorkdirs: {}` and log warning. Fail closed — never include primary in sibling map. |
| AD-4 | Cache sibling map once per `execute()` (Q4 answer: A) | Resolved once at workflow start, threaded to every `createActionContext()` call. No per-step disk I/O. |

## Project Structure

```
packages/config/
  src/
    repos.ts                          # ADD: resolveSiblingWorkdirs()
    __tests__/
      repos.test.ts                   # ADD: tests for resolveSiblingWorkdirs()

packages/workflow-engine/
  src/
    types/
      action.ts                       # MODIFY: add siblingWorkdirs to ActionContext
      execution.ts                    # MODIFY: add siblingWorkdirs to ExecutionOptions
    executor/
      index.ts                        # MODIFY: thread siblingWorkdirs through execute() → createActionContext()
    __tests__/
      sibling-workdirs.test.ts        # ADD: integration test for sibling map threading

packages/orchestrator/
  src/
    worker/
      phase-loop.ts                   # MODIFY: resolve sibling map, pass via CliSpawnOptions
      cli-spawner.ts                  # MODIFY: thread siblingWorkdirs to AgentLauncher
      types.ts                        # MODIFY: add siblingWorkdirs to CliSpawnOptions
      claude-cli-worker.ts            # MODIFY: resolve sibling map from workspace config
    config/
      loader.ts                       # MODIFY: expose loaded WorkspaceConfig for sibling resolution
```

## Implementation Steps

### Step 1: Add `resolveSiblingWorkdirs()` to `packages/config`

**File**: `packages/config/src/repos.ts`

New exported function:
```typescript
export function resolveSiblingWorkdirs(
  config: WorkspaceConfig,
  primaryWorkdir: string,
  basePath?: string,
): Record<string, string> { ... }
```

- Derives `basePath` from `path.dirname(path.resolve(primaryWorkdir))` if not provided
- Iterates `config.repos`, builds `getRepoWorkdir(name, basePath)` for each
- Normalizes paths with `fs.realpathSync.native()` (falls back to `path.resolve()` if path doesn't exist)
- Excludes the entry whose resolved path matches `primaryWorkdir`
- Skips repos whose paths don't exist on disk (logs info)
- If no repo matches `primaryWorkdir`, returns `{}` and logs warning
- Returns `Record<string, string>` (repo name → absolute path)

**Tests**: `packages/config/src/__tests__/repos.test.ts` — add tests using temp directories.

### Step 2: Add `siblingWorkdirs` to workflow-engine types

**File**: `packages/workflow-engine/src/types/execution.ts`
```typescript
export interface ExecutionOptions {
  // ... existing fields ...
  /** Sibling repository working directories (repo name → absolute path) */
  siblingWorkdirs?: Record<string, string>;
}
```

**File**: `packages/workflow-engine/src/types/action.ts`
```typescript
export interface ActionContext {
  // ... existing fields ...
  /** Sibling repository working directories (repo name → absolute path) */
  siblingWorkdirs: Record<string, string>;
}
```

Note: `ActionContext.siblingWorkdirs` is non-optional (defaults to `{}`).

### Step 3: Thread through executor

**File**: `packages/workflow-engine/src/executor/index.ts`

In `execute()`: cache `const siblingWorkdirs = options.siblingWorkdirs ?? {};` once.

In `createActionContext()`: add `siblingWorkdirs` to the returned object. The cached value is threaded via closure or parameter.

### Step 4: Wire orchestrator to resolve and inject sibling map

**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`

After `checkoutPath` is resolved (line ~215), resolve the sibling map:
```typescript
const workspaceConfig = tryLoadWorkspaceConfig(findWorkspaceConfigPath(checkoutPath));
const siblingWorkdirs = workspaceConfig
  ? resolveSiblingWorkdirs(workspaceConfig, checkoutPath)
  : {};
```

Thread `siblingWorkdirs` through `CliSpawnOptions` → `CliSpawner.spawnPhase()` → `AgentLauncher.launch()`.

**Files modified**:
- `types.ts` — add `siblingWorkdirs?: Record<string, string>` to `CliSpawnOptions`
- `cli-spawner.ts` — forward from options to launch request
- `phase-loop.ts` — pass `siblingWorkdirs` in `CliSpawnOptions`

### Step 5: Tests

1. **Unit tests** (`packages/config/src/__tests__/repos.test.ts`):
   - Primary repo excluded from sibling map
   - Non-existent sibling paths skipped
   - Empty repos list → empty map
   - No matching primary → empty map with warning
   - Custom base path override

2. **Type-level test** (`packages/workflow-engine`):
   - Verify `ActionContext.siblingWorkdirs` is populated
   - Verify `ExecutionOptions.siblingWorkdirs` is optional

3. **Integration test** (`packages/workflow-engine/src/__tests__/sibling-workdirs.test.ts`):
   - Executor threads sibling map from `ExecutionOptions` to `ActionContext`
   - Default `{}` when not provided

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| `fs.realpathSync` throws on broken symlinks | Wrap in try/catch, fall back to `path.resolve()` |
| Orchestrator doesn't have workspace config in all environments | Graceful fallback: missing config → `siblingWorkdirs: {}` |
| Performance: `realpathSync` on many repos | Called once per workflow run (AD-4), negligible |
| Breaking change to `ActionContext` type | `siblingWorkdirs` defaults to `{}` in executor; no existing consumers break |

## Verification

- `pnpm -r build` — all packages compile
- `pnpm -r test` — all tests pass
- Manual: run workflow in `tetrad-development` workspace with multi-repo config, verify `siblingWorkdirs` is populated via debug logging
- Manual: run workflow without `.generacy/config.yaml`, verify `siblingWorkdirs: {}` and identical behavior to today
