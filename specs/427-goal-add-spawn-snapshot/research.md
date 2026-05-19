# Research: Spawn Snapshot Test Harness

## Technology Decisions

### 1. Snapshot Strategy: Vitest Built-in Snapshots

**Decision**: Use Vitest's native `toMatchSnapshot()` / `toMatchInlineSnapshot()` rather than custom file-based fixtures.

**Rationale**:
- Vitest 3.2.4 already includes `@vitest/snapshot` — zero additional dependencies
- `toMatchInlineSnapshot()` keeps expected values co-located with the test for easy review
- `toMatchSnapshot()` auto-generates `.snap` files when first run, auto-diffs on subsequent runs
- `vitest --update` provides a standard workflow for intentional updates during Wave 2-3 migrations
- Matches the team's existing Vitest testing patterns

**Alternatives Considered**:
| Alternative | Why Rejected |
|-------------|-------------|
| Custom JSON fixture files | Extra file management overhead; Vitest snapshots handle this natively |
| `jest-serializer-path` style serializers | Over-engineering — no path-dependent values in spawn records |
| Deep-equality assertion only | Loses the "visual diff" benefit that makes snapshot failures immediately readable |

### 2. Recording Pattern: ProcessFactory Wrapper

**Decision**: Implement `RecordingProcessFactory` as a standalone `ProcessFactory` implementation that records calls and returns dummy handles.

**Rationale**:
- `ProcessFactory` is already designed for dependency injection — `CliSpawner` accepts it via constructor
- Recording at the `ProcessFactory` boundary captures exactly what the spawner passes, which is the correct abstraction level for parity testing
- The existing test suite already uses ad-hoc mocks of `ProcessFactory` (`vi.fn()` + cast), proving the DI pattern works
- A dedicated class is more reusable than per-test `vi.fn()` setups and provides typed access to `calls[]`

**Alternatives Considered**:
| Alternative | Why Rejected |
|-------------|-------------|
| Spy on `child_process.spawn` | Tests implementation details (the real spawn call happens inside `ProcessFactory`); also couples to Node internals |
| Proxy / wrapper around real `ProcessFactory` | Unnecessary complexity — we don't need real process execution for argument capture |
| `vi.fn()` per test (current pattern) | Works but not reusable; each test must reconstruct the mock; no typed `SpawnRecord` |

### 3. Dummy ChildProcessHandle: EventEmitter-based

**Decision**: Return `EventEmitter` instances for `stdout`/`stderr` streams, matching the existing mock pattern in `cli-spawner.test.ts`.

**Rationale**:
- The existing test suite (lines 27-55 of `cli-spawner.test.ts`) already validates this approach works with `CliSpawner.manageProcess()`
- `EventEmitter` satisfies the `NodeJS.ReadableStream` type assertion via `as unknown as NodeJS.ReadableStream`
- The dummy handle's `exitPromise` resolves immediately with code 0, keeping snapshot tests fast and deterministic
- No need for real stream plumbing — snapshot tests don't exercise output parsing

### 4. No Custom Assertion Function

**Decision**: Provide a `normalizeSpawnRecords()` utility instead of a full `assertSpawnSnapshot()` wrapper.

**Rationale**:
- Vitest's `expect(...).toMatchSnapshot()` is already the standard assertion pattern
- A custom assertion wrapper would hide the Vitest API from test authors, making tests harder to read
- The only normalization needed is env key sorting (per Q3 clarification decision)
- Test authors call `normalizeSpawnRecords(factory.calls)` then use any Vitest matcher they prefer

### 5. Test Scope: spawnPhase Only

**Decision**: Write baseline snapshot tests for `spawnPhase()` only. Do not snapshot `runValidatePhase()` or `runPreValidateInstall()`.

**Rationale**:
- The spec explicitly scopes to `spawnPhase` (the Claude CLI spawn path)
- `runValidatePhase()` and `runPreValidateInstall()` spawn `sh -c` commands — these are user-supplied commands, not composition that Wave 2-3 would change
- Additional snapshot coverage can be added in future waves if needed

## Implementation Patterns

### Barrel Export Pattern

The `test-utils/index.ts` barrel export follows the existing codebase convention of re-exporting from a directory index. This makes imports clean:

```typescript
import { RecordingProcessFactory, normalizeSpawnRecords } from '../test-utils/index.js';
```

### Test File Naming

`cli-spawner-snapshot.test.ts` is separate from `cli-spawner.test.ts` to keep snapshot tests isolated from behavioral/unit tests. This makes it clear which tests are "golden master" baselines vs. which test specific behaviors.

## Key References

- Parent tracking: [#423](https://github.com/generacy-ai/generacy/issues/423)
- Spec: `specs/427-goal-add-spawn-snapshot/spec.md`
- Spawn refactor plan: [testing strategy](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#testing-strategy)
- Vitest snapshot docs: https://vitest.dev/guide/snapshot.html
