# Data Model

This change introduces **no** persisted or wire-format data. The only new state is a single per-iteration boolean local to `PhaseLoop.executeLoopInner`.

## New state

### `hasBaseMergedThisCycle`

- **Type**: `boolean`
- **Scope**: block-local to the body of `for (let i = startIndex; i < sequence.length; i++)` inside `PhaseLoop.executeLoopInner`.
- **Initial value**: `false` (re-initialized on every for-loop iteration, including retry re-entries via `i--; continue;`).
- **Set to `true` by**: the `runPreImplementBaseMerge` and `runPreValidateBaseMerge` call sites, after a successful (undefined return) merge outcome.
- **Read by**: the guard in front of each `runPre*BaseMerge` call — the call is skipped when the flag is already `true`.

### Invariant

At most one `performBaseMerge` invocation per for-loop iteration. Retry loops (`i--; continue;`) count as new iterations and therefore new merges — one merge per retry attempt (Q3-A).

## No changes to persisted schemas

- **No changes** to `WorkerConfigSchema` (`packages/orchestrator/src/worker/config.ts`).
- **No changes** to `GateDefinitionSchema`, `PhaseTimeoutOverridesSchema`, or any workflow-config surface.
- **No changes** to `PhaseResult`, `PhaseLoopResult`, `PhaseLoopStatus`, `BaseMergeResult`, `BaseMergeOptions`, or `BaseMergeRunner`.
- **No changes** to relay-event payloads, Fastify route bodies, or gh CLI wire calls.
- **No changes** to label vocabulary — `waiting-for:merge-conflicts` / `completed:merge-conflicts` are used exactly as today; the conflict-pause path itself is untouched (both call sites continue to route conflicts through `runPrePhaseBaseMerge`'s existing pause return).
- **No changes** to `errorEvidence` shape, `stageComment` render pipeline, or `postFailureAlert` marker format.

## No new types

The change adds no exports and no new interfaces. It is a control-flow refactor of an existing method.
