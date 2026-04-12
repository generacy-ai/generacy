# Feature Specification: Spawn Snapshot Test Harness

Add a spawn snapshot test harness to mechanically verify behavioral parity across Waves 2-3.

**Branch**: `427-goal-add-spawn-snapshot` | **Date**: 2026-04-12 | **Status**: Draft

## Summary

Add a test utility that captures and snapshots every `ProcessFactory.spawn()` call so that Waves 2-3 of the spawn refactor can mechanically prove they produce identical CLI invocations. The harness records `{command, args, env, cwd, stdio}` for each spawn and compares against stored fixture files. One baseline snapshot test for `cli-spawner.spawnPhase` establishes the "before" state that subsequent migrations must match byte-for-byte.

## Scope

- Add a test utility under `packages/orchestrator/src/test-utils/` that provides:
  - A **mock `ProcessFactory`** implementation (`RecordingProcessFactory`) that records every spawn call's `{command, args, env, cwd, stdio, uid?, gid?}` and returns a configurable dummy `ChildProcessHandle`.
  - A **snapshot assertion helper** for comparing captured spawn records against Vitest inline snapshots or fixture files.
- Write one example snapshot test against the **current** direct-spawn behavior at `cli-spawner.ts:spawnPhase` — this establishes the "before" baseline that Wave 3 migrations must match.
- Document the harness in a JSDoc comment block explaining how Waves 2-3 issues should use it.

## User Stories

### US1: Developer verifying spawn parity during refactor

**As a** developer working on Waves 2-3 of the spawn refactor,
**I want** a test harness that captures the exact spawn arguments produced by `spawnPhase`,
**So that** I can mechanically verify that my refactored code produces identical CLI invocations without manual inspection.

**Acceptance Criteria**:
- [ ] Can import `RecordingProcessFactory` from any orchestrator/worker test file
- [ ] Captured spawn records include command, args, env, cwd, and stdio config
- [ ] Can assert captured records against Vitest snapshots with a single helper call

### US2: CI catching spawn regressions

**As a** CI pipeline,
**I want** snapshot tests that fail when spawn arguments change unexpectedly,
**So that** regressions in CLI argument composition, env merging, or stdio selection are caught before merge.

**Acceptance Criteria**:
- [ ] Snapshot test for `cli-spawner.spawnPhase` passes on current `develop` branch
- [ ] Test fails if any spawn argument (flag, env var, stdio mode) changes
- [ ] Failure message clearly shows the diff between expected and actual spawn records

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `RecordingProcessFactory` implements `ProcessFactory` interface and records all spawn calls | P1 | Must capture: `command`, `args`, `env`, `cwd`, `stdio` |
| FR-002 | `RecordingProcessFactory` returns a configurable dummy `ChildProcessHandle` with controllable exit code and streams | P1 | Needs working stdout/stderr EventEmitters for `OutputCapture` compatibility |
| FR-003 | Provide `getSpawnRecords()` method to retrieve captured spawn call data | P1 | Returns array of `SpawnRecord` objects |
| FR-004 | Provide `assertSpawnSnapshot()` helper or documented pattern for Vitest snapshot comparison | P2 | Should sanitize non-deterministic fields (timestamps, PIDs) before comparison |
| FR-005 | Baseline snapshot test for `cli-spawner.spawnPhase` captures: executable (`claude`), flags (`-p`, `--output-format stream-json`, `--dangerously-skip-permissions`, `--verbose`), phase command args, env overrides, cwd, and stdio config | P1 | Test against current behavior on `develop` |
| FR-006 | Baseline test covers both the basic spawn case and the `--resume` session variant | P2 | Two snapshot assertions in one test file |
| FR-007 | JSDoc comment block documents harness usage for Waves 2-3 developers | P1 | Include import path, basic usage example, and snapshot update instructions |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Harness importable from orchestrator tests | Import resolves without errors | `import { RecordingProcessFactory } from '../test-utils/spawn-snapshot'` works |
| SC-002 | Baseline snapshot test passes | All assertions green | `pnpm --filter orchestrator test` exits 0 |
| SC-003 | Snapshot catches spawn argument changes | Test fails on any arg mutation | Manually alter a flag in `spawnPhase` and verify test fails |
| SC-004 | Snapshot detail coverage | All required fields captured | Snapshot includes executable path, all CLI flags, env overrides, cwd, stdio config |

## Technical Context

### Existing Interfaces

- **`ProcessFactory`** (`worker/types.ts:269-275`): `spawn(command, args, {cwd, env, signal}) → ChildProcessHandle`
- **`ChildProcessHandle`** (`worker/types.ts:280-293`): stdin/stdout/stderr streams, pid, kill(), exitPromise
- **`CliSpawnOptions`** (`worker/types.ts:179-192`): prompt, cwd, env, timeoutMs, signal, resumeSessionId

### Existing Test Patterns

- Tests use **Vitest** with globals enabled (`describe`, `it`, `expect`)
- `cli-spawner.test.ts` already mocks `ProcessFactory` with `vi.fn()` — the new harness formalizes this pattern
- Mock logger pattern: `{ info: () => {}, warn: () => {}, ... }`
- Mock `ChildProcessHandle` uses `EventEmitter` for stdout/stderr with configurable exit codes

### File Locations

- New utility: `packages/orchestrator/src/test-utils/spawn-snapshot.ts`
- New test: `packages/orchestrator/src/worker/__tests__/cli-spawner.snapshot.test.ts`
- Existing spawner: `packages/orchestrator/src/worker/cli-spawner.ts`
- Existing types: `packages/orchestrator/src/worker/types.ts`

## Assumptions

- Wave 0 interfaces (`ProcessFactory`, `ChildProcessHandle`) are stable and will not change during this work
- Vitest snapshot format is sufficient for spawn record comparison (no need for custom serializers)
- Environment variables can be deterministically sorted for stable snapshot comparison

## Out of Scope

- Migrating any existing tests to use the harness (happens in each wave's issues)
- Snapshot tests for non-spawn behavior (output parsing, SSE emission, etc.)
- Integration tests that actually spawn Claude CLI processes
- Changes to the `ProcessFactory` interface itself

## Dependencies

- Depends on Wave 0 (interfaces must be finalized)
- Parallel-safe with other Wave 1 issues

## References

- Parent tracking: [#423](https://github.com/generacy-ai/generacy/issues/423)
- Plan: [Testing strategy section](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#testing-strategy)
- GitHub issue: [#427](https://github.com/generacy-ai/generacy/issues/427)

---

*Generated by speckit*
