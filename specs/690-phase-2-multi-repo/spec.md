# Feature Specification: **Phase 2 of [multi-repo workflow support](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/multi-repo-workflows-plan.md) — Generic `phase:after` Extension Hook**

**Branch**: `690-phase-2-multi-repo` | **Date**: 2026-05-22 | **Status**: Draft

## Summary

**Phase 2 of [multi-repo workflow support](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/multi-repo-workflows-plan.md).** Infrastructure for post-phase extensions.

Post-phase work today is hardcoded into [packages/orchestrator/src/worker/phase-loop.ts](packages/orchestrator/src/worker/phase-loop.ts) (commit/push, label updates, gate checks). The one existing post-phase extension — `EpicPostTasks` — is also hardcoded and only runs at workflow completion. There's no clean way to register additional post-phase behavior without editing the loop directly.

This issue adds a generic `phase:after` callback list to `PhaseLoopDeps` so future post-phase work (starting with multi-repo fan-out in Issue E) can register cleanly.

## Scope

- Add `phaseAfterHandlers?: PhaseAfterHandler[]` to `PhaseLoopDeps` (where `PhaseAfterHandler` is an async function receiving `PhaseAfterContext`).
- Invoke handlers in [phase-loop.ts](packages/orchestrator/src/worker/phase-loop.ts) after `commitPushAndEnsurePr()` and `PHASES_REQUIRING_CHANGES` check, but **before** the gate check. Handlers run sequentially in registration order; **fail-fast** on first error (skip remaining handlers, block the phase, prevent gate check).
- `PhaseAfterContext` exposes the full `WorkerContext` (workdir, config, item, signal, prUrl, github client, etc.) plus the phase name and `commitResult: { prUrl?: string; hasChanges: boolean }`.
- Pass through the abort signal so handlers can be interrupted.
- Add the registration point in the orchestrator's worker bootstrap (wherever `PhaseLoopDeps` is constructed today).
- Handlers do **not** run at implement increment boundaries (WIP commits) — only at the normal post-phase commit in the main flow.

## Optional refactor (defer if scope creeps)

Migrate `EpicPostTasks` to register as a `phase:after` handler instead of being called directly. Doesn't have to land in this issue — Issue E only needs the new hook to exist.

## Out of scope

- The first handler (multi-repo fan-out) — that's Issue E.
- `phase:before` hooks, `on-failure` hooks, or YAML-level expression of these.
- Removing the existing internal event emitter; this hook is for orchestrator-level handlers that need to potentially block/fail the phase, which the fire-and-forget event emitter can't do.

## Acceptance

- Unit test: register a no-op handler, verify it runs after commit/push and before gate check.
- Unit test: register a handler that throws; verify the phase fails and the gate is not checked.
- No regression in existing single-repo workflows (no handlers registered → behavior identical to today).

## Dependencies

None directly, but most useful once Issue E lands.

## Blocks

Issue E (the fan-out handler registers through this hook).

## User Stories

### US1: Extensible Post-Phase Behavior

**As a** workflow developer,
**I want** to register callbacks that run after each phase completes (post-commit, pre-gate),
**So that** I can add cross-cutting post-phase behavior (like multi-repo fan-out) without modifying the phase loop directly.

**Acceptance Criteria**:
- [ ] `PhaseLoopDeps` accepts an optional `phaseAfterHandlers` array
- [ ] Registered handlers execute sequentially after commit/push, before gate check
- [ ] Handler failure (throw) blocks the phase and prevents gate evaluation
- [ ] Zero handlers registered produces identical behavior to current code

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `PhaseAfterHandler` type: async function receiving `PhaseAfterContext` (full `WorkerContext` + phase name + `commitResult`) | P1 | Context shape per Q1/Q2 clarification |
| FR-002 | Add `phaseAfterHandlers?: PhaseAfterHandler[]` to `PhaseLoopDeps` | P1 | Optional, defaults to `[]` |
| FR-003 | Invoke handlers after `commitPushAndEnsurePr()` + no-changes check + `labelManager.onPhaseComplete()`, before gate check | P1 | Normal flow only, not implement increments |
| FR-004 | Fail-fast: first handler that throws stops execution, blocks phase, prevents gate check | P1 | Per Q3 clarification |
| FR-005 | Pass abort signal via `WorkerContext.signal` in the handler context | P1 | Handlers can check `signal.aborted` |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Existing tests pass | 100% | No regressions in phase-loop tests |
| SC-002 | Handler invocation verified | Pass | Unit tests for no-op and throwing handlers |

## Assumptions

- The `WorkerContext` type is stable and sufficient for future handler needs (internal API, not public)
- Handler authors are responsible for their own error handling beyond the fail-fast boundary

## Out of Scope

- Multi-repo fan-out handler implementation (Issue E)
- `phase:before` or `on-failure` hooks
- YAML-level hook expression
- EpicPostTasks migration (optional, defer)

---

*Generated by speckit*
