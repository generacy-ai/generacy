# Contract: `ciMergeGateEnabled` flag, gate relocation, GATE_MAPPING rework

## Flag threading (mirror of `reviewPhaseEnabled`)

| Layer | File | Change |
|---|---|---|
| Env | `packages/orchestrator/src/config/loader.ts` | Read `WORKER_CI_MERGE_GATE_ENABLED` (+ prefixed) and `WORKER_CI_WAIT_TIMEOUT_MS`; coerce `'true'`/`'1'` → boolean; parse timeout to int. |
| Schema | `packages/orchestrator/src/worker/config.ts` | `ciMergeGateEnabled: z.boolean().default(false)`; `ciWaitTimeoutMs: z.number().int().min(30_000).default(900_000)`. |
| Resolver | `packages/orchestrator/src/worker/phase-resolver.ts` | Thread `ciMergeGateEnabled` through `resolveStartPhase` → `resolveFromContinue` / `resolveFromProcess` → `getEffectiveGateMapping`. |
| Worker | `packages/orchestrator/src/worker/claude-cli-worker.ts` | Pass `this.config.ciMergeGateEnabled` into `phaseResolver.resolveStartPhase(...)`. |
| Loop | `packages/orchestrator/src/worker/phase-loop.ts` | Consume flag for the CI-wait block, `on-ci-green` gate eval, and terminal no-op resume. |

## Gate definition

`GateDefinitionSchema.condition` enum gains `'on-ci-green'`.

Default `implementation-review` gate placement:

```ts
// ciMergeGateEnabled === true
{ phase: 'validate', gateLabel: 'waiting-for:implementation-review', condition: 'on-ci-green' }

// ciMergeGateEnabled === false  (BYTE-IDENTICAL TO TODAY)
// speckit-feature:
{ phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'always' }
// speckit-bugfix:
{ phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'on-request' }
```

## `on-ci-green` gate evaluation (phase-loop gate-check loop)

For a `validate`-phase gate with `condition: 'on-ci-green'`:
- `gateActive` iff the CI readiness verdict computed at validate completion is `green`.
- If validate passed but CI is `pending` → the CI-wait block already ran; a `timeout` short-circuits earlier into `waiting-for:ci` + `agent:paused` (the gate loop is not reached).
- If CI is `not-passed` → readiness blocked; the `implementation-review` gate is NOT raised.

## GATE_MAPPING rework (FR-006)

```ts
'implementation-review':
  ciMergeGateEnabled
    ? { phase: 'validate', resumeFrom: <terminal no-op> }
    : { phase: 'implement', resumeFrom: 'validate' }
```

### Terminal no-op resume (research Decision 5)
When the flag is ON and the satisfied gate is `implementation-review`, resume MUST re-run neither `validate` nor `implement`:
- `resolveStartPhase` returns the last phase (`validate`) as the target.
- `executeLoopInner` short-circuits to `{ completed: true }` at loop entry when re-entering at `validate` on a `continue` command whose labels include both `completed:validate` and `completed:implementation-review`.
- The gate answer + `completed:validate` is the merge-eligible surface cockpit / `cockpit_merge` consume (FR-007). Cockpit already treats `completed:validate` as terminal.

## Invariants
- Flag OFF: resolver output, gates default, and observable run behavior byte-identical to pre-change (SC-006).
- Flag ON: `implementation-review` never fires on `implement` completion; only on `validate` completion once CI is `green` (FR-005).
