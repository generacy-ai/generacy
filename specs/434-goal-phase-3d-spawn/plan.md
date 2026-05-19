# Implementation Plan: Migrate cli-spawner shell validators to AgentLauncher

**Feature**: Phase 3d — Route `runValidatePhase` and `runPreValidateInstall` through `AgentLauncher` + `GenericSubprocessPlugin`
**Branch**: `434-goal-phase-3d-spawn`
**Status**: Complete

## Summary

Replace the two direct `processFactory.spawn('sh', ['-c', cmd])` calls in `CliSpawner` with `agentLauncher.launch({ intent: { kind: 'shell', command } })`, extracting `handle.process` for the existing `manageProcess()` lifecycle management. This follows the same pattern established by the SubprocessAgency migration (#429) and eliminates direct process factory usage for shell validator spawn sites.

## Technical Context

**Language/Version**: TypeScript 5.x (Node.js)
**Primary Dependencies**: `AgentLauncher`, `GenericSubprocessPlugin` (Wave 1 — already implemented)
**Testing**: Vitest — unit tests with mocked ProcessFactory, snapshot tests with `RecordingProcessFactory`
**Target Platform**: Linux (orchestrator service)
**Project Type**: Monorepo package (`packages/orchestrator`)

## Constitution Check

No constitution file found — no gates to enforce.

## Project Structure

### Documentation (this feature)

```text
specs/434-goal-phase-3d-spawn/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Technology decisions
├── data-model.md        # Type changes
└── quickstart.md        # Testing guide
```

### Source Code (files to modify)

```text
packages/orchestrator/src/
├── worker/
│   ├── cli-spawner.ts                    # PRIMARY: Add agentLauncher param, migrate 2 spawn sites
│   └── __tests__/
│       └── cli-spawner.test.ts           # UPDATE: Wire mock AgentLauncher, add snapshot tests
├── launcher/
│   ├── agent-launcher.ts                 # READ-ONLY: Reference for launch() API
│   ├── generic-subprocess-plugin.ts      # READ-ONLY: Reference for shell intent
│   ├── types.ts                          # READ-ONLY: ShellIntent, LaunchRequest, LaunchHandle
│   └── __tests__/
│       ├── agent-launcher.test.ts        # READ-ONLY: Reference for testing patterns
│       └── generic-subprocess-plugin.test.ts  # READ-ONLY: Reference for snapshot patterns
└── index.ts                              # NO CHANGE: AgentLauncher already exported
```

### Key Changes by File

| File | Change | Lines Affected |
|------|--------|----------------|
| `cli-spawner.ts` | Add optional `agentLauncher` constructor param | Constructor (~line 30) |
| `cli-spawner.ts` | Replace `processFactory.spawn` in `runValidatePhase` | Lines 95-108 |
| `cli-spawner.ts` | Replace `processFactory.spawn` in `runPreValidateInstall` | Lines 120-135 |
| `cli-spawner.test.ts` | Wire mock `AgentLauncher` into test setup | Test helpers |
| `cli-spawner.test.ts` | Add snapshot tests for composed commands | New section |
| `cli-spawner.test.ts` | Existing validate/install tests pass unchanged | Lines 307-412 |

## Design Decisions

### D1: Optional `agentLauncher` parameter

Accept `AgentLauncher` as an optional constructor parameter (matching SubprocessAgency pattern). When provided, `runValidatePhase` and `runPreValidateInstall` route through it. When absent, fall back to direct `processFactory.spawn`. This preserves backward compatibility for any callers that don't yet inject an `AgentLauncher`.

### D2: Empty env passthrough

Current code passes `env: {}` to `ProcessFactory`. After migration, passing `env: {}` (or omitting it) in the `LaunchRequest` yields the same effective env: `process.env` only. The `GenericSubprocessPlugin` shell kind passes `intent.env` (undefined) as plugin env, so the 3-layer merge `{ ...process.env, ...undefined, ...{} }` = `process.env`.

### D3: Signal propagation via LaunchRequest

Pass `signal` in the `LaunchRequest` so `AgentLauncher` forwards it to the factory. The existing `manageProcess()` also listens to the signal for its own abort handling — both paths are compatible since `manageProcess()` calls `gracefulKill()` on abort, which is idempotent.

### D4: Snapshot tests with RecordingProcessFactory

Use the existing `RecordingProcessFactory` + `normalizeSpawnRecords()` infrastructure from the launcher test utilities to create snapshot tests that verify the composed `sh -c` commands are byte-identical to the pre-refactor baseline.

## Migration Pattern

```typescript
// BEFORE (direct ProcessFactory):
const child = this.processFactory.spawn('sh', ['-c', validateCommand], {
  cwd: checkoutPath,
  env: {} as Record<string, string>,
});

// AFTER (AgentLauncher routing):
const handle = this.agentLauncher.launch({
  intent: { kind: 'shell', command: validateCommand },
  cwd: checkoutPath,
});
const child = handle.process;

// manageProcess() call stays identical — it only needs ChildProcessHandle
```

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Env merging behavior differs | Low | High | Snapshot tests verify byte-identical env; empty env passthrough analyzed |
| manageProcess() incompatibility | Very Low | High | LaunchHandle.process is same ChildProcessHandle type |
| Signal double-handling | Low | Medium | Both paths (launcher signal + manageProcess abort) are idempotent |
| Test mock wiring complexity | Low | Low | Follow established SubprocessAgency test pattern |

## Implementation Order

1. **Modify `CliSpawner` constructor** — add optional `agentLauncher` param
2. **Migrate `runValidatePhase`** — route through launcher, extract `handle.process`
3. **Migrate `runPreValidateInstall`** — same pattern
4. **Update test setup** — wire mock AgentLauncher
5. **Add snapshot tests** — verify byte-identical command composition
6. **Run existing tests** — confirm no regressions
