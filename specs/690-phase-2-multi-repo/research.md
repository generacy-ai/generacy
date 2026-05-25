# Research: Generic `phase:after` Extension Hook

## Technology Decisions

### Pattern: Callback Array vs Event Emitter vs Plugin Registry

**Decision**: Simple callback array on `PhaseLoopDeps`.

**Alternatives Considered**:

1. **EventEmitter (existing pattern)**: The codebase already has `JobEventEmitter` — a fire-and-forget callback. However, `phase:after` handlers need to **block** the phase on failure and run **sequentially** with fail-fast semantics. EventEmitter's fire-and-forget model can't do this.

2. **Plugin registry with lifecycle hooks**: Over-engineered for a single hook point. Would require a registry class, plugin interface, registration API, and lifecycle management. The spec explicitly defers `phase:before` and `on-failure` hooks — no need to build infrastructure for them now.

3. **Callback array on deps (chosen)**: Minimal, testable, zero new abstractions. `PhaseLoopDeps` already uses constructor DI for all its dependencies. Adding `phaseAfterHandlers?: PhaseAfterHandler[]` follows the exact same pattern. Handlers are just async functions — no class hierarchy, no registration ceremony.

**Rationale**: The simplest solution that satisfies the requirements. If more hook points are needed later, the pattern is trivially extensible (add another array).

### Context Shape: Full vs Minimal

**Decision**: Full `WorkerContext` + phase name + `commitResult`.

From Q1 clarification: this is an internal extension point, not a public plugin API. The first consumer (Issue E / #691 multi-repo fan-out) needs `workdir`, `config`, `item`, `signal`, and `prUrl`. Restricting the surface and re-widening it every time a new handler appears is more churn than starting open.

`commitResult` is included explicitly (Q2 clarification) because:
- `hasChanges` lets handlers short-circuit when no primary-repo changes occurred
- `prUrl` from `commitPushAndEnsurePr()` is semantically "the PR URL as of this commit step" — the value handlers actually want

### Error Semantics: Fail-Fast vs Run-All

**Decision**: Fail-fast (stop on first error).

From Q3 clarification: handlers execute sequentially and may produce side effects (commits, pushes, PR creation). Running subsequent handlers after one has thrown produces confusing partial state. Run-all aggregation makes sense for independent validators, not for side-effecting handlers like fan-out.

### Insertion Point: After onPhaseComplete, Before Gate

**Decision**: Insert after `labelManager.onPhaseComplete()`, before gate check.

The spec requires handlers to run "after commit/push and before gate check." Placing them after `onPhaseComplete()` (which updates phase labels) ensures handlers see consistent label state. Placing them before gates means handler failures prevent gate evaluation — a handler that throws effectively fails the phase.

### Increment Exclusion

**Decision**: Handlers do NOT run at implement increment boundaries.

The spec explicitly states: "Handlers do not run at implement increment boundaries (WIP commits) — only at the normal post-phase commit in the main flow." The normal completion path (line ~340 in phase-loop.ts) is the only insertion point. The partial increment path (line ~271) and retry path (line ~307) are excluded.

## Implementation Pattern

```typescript
// In phase-loop.ts, after onPhaseComplete() and before gate check:
for (const handler of deps.phaseAfterHandlers ?? []) {
  await handler({ ...context, phase, commitResult });
}
```

This is the entire runtime change. The `for...of` on an empty array is a no-op — zero overhead when no handlers are registered.

## Key Sources

- `packages/orchestrator/src/worker/phase-loop.ts` — Main loop (551 lines)
- `packages/orchestrator/src/worker/types.ts` — Type definitions (286 lines)
- `packages/orchestrator/src/worker/claude-cli-worker.ts` — PhaseLoopDeps construction (590 lines)
- `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts` — Existing tests (699 lines)
