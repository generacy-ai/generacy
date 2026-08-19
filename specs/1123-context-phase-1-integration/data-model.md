# Data Model: Review/remediate foundations wired end-to-end (#1123)

This issue introduces **no new production types**. It relies on types delivered by #1121/#1122 and on existing orchestrator types. This document catalogs the entities the tests and contract reference, and pins the **loop-control outcome** shape the contract documents for P2/P3.

## Entities consumed (delivered by #1121)

### `WorkflowPhase` (extended)
`packages/orchestrator/src/worker/types.ts:9`

```ts
// After #1121:
type WorkflowPhase =
  | 'specify' | 'clarify' | 'plan' | 'tasks'
  | 'implement' | 'review' | 'remediate' | 'validate';
```

- `review` — linear, entered after `implement`.
- `remediate` — **off-sequence**; entered only via loop control; always backtracks to `review`.

### Companion enumerations (must enumerate every phase — FR-006)

| Companion | Location | Kind | Enforced by |
|---|---|---|---|
| `PHASE_TO_STAGE` | `types.ts:80` | total `Record<WorkflowPhase, StageType>` | `tsc` |
| `PHASE_SEQUENCE` / `WORKFLOW_PHASE_SEQUENCES` | `types.ts:50,58` | arrays | FR-006 audit |
| `WorkflowPhaseSchema` | `pause-context.ts:28` | runtime `z.enum` | FR-006 audit |
| `GateDefinitionSchema.phase` | `config.ts` | runtime `z.enum` | FR-006 audit |
| `GATE_MAPPING` | `phase-resolver.ts:9` | keyed by **gate label** | **exempt** (not total over phase) |

### `StageType` (unchanged)
`types.ts:75` — `'specification' | 'planning' | 'implementation'`. Both new phases map to `implementation` (PD-1 / #1121 FR-002). No new member.

## Entities consumed (delivered by #1122)

### Per-workflow config (in `@generacy-ai/config` `OrchestratorSettings`)
`packages/config/src/template-schema.ts` (`OrchestratorSettingsSchema`, ~`:77-100`)

```ts
// Added by #1122 (shape owned by #1122; illustrative):
interface OrchestratorSettings {
  // …existing: validateCommand, preValidateCommand, agents…
  maxRemediations?: /* per-workflow: feature 3, bugfix 2 */;
  reviewProfile?:   /* per-workflow charter selector (opaque to #1123) */;
}
```

- **Read surface (Q4=B)**: via the config object the worker already holds, resolved by a `worker/config.ts` resolver (#1122 Q4). **Not** a new `WorkerConfig` field; **not** an injected loop dependency.
- #1123 asserts only that the values are **observable inside the loop** and **differ per workflow** (feature=3, bugfix=2). The `reviewProfile` semantics are opaque to this issue (spec Assumption §90).

## Loop-control outcome (contract shape — PD-5 / FR-007)

The seam-of-record documented in `contracts/remediate-review-seam.md`. Illustrative shape P2/P3 build against (not shipped as production code here):

```ts
/**
 * Loop-control outcome a phase step returns to steer the phase loop.
 * Independent of any review verdict (Q2=C).
 */
type LoopControlOutcome =
  | { next?: undefined }              // default: advance to next linear phase
  | { next: WorkflowPhase };          // off-sequence jump

// Contract invariants:
//   review  (needs work) → { next: 'remediate' }
//   remediate (complete) → { next: 'review' }   // ALWAYS backtrack, never advance
```

**Invariants** (asserted behaviorally by FR-003, pinned by FR-007):
1. `remediate` is reachable **only** via `{ next: 'remediate' }` — never by linear index advance, never directly by a review verdict, never by a gate/label.
2. `remediate` on completion returns `{ next: 'review' }` — always a delta-scoped re-review, never the next linear phase (validate/merge).
3. The `{ next }` outcome is the single seam for all three future remediate entry points (review verdict, validate failure, external PR feedback).

## Entities used as-is (existing)

### `PauseContext`
`pause-context.ts:37-43`

```ts
interface PauseContext { phase: WorkflowPhase; writtenAt: string; issueRef: string; }
```

- Carries the interrupted phase in-band; resume resolves to `ctx.phase` directly (Q3=A). Round-trips `review`/`remediate` once companion #3 (`WorkflowPhaseSchema`) includes them.

### `PhaseLoopDeps`, `WorkerContext`, `WorkerConfig`, `PhaseResult`
`phase-loop.ts:62-100`, `types.ts:448-…`, `config.ts`, `types.ts` — used unchanged as the test injection surface (harness pattern: `__tests__/phase-loop.test.ts:42-116`).

## Validation rules

- No new Zod schemas ship here. FR-006's audit **validates** that the two existing runtime schemas (`WorkflowPhaseSchema`, `GateDefinitionSchema.phase`) stay set-equal to the `WorkflowPhase` keyset.
