# Feature Specification: Migrate SubprocessAgency to AgentLauncher

**Branch**: `429-goal-phase-4a-spawn` | **Date**: 2026-04-12 | **Status**: Draft

## Summary

Route `SubprocessAgency` through `AgentLauncher` + `GenericSubprocessPlugin` so it transparently picks up uid/gid / credentials plumbing in the follow-on credentials work. This is Phase 4a of the [spawn refactor](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-4--migrate-generic-subprocess-paths).

## Scope

- Migrate [packages/generacy/src/agency/subprocess.ts:90](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/agency/subprocess.ts#L90) from direct `child_process.spawn` to `agentLauncher.launch({ pluginId: "generic-subprocess", intent: { kind: "generic-subprocess", command, args, stdioProfile: "interactive" }, cwd, env, signal })`.
- **Preserve `SubprocessAgencyOptions` public interface exactly** — it is re-exported from [@generacy-ai/generacy index.ts:11,21](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/index.ts#L11) and consumed transitively by `cluster-base` / `cluster-microservices`. Any signature change is a breaking release.
- Preserve current stdio (`['pipe', 'pipe', 'pipe']`) semantics by passing `stdioProfile: "interactive"` in the intent — the `"interactive"` profile maps to `['pipe', 'pipe', 'pipe']` (established in #425).
- Preserve env merging semantics exactly: set `intent.env = undefined` and `request.env = this.env`, relying on AgentLauncher's 3-layer merge (`process.env <- pluginEnv <- callerEnv`) to produce byte-identical `{ ...process.env, ...this.env }`.
- Inject `AgentLauncher` into `SubprocessAgency` via constructor or module-level factory, whichever matches the existing package conventions.
- **Fallback**: When `agentLauncher` is not provided (undefined), fall back to direct `child_process.spawn` for backward compatibility. If the launcher is provided and `launch()` throws, let the error propagate (do not silently fall back).
- **Error handling**: `ChildProcessHandle.exitPromise` must reject with spawn errors (e.g., ENOENT) rather than resolving with code 1, to preserve the current immediate error rejection behavior. Both ProcessFactory implementations should wire `child.on('error', (err) => reject(err))`. This coordinates with #426.
- **Exit signal**: Loss of exit signal information from `ChildProcessHandle.exitPromise` (resolves `number | null` vs `(code, signal)`) is acceptable — SubprocessAgency logs but does not branch on signal.

## Acceptance criteria

- `SubprocessAgencyOptions` type signature unchanged (a type-level test is encouraged if the test framework supports it).
- Snapshot test comparing composed `{command, args, env, cwd, stdio}` before/after — byte-identical.
- All existing `SubprocessAgency` unit tests pass unchanged.
- A new integration test exercising `SubprocessAgency.connect()` through the launcher with a short-lived real subprocess.
- Spawn errors (e.g., ENOENT) produce immediate error rejection, not a connect timeout.

## Out of scope

- Migrating `cli-utils.ts` (separate Wave 2 issue, Phase 4b).
- Any new features on `SubprocessAgency`.
- Any changes to its public API surface.
- Extending `ChildProcessHandle.exitPromise` to include signal info (acceptable loss).

## Dependencies

- Depends on Wave 1 Agent Launcher issue (`GenericSubprocessPlugin`).
- Depends on #426 for ProcessFactory spawn error propagation.
- Parallel-safe with the other Wave 2 issues.

## References

- Parent tracking: #423

## User Stories

### US1: Platform developer migrating SubprocessAgency

**As a** platform developer,
**I want** `SubprocessAgency` to route through `AgentLauncher` + `GenericSubprocessPlugin`,
**So that** it transparently picks up uid/gid and credentials plumbing from the launcher infrastructure.

**Acceptance Criteria**:
- [ ] SubprocessAgency uses AgentLauncher when available
- [ ] Falls back to direct spawn when no launcher is provided
- [ ] All existing tests pass unchanged
- [ ] Stdio, env, and error handling behavior is preserved

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Migrate spawn call to `agentLauncher.launch()` with `pluginId: "generic-subprocess"` | P1 | |
| FR-002 | Pass `stdioProfile: "interactive"` in intent for `['pipe', 'pipe', 'pipe']` | P1 | Reuses profile from #425 |
| FR-003 | Env merge: `intent.env = undefined`, `request.env = this.env` | P1 | Byte-identical via 3-layer merge |
| FR-004 | Fallback to direct spawn when `agentLauncher` is undefined | P1 | Backward compat only |
| FR-005 | Launcher errors propagate (no silent fallback) | P1 | |
| FR-006 | ProcessFactory `exitPromise` rejects on spawn errors | P1 | Coordinates with #426 |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Existing test pass rate | 100% | All SubprocessAgency tests pass unchanged |
| SC-002 | Snapshot parity | Byte-identical | `{command, args, env, cwd, stdio}` snapshot comparison |
| SC-003 | Spawn error behavior | Immediate rejection | ENOENT test produces immediate error, not timeout |

## Assumptions

- The `"interactive"` stdio profile (`['pipe', 'pipe', 'pipe']`) is available in ProcessFactory (established in #425).
- `GenericSubprocessPlugin` supports or will support a `stdioProfile` field in `GenericSubprocessIntent`.
- ProcessFactory spawn error propagation (#426) is available or will be implemented concurrently.

---

*Generated by speckit*
