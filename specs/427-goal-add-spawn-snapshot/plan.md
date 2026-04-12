# Implementation Plan: Spawn Snapshot Test Harness

**Feature**: Add a spawn snapshot test harness to mechanically verify behavioral parity across Waves 2-3
**Branch**: `427-goal-add-spawn-snapshot`
**Status**: Complete

## Summary

Create a `RecordingProcessFactory` test utility that implements `ProcessFactory` and records every `spawn()` call's arguments. Pair it with a snapshot assertion helper that normalizes recorded calls and compares them against Vitest inline/file snapshots. Write one baseline snapshot test for `cli-spawner.spawnPhase` that captures the current spawn composition — this becomes the "before" reference that Wave 2-3 migrations must match.

## Technical Context

**Language/Version**: TypeScript (strict mode, ESM)
**Framework**: Vitest 3.2.4 with `@vitest/snapshot`
**Primary Dependencies**: `packages/orchestrator` (types, CliSpawner, OutputCapture)
**Testing**: Vitest — uses `toMatchInlineSnapshot()` / `toMatchSnapshot()` for snapshot assertions
**Target Platform**: Node.js
**Constraints**:
- Must not modify `ProcessFactory` interface (out of scope per clarification Q1 option C)
- Must not migrate existing tests (Wave 2-3 work)
- Harness must be importable from any `packages/orchestrator` test file

## Constitution Check

No `.specify/memory/constitution.md` found — no gates apply.

## Design Decisions (from Clarifications)

### Q1: stdio field — Option A (remove from capture)
`stdio` is an implementation detail of each `ProcessFactory` implementation, not a spawn argument the caller controls. The `RecordingProcessFactory` only sees what the spawner passes: `{command, args, options: {cwd, env, signal?}}`. Capturing stdio would require extending the interface (out of scope) or faking a value (misleading). The snapshot tests verify the *spawner's* behavior, not factory internals.

### Q2: Environment scope — Option A (override env only)
The spawner passes `options.env` (the override set) to `ProcessFactory.spawn`. The merge with `process.env` happens inside each factory implementation. Snapshot-testing the spawner's output is the correct boundary — factory merge logic should be tested in factory-specific tests.

### Q3: Sanitization — Option A (sort env keys only)
The `RecordingProcessFactory` controls all recorded values (PID is fixed, no timestamps in spawn records). The only source of non-determinism is env key ordering. Sorting env keys alphabetically in the snapshot helper is sufficient. A full sanitization framework can be added when a real need arises in Waves 2-3.

## Project Structure

### New Files

```text
packages/orchestrator/src/test-utils/
├── recording-process-factory.ts   # RecordingProcessFactory + SpawnRecord type
├── spawn-snapshot.ts              # assertSpawnSnapshot() helper
└── index.ts                       # Public barrel export

packages/orchestrator/src/worker/__tests__/
└── cli-spawner-snapshot.test.ts   # Baseline snapshot test for spawnPhase
```

### Existing Files (read-only reference)

```text
packages/orchestrator/src/worker/
├── types.ts            # ProcessFactory, ChildProcessHandle, CliSpawnOptions
├── cli-spawner.ts      # spawnPhase() — the function under test
└── output-capture.ts   # OutputCapture — needed for spawnPhase call

packages/orchestrator/src/worker/__tests__/
└── cli-spawner.test.ts # Existing tests — pattern reference (not modified)
```

## Detailed Design

### 1. `SpawnRecord` Type

```typescript
export interface SpawnRecord {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
```

Captures exactly what the spawner passes to `ProcessFactory.spawn()`. No `stdio`, `uid`, or `gid` fields — these are not part of the `ProcessFactory` interface (per Q1 decision).

### 2. `RecordingProcessFactory`

Implements `ProcessFactory`. On each `spawn()` call:
1. Pushes a `SpawnRecord` to an internal `calls: SpawnRecord[]` array
2. Returns a dummy `ChildProcessHandle` that:
   - Has `stdin: null`, `stdout`/`stderr` as `EventEmitter` instances (matching existing mock pattern)
   - Has `pid: 12345` (deterministic)
   - Has `kill()` returning `true`
   - Has `exitPromise` resolving to `0` after a microtask (configurable exit code)

Follows the same mock pattern already used in `cli-spawner.test.ts` (lines 27-55) but extracts it into a reusable utility.

### 3. `assertSpawnSnapshot()` Helper

```typescript
export function normalizeSpawnRecords(records: SpawnRecord[]): SpawnRecord[] {
  return records.map(record => ({
    ...record,
    env: Object.fromEntries(
      Object.entries(record.env).sort(([a], [b]) => a.localeCompare(b))
    ),
  }));
}
```

Normalizes records by sorting env keys alphabetically (per Q3 decision). Tests use Vitest's built-in `toMatchSnapshot()` or `toMatchInlineSnapshot()` on the normalized output — no custom assertion function needed.

### 4. Baseline Snapshot Test

Tests `CliSpawner.spawnPhase()` for each relevant scenario:
- **Basic spawn** (no session resume): captures `claude` command, `-p --output-format stream-json --dangerously-skip-permissions --verbose`, phase command + prompt, cwd, env overrides
- **Session resume**: captures additional `--resume <sessionId>` args

Uses `RecordingProcessFactory` to capture calls, then asserts against Vitest snapshots.

The test creates a `CliSpawner` with the `RecordingProcessFactory`, calls `spawnPhase()` with known inputs, and snapshots the `factory.calls` array. The dummy `ChildProcessHandle` emits no stdout (empty output capture) and exits with code 0 immediately — the test only cares about *what was spawned*, not the process lifecycle.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Snapshot breaks on unrelated CLI flag changes | Low | Low | Snapshot is intentionally tight — any flag change should be caught and reviewed |
| `EventEmitter`-based mock doesn't satisfy all stream consumers | Low | Medium | Matches existing pattern in `cli-spawner.test.ts`; if issues arise, extend mock |
| Test-utils path not resolvable from other packages | Low | Medium | Use relative imports within `packages/orchestrator`; cross-package export can be added later if needed |

## Verification Plan

1. `pnpm --filter orchestrator test` — all existing tests pass (no regressions)
2. New snapshot test passes with `pnpm --filter orchestrator test -- cli-spawner-snapshot`
3. Manually break a spawn argument in `cli-spawner.ts` → snapshot test fails (validates detection)
4. `RecordingProcessFactory` is importable from `packages/orchestrator/src/test-utils`
