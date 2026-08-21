# Contract: `GATE_MAPPING` `ci` entry

Location: `packages/orchestrator/src/worker/phase-resolver.ts`

## Change

Add one entry to `GATE_MAPPING`:

```ts
'ci': { phase: 'validate', resumeFrom: 'validate' }
```

## Behavior guarantees

1. `PhaseResolver.resolveStartPhase(labels, 'continue', ...)` with `completed:ci` present resolves to `validate` via the normal mapping (not the `resolveFromProcess` fallback). *(SC-005)*
2. `ci ∈ HUMAN_GATE_SUFFIXES` after this change, since the set derives from `Object.keys(GATE_MAPPING)`. *(SC-005)*
3. Resume re-runs `validate` to re-verify CI is green on the new head. *(US3, Q2→A)*
4. No terminal short-circuit applies to `ci`: `waiting-for:ci` is raised during `validate` before `completed:validate` exists, so the `completed:validate` + `completed:implementation-review` no-op precondition cannot hold.

## Non-changes
- `getEffectiveGateMapping()`'s `ciMergeGateEnabled` override (relocating `implementation-review` to `validate`) is unchanged.
- `WORKFLOW_GATE_MAPPING` is unchanged.
- Flag-OFF resolution is byte-identical except for the newly resolvable `completed:ci` path (which had no defined mapping before).

## Test hooks
- `phase-resolver.ci-gate.test.ts`: asserts `completed:ci` → `validate` resume and `HUMAN_GATE_SUFFIXES.has('ci')`.
