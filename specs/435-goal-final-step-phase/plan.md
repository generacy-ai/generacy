# Implementation Plan: Phase 3 Cleanup — Delete PHASE_TO_COMMAND and Claude Flags from Orchestrator

**Feature**: Remove dead Claude-specific code from orchestrator after Wave 3 plugin migration
**Branch**: `435-goal-final-step-phase`
**Status**: Complete

## Summary

Pure dead-code cleanup of the `@generacy-ai/orchestrator` package. After Wave 3's Phase 3a/3b/3c migrations moved Claude spawn logic into `@generacy-ai/generacy-plugin-claude-code`, the orchestrator retains duplicate constants and deprecated helpers that are now dead code. This issue removes them and refactors remaining callers to use inline logic or plugin imports.

## Technical Context

- **Language**: TypeScript (ESM)
- **Package**: `packages/orchestrator`
- **Plugin package**: `packages/generacy-plugin-claude-code` (already a workspace dependency)
- **Build**: `tsc`
- **Test**: `vitest`

## Changes Overview

### 1. Delete `PHASE_TO_COMMAND` from `types.ts`

**File**: `packages/orchestrator/src/worker/types.ts` (lines 70-80)

Delete the constant and its JSDoc comment:
```typescript
// DELETE lines 70-80
export const PHASE_TO_COMMAND: Record<WorkflowPhase, string | null> = { ... };
```

### 2. Update `phase-loop.ts` — remove `PHASE_TO_COMMAND` usage

**File**: `packages/orchestrator/src/worker/phase-loop.ts`

- **Line 2**: Remove `PHASE_TO_COMMAND` from import
- **Line 147**: Replace `PHASE_TO_COMMAND[phase] === null` → `phase === 'validate'`
- **Line 217**: Replace `PHASE_TO_COMMAND[phase] !== null` → `phase !== 'validate'`

These are semantically identical: `PHASE_TO_COMMAND` maps `validate` to `null` and all other phases to a string. The inline check is clearer and removes the coupling.

### 3. Update `cli-spawner.ts` — inline command derivation

**File**: `packages/orchestrator/src/worker/cli-spawner.ts`

- **Line 9**: Delete `PHASE_TO_COMMAND` import
- **Line 42**: Replace `const command = PHASE_TO_COMMAND[phase]` → `const command = \`/\${phase}\``
- **Line 43**: Delete the null guard (`if (command === null)`) — `spawnPhase` is only called for non-validate phases (phase-loop handles this routing). Add a runtime assert for safety.
- **Lines 33-35**: Update JSDoc to remove `PHASE_TO_COMMAND` reference

The command derivation is trivial (`/${phase}`) and doesn't warrant a lookup table.

### 4. Delete `PTY_WRAPPER` from `conversation-spawner.ts`

**File**: `packages/orchestrator/src/conversation/conversation-spawner.ts`

- **Lines 40-57**: Delete `PTY_WRAPPER` constant and its JSDoc
- **Line 1**: Add import: `import { PTY_WRAPPER } from '@generacy-ai/generacy-plugin-claude-code'`
- The orchestrator already depends on this package (`"@generacy-ai/generacy-plugin-claude-code": "workspace:^"`)

### 5. Delete deprecated `spawn()` method and `ConversationSpawnOptions`

**File**: `packages/orchestrator/src/conversation/conversation-spawner.ts`

- **Lines 6-13**: Delete `ConversationSpawnOptions` interface (only used by deprecated `spawn()`)
- **Lines 107-136**: Delete deprecated `spawn()` method

`ConversationManager` only uses `spawnTurn()` (line 132). No other caller references `spawn()`.

### 6. Remove `PHASE_TO_COMMAND` from package re-exports

**File**: `packages/orchestrator/src/worker/index.ts`

- **Line 17**: Remove `PHASE_TO_COMMAND,` from the re-export block

### 7. Verify plugin exports `PTY_WRAPPER`

**File**: `packages/generacy-plugin-claude-code` package

Verify that `PTY_WRAPPER` is exported from the package's public API (not just internal). If not, add it to the package's barrel export.

### 8. Update tests

- **`cli-spawner.test.ts`** / **`cli-spawner-snapshot.test.ts`**: Update any tests referencing `PHASE_TO_COMMAND`; update snapshots for command derivation change
- **`conversation-spawner.test.ts`**: Remove tests for deprecated `spawn()` method; verify `spawnTurn()` tests still pass with imported `PTY_WRAPPER`
- **`phase-loop.test.ts`**: Verify validate-phase routing tests still pass with inline check

### 9. Verification

Run grep-based checks per spec acceptance criteria:
- `grep -rn "PHASE_TO_COMMAND" packages/orchestrator/src/` → 0 results
- `grep -rn '"claude"' packages/orchestrator/src/` → only `'claude'` as process command in `cli-spawner.ts:75` and `pr-feedback-handler.ts:305` (legitimate process invocations, not plugin-ID refs)

## Project Structure

```
packages/orchestrator/src/
├── worker/
│   ├── types.ts                    # DELETE PHASE_TO_COMMAND constant
│   ├── cli-spawner.ts              # REMOVE import, inline command derivation
│   ├── phase-loop.ts               # REPLACE PHASE_TO_COMMAND checks with phase === 'validate'
│   ├── index.ts                    # REMOVE PHASE_TO_COMMAND re-export
│   ├── pr-feedback-handler.ts      # NO CHANGES (all code is active)
│   └── __tests__/
│       ├── cli-spawner.test.ts     # UPDATE tests
│       ├── cli-spawner-snapshot.test.ts  # UPDATE snapshots
│       └── phase-loop.test.ts      # VERIFY passing
├── conversation/
│   ├── conversation-spawner.ts     # DELETE PTY_WRAPPER, deprecated spawn(), import from plugin
│   └── __tests__/
│       └── conversation-spawner.test.ts  # UPDATE tests
└── ...
```

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Inline `phase === 'validate'` instead of new constant | The check is self-explanatory; a constant adds indirection for a single comparison |
| Inline `/${phase}` instead of importing from plugin | The pattern is trivial; importing would add coupling for no benefit |
| Import `PTY_WRAPPER` from plugin | Complex multi-line Python script; duplication-avoidance outweighs coupling |
| Delete deprecated `spawn()` | Zero callers; `spawnTurn()` is the sole code path |
| Keep `'claude'` process command in cli-spawner/pr-feedback-handler | These are legitimate CLI invocations, not hardcoded plugin-ID references |

## Risk Assessment

- **Low risk**: All changes are dead-code removal or mechanical refactoring
- **No functional changes**: Process spawning behavior is unchanged
- **Test coverage**: Existing tests validate spawn args and phase routing
- **Rollback**: Simple git revert if any issue arises

## Out of Scope

- Root-level `claude-code-invoker.ts` deletion (Wave 4)
- Migrating `PhaseLoop` to use `AgentLauncher` (future work — PhaseLoop still uses `CliSpawner` directly, which is the active spawn path)
- Migrating `PrFeedbackHandler` to use `AgentLauncher`
- Phase 3d shell validators
