# Feature Specification: Migrate SubprocessAgency to AgentLauncher

**Branch**: `429-goal-phase-4a-spawn` | **Date**: 2026-04-12 | **Status**: Draft
**Issue**: [#429](https://github.com/generacy-ai/generacy/issues/429) | **Parent**: [#423](https://github.com/generacy-ai/generacy/issues/423)

## Summary

Route `SubprocessAgency` through `AgentLauncher` + `GenericSubprocessPlugin` instead of calling `child_process.spawn` directly. This is Phase 4a of the spawn refactor — it consolidates all process-spawning behind the launcher abstraction so that follow-on credentials work (uid/gid plumbing) applies uniformly without touching each call-site.

## Scope

- Replace the direct `spawn()` call at `packages/generacy/src/agency/subprocess.ts:90` with `agentLauncher.launch()` using a `generic-subprocess` intent.
- Inject `AgentLauncher` into `SubprocessAgency` via constructor (adding an optional parameter to `SubprocessAgencyOptions`).
- Preserve the `SubprocessAgencyOptions` public type signature exactly — the new `agentLauncher` field must be optional so existing consumers compile without changes.
- Preserve current stdio (`['pipe', 'pipe', 'pipe']`) and env merging (`{ ...process.env, ...this.env }`) semantics byte-identically.
- Update `createAgencyConnection` factory in `packages/generacy/src/agency/index.ts` to accept and forward an `AgentLauncher` instance.

## User Stories

### US1: Transparent Credentials Plumbing

**As a** platform engineer working on subprocess security,
**I want** all process spawning in `SubprocessAgency` to go through the `AgentLauncher` abstraction,
**So that** future uid/gid and credentials injection applies uniformly without modifying each spawn call-site.

**Acceptance Criteria**:
- [ ] `SubprocessAgency.connect()` delegates to `AgentLauncher.launch()` instead of `child_process.spawn()`
- [ ] When no `AgentLauncher` is provided, `SubprocessAgency` falls back to direct `spawn()` for backwards compatibility
- [ ] The `LaunchHandle.process` (`ChildProcessHandle`) is used in place of the raw `ChildProcess` for stdin/stdout/stderr and event handling

### US2: Zero Breaking Changes for Downstream Consumers

**As a** maintainer of `cluster-base` / `cluster-microservices`,
**I want** the `SubprocessAgencyOptions` type to remain unchanged,
**So that** I don't need to update any downstream code for this internal refactor.

**Acceptance Criteria**:
- [ ] `SubprocessAgencyOptions` exported type signature is identical before and after
- [ ] All existing unit tests pass without modification
- [ ] Snapshot test proves spawn parameters are byte-identical

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Replace `spawn()` call in `SubprocessAgency.connect()` with `agentLauncher.launch({ intent: { kind: 'generic-subprocess', command, args }, cwd, env, signal })` | P1 | Line 90 of subprocess.ts |
| FR-002 | Add optional `agentLauncher?: AgentLauncher` to `SubprocessAgencyOptions` | P1 | Must be optional to avoid breaking downstream |
| FR-003 | When `agentLauncher` is present, use `LaunchHandle.process` for stdin/stdout/stderr/events | P1 | Map `ChildProcessHandle` events to existing handlers |
| FR-004 | When `agentLauncher` is absent, fall back to current direct `spawn()` behavior | P1 | Backwards compatibility path |
| FR-005 | Env merging must produce identical result: `{ ...process.env, ...this.env }` | P1 | AgentLauncher does its own 3-layer merge; pass `this.env` as caller env |
| FR-006 | Stdio must remain `['pipe', 'pipe', 'pipe']` — the default ProcessFactory profile | P1 | AgentLauncher selects 'default' profile which uses pipe stdio |
| FR-007 | Wire `AgentLauncher` through `createAgencyConnection()` factory | P2 | In `agency/index.ts` |
| FR-008 | `disconnect()` must correctly kill the process via `LaunchHandle.process.kill()` | P1 | `ChildProcessHandle.kill()` has same signature |

## Technical Notes

### Key Interfaces (from `packages/orchestrator/src/launcher/types.ts`)

- **`AgentLauncher.launch(request: LaunchRequest): LaunchHandle`** — the target API
- **`LaunchRequest`**: `{ intent: LaunchIntent, cwd: string, env?: Record<string, string>, signal?: AbortSignal }`
- **`LaunchHandle`**: `{ process: ChildProcessHandle, outputParser: OutputParser, metadata: {...} }`
- **`ChildProcessHandle`**: `{ stdin, stdout, stderr, pid, kill(), exitPromise }`
- **`GenericSubprocessIntent`**: `{ kind: 'generic-subprocess', command: string, args: string[], env?: Record<string, string> }`

### Mapping `ChildProcess` → `ChildProcessHandle`

| ChildProcess | ChildProcessHandle | Migration Note |
|---|---|---|
| `.stdin` (Writable) | `.stdin` (WritableStream) | Compatible |
| `.stdout` (Readable) | `.stdout` (ReadableStream) | Compatible |
| `.stderr` (Readable) | `.stderr` (ReadableStream) | Compatible |
| `.on('error', ...)` | N/A — errors surface via `exitPromise` rejection | Must adapt error handling |
| `.on('exit', ...)` | `.exitPromise` | Replace event listener with promise |
| `.kill()` | `.kill()` | Same signature |
| `.pid` | `.pid` | Same |

### Env Merging

AgentLauncher performs a 3-layer merge: `process.env < plugin env < caller env`. Since `GenericSubprocessPlugin.buildLaunch()` passes through the intent's env, and the caller passes `this.env`, the result is equivalent to `{ ...process.env, ...this.env }`. The intent should NOT include env to avoid double-merging — pass env only at the `LaunchRequest` level.

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Type compatibility | `SubprocessAgencyOptions` signature unchanged | Type-level test or `tsc --noEmit` comparison |
| SC-002 | Spawn parameter parity | `{command, args, env, cwd, stdio}` byte-identical | Snapshot test comparing before/after |
| SC-003 | Existing test suite | 100% pass rate | All existing `SubprocessAgency` tests pass unchanged |
| SC-004 | Integration coverage | New test exercises full path | Integration test: `SubprocessAgency.connect()` → launcher → real subprocess |

## Assumptions

- `AgentLauncher` and `GenericSubprocessPlugin` are available from `@generacy-ai/orchestrator` (Wave 1 dependency is merged).
- The `default` ProcessFactory profile produces pipe stdio, matching current behavior.
- `ChildProcessHandle` streams are compatible with the existing `Buffer`-based data handlers.

## Out of Scope

- Migrating `cli-utils.ts` (Phase 4b, separate issue).
- Any new features on `SubprocessAgency`.
- Any changes to the `SubprocessAgencyOptions` public API surface.
- Removing the direct `spawn()` fallback path (can be done in a later cleanup).

## Dependencies

- **Wave 1**: AgentLauncher + GenericSubprocessPlugin must be merged and available.
- **Parallel-safe**: With other Wave 2 issues (Phase 4b, etc.).

## References

- [Spawn refactor plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-4--migrate-generic-subprocess-paths)
- Parent tracking: #423
- Source: `packages/generacy/src/agency/subprocess.ts`
- Launcher: `packages/orchestrator/src/launcher/agent-launcher.ts`
- Plugin: `packages/orchestrator/src/launcher/generic-subprocess-plugin.ts`
- Types: `packages/orchestrator/src/launcher/types.ts`

---

*Generated by speckit*
